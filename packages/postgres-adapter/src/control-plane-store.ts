import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AcceptedMutation,
  ControlPlaneStore,
  CreateInstanceCommand,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  Page,
  ProjectView,
  QuotaView,
} from '@private-cloud/application';
import type { InstanceCreateRequestedV1 } from '@private-cloud/contracts';
import { allocateIpv4, DomainError } from '@private-cloud/domain';
import { sql } from 'kysely';
import type { PostgresClient } from './database.js';

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function json<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

type DnsTuple =
  | [string]
  | [string, string]
  | [string, string, string]
  | [string, string, string, string];
type SshTuple =
  | []
  | [string]
  | [string, string]
  | [string, string, string]
  | [string, string, string, string]
  | [string, string, string, string, string];

function dnsTuple(values: readonly string[]): DnsTuple {
  if (values.length < 1 || values.length > 4) {
    throw new DomainError('VALIDATION_FAILED', 'The configured DNS server list is invalid.');
  }
  return [...values] as DnsTuple;
}

function sshTuple(values: readonly string[]): SshTuple {
  if (values.length > 5) {
    throw new DomainError('VALIDATION_FAILED', 'At most five SSH public keys are accepted.');
  }
  return [...values] as SshTuple;
}

function traceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  public constructor(private readonly db: PostgresClient) {}

  public async acceptCreate(
    command: CreateInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.db.transaction().execute(async (transaction) => {
      const idempotencyScope = [
        command.actor.subject,
        command.projectId,
        'create_instance',
        command.idempotencyKey,
      ].join(':');
      // Serialize first acceptance so concurrent duplicates deterministically replay one result.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyScope}, 0))`.execute(
        transaction,
      );
      const previous = await transaction
        .selectFrom('control.idempotency_records')
        .select(['request_hash', 'response'])
        .where('actor_id', '=', command.actor.subject)
        .where('project_id', '=', command.projectId)
        .where('operation_type', '=', 'create_instance')
        .where('idempotency_key', '=', command.idempotencyKey)
        .executeTakeFirst();
      if (previous) {
        if (previous.request_hash !== requestHash) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key is already bound to different input.',
          );
        }
        return { ...json<AcceptedMutation>(previous.response), replayed: true };
      }

      const project = await transaction
        .selectFrom('control.projects')
        .select(['id', 'enabled'])
        .where('id', '=', command.projectId)
        .executeTakeFirst();
      if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.');
      if (!project.enabled) throw new DomainError('PROJECT_ACCESS_DENIED', 'Project is disabled.');

      const image = await transaction
        .selectFrom('control.images as image')
        .innerJoin(
          'control.provider_profiles as profile',
          'profile.id',
          'image.provider_profile_id',
        )
        .select([
          'image.id',
          'image.enabled',
          'profile.id as provider_profile_id',
          'profile.state',
          'profile.network_id as provider_network_id',
        ])
        .where('image.id', '=', command.imageId)
        .executeTakeFirst();
      const flavor = await transaction
        .selectFrom('control.flavors')
        .selectAll()
        .where('id', '=', command.flavorId)
        .where('enabled', '=', true)
        .executeTakeFirst();
      const network = await transaction
        .selectFrom('control.networks')
        .selectAll()
        .where('id', '=', command.networkId)
        .where('enabled', '=', true)
        .executeTakeFirst();
      const quota = await transaction
        .selectFrom('control.quotas')
        .selectAll()
        .where('project_id', '=', command.projectId)
        .executeTakeFirst();
      if (!image?.enabled || !flavor || !network || !quota) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'The selected project catalog entry is unavailable.',
        );
      }
      if (image.state !== 'active')
        throw new DomainError('PROFILE_DISABLED', 'Provider profile is disabled.');
      if (image.provider_network_id !== network.id) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'The selected image and network do not share a provider profile.',
        );
      }

      const usage = await transaction
        .selectFrom('control.instances')
        .select((builder) => [
          builder.fn.countAll<number>().as('instances'),
          builder.fn.sum<number>('desired_cpu_count').as('cpu_count'),
          builder.fn.sum<string>('desired_memory_mib').as('memory_mib'),
          builder.fn.sum<string>('desired_disk_gib').as('disk_gib'),
        ])
        .where('project_id', '=', command.projectId)
        .where('lifecycle_state', '!=', 'purged')
        .executeTakeFirstOrThrow();
      if (
        Number(usage.instances) + 1 > quota.instances ||
        Number(usage.cpu_count ?? 0) + flavor.cpu_count > quota.cpu_count ||
        Number(usage.memory_mib ?? 0) + Number(flavor.memory_mib) > Number(quota.memory_mib) ||
        Number(usage.disk_gib ?? 0) + Number(flavor.minimum_disk_gib) > Number(quota.disk_gib)
      ) {
        throw new DomainError('QUOTA_EXCEEDED', 'The create request exceeds project quota.');
      }

      // Serialize allocation per network; the partial unique index remains the final race guard.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${network.id}, 0))`.execute(
        transaction,
      );
      const leaseRows = await transaction
        .selectFrom('control.ipv4_leases')
        .select('address')
        .where('network_id', '=', network.id)
        .where('state', 'in', ['active', 'quarantined'])
        .execute();
      if (leaseRows.length + 1 > quota.ipv4_addresses) {
        throw new DomainError('QUOTA_EXCEEDED', 'The create request exceeds IPv4 quota.');
      }
      const address = allocateIpv4(
        {
          cidr: network.ipv4_cidr,
          gateway: network.gateway,
          exclusions: json<string[]>(network.exclusions),
        },
        new Set(leaseRows.map((row) => row.address)),
      );

      const now = new Date();
      const instanceId = randomUUID();
      const operationId = randomUUID();
      const eventId = randomUUID();
      const leaseId = randomUUID();
      const accepted: AcceptedMutation = {
        operationId,
        targetId: instanceId,
        acceptedAt: now.toISOString(),
        statusUrl: `/v1/projects/${command.projectId}/operations/${operationId}`,
        replayed: false,
      };
      const instance: InstanceView = {
        id: instanceId,
        projectId: command.projectId,
        lifecycleState: 'pending',
        desired: {
          imageId: command.imageId,
          flavorId: command.flavorId,
          networkId: command.networkId,
          hostname: command.hostname,
          powerState: 'running',
          retentionRequested: false,
        },
        observed: null,
        ipv4Lease: {
          address,
          prefixLength: Number(network.ipv4_cidr.split('/')[1]),
          gateway: network.gateway,
          state: 'active',
        },
        activeOperationId: operationId,
        drift: 'none',
        lastReconciledAt: null,
        retentionDeadline: null,
        purgeEligible: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const operation: OperationView = {
        id: operationId,
        projectId: command.projectId,
        action: 'create_instance',
        targetType: 'instance',
        targetId: instanceId,
        state: 'accepted',
        stage: 'accepted',
        progressPercent: 0,
        acceptedAt: now.toISOString(),
        startedAt: null,
        updatedAt: now.toISOString(),
        completedAt: null,
        errorCategory: null,
        errorCode: null,
        errorMessage: null,
        manualReviewRequired: false,
      };
      const event: InstanceCreateRequestedV1 = {
        eventId,
        schemaName: 'instance.create.requested',
        schemaVersion: 1,
        aggregateType: 'instance',
        aggregateId: instanceId,
        projectId: command.projectId,
        operationId,
        correlationId: command.correlationId,
        causationId: operationId,
        occurredAt: now.toISOString(),
        traceContext: { traceparent: command.traceparent || traceparent() },
        partitionKey: instanceId,
        data: {
          imageId: command.imageId,
          flavorId: command.flavorId,
          networkId: command.networkId,
          providerProfileId: image.provider_profile_id,
          hostname: command.hostname,
          resources: {
            cpuCount: flavor.cpu_count,
            memoryMiB: Number(flavor.memory_mib),
            diskGiB: Number(flavor.minimum_disk_gib),
          },
          ipv4: {
            address,
            prefixLength: Number(network.ipv4_cidr.split('/')[1]),
            gateway: network.gateway,
            dnsServers: dnsTuple(json<string[]>(network.dns_servers)),
          },
          ...(command.sshPublicKeys.length > 0
            ? { sshPublicKeys: sshTuple(command.sshPublicKeys) }
            : {}),
        },
      };

      await transaction
        .insertInto('control.instances')
        .values({
          id: instanceId,
          project_id: command.projectId,
          image_id: command.imageId,
          flavor_id: command.flavorId,
          network_id: command.networkId,
          provider_profile_id: image.provider_profile_id,
          hostname: command.hostname,
          ssh_public_keys: JSON.stringify(command.sshPublicKeys),
          desired_cpu_count: flavor.cpu_count,
          desired_memory_mib: flavor.memory_mib,
          desired_disk_gib: flavor.minimum_disk_gib,
          desired_power_state: 'running',
          lifecycle_state: 'pending',
          active_operation_id: null,
          version: '1',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await transaction
        .insertInto('control.operations')
        .values({
          id: operationId,
          project_id: command.projectId,
          action: 'create_instance',
          target_type: 'instance',
          target_id: instanceId,
          state: 'accepted',
          stage: 'accepted',
          progress_percent: 0,
          accepted_at: now,
          started_at: null,
          updated_at: now,
          completed_at: null,
          error_category: null,
          error_code: null,
          error_message: null,
          manual_review_required: false,
        })
        .execute();
      await transaction
        .updateTable('control.instances')
        .set({ active_operation_id: operationId })
        .where('id', '=', instanceId)
        .execute();
      await transaction
        .insertInto('control.ipv4_leases')
        .values({
          id: leaseId,
          project_id: command.projectId,
          instance_id: instanceId,
          network_id: network.id,
          address,
          prefix_length: Number(network.ipv4_cidr.split('/')[1]),
          gateway: network.gateway,
          state: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await transaction
        .insertInto('control.idempotency_records')
        .values({
          actor_id: command.actor.subject,
          project_id: command.projectId,
          operation_type: 'create_instance',
          idempotency_key: command.idempotencyKey,
          target_id: instanceId,
          request_hash: requestHash,
          operation_id: operationId,
          response: accepted,
          created_at: now,
          expires_at: new Date(now.getTime() + 86_400_000),
        })
        .execute();
      await transaction
        .insertInto('control.outbox')
        .values({
          event_id: eventId,
          aggregate_id: instanceId,
          aggregate_type: 'instance',
          schema_name: 'instance.create.requested',
          schema_version: 1,
          partition_key: instanceId,
          payload: event,
          occurred_at: now,
        })
        .execute();
      await transaction
        .insertInto('audit.entries')
        .values({
          id: randomUUID(),
          project_id: command.projectId,
          actor_id: command.actor.subject,
          actor_role: 'tenant_developer',
          action: 'create_instance',
          target_type: 'instance',
          target_id: instanceId,
          outcome: 'accepted',
          operation_id: operationId,
          occurred_at: now,
        })
        .execute();
      await transaction
        .insertInto('projection.instances')
        .values({
          instance_id: instanceId,
          project_id: command.projectId,
          document: instance,
          updated_at: now,
        })
        .execute();
      await transaction
        .insertInto('projection.operations')
        .values({
          operation_id: operationId,
          project_id: command.projectId,
          target_id: instanceId,
          document: operation,
          updated_at: now,
        })
        .execute();
      return accepted;
    });
  }

  public async getProject(projectId: string): Promise<ProjectView | null> {
    const row = await this.db
      .selectFrom('control.projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirst();
    return row
      ? {
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        }
      : null;
  }

  public async getQuota(projectId: string): Promise<QuotaView | null> {
    const quota = await this.db
      .selectFrom('control.quotas')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!quota) return null;
    const usage = await this.db
      .selectFrom('control.instances')
      .select((builder) => [
        builder.fn.countAll<number>().as('instances'),
        builder.fn.sum<number>('desired_cpu_count').as('cpu_count'),
        builder.fn.sum<string>('desired_memory_mib').as('memory_mib'),
        builder.fn.sum<string>('desired_disk_gib').as('disk_gib'),
      ])
      .where('project_id', '=', projectId)
      .where('lifecycle_state', '!=', 'purged')
      .executeTakeFirstOrThrow();
    const leases = await this.db
      .selectFrom('control.ipv4_leases')
      .select((builder) => builder.fn.countAll<number>().as('count'))
      .where('project_id', '=', projectId)
      .where('state', 'in', ['active', 'quarantined'])
      .executeTakeFirstOrThrow();
    return {
      projectId,
      limits: {
        instances: quota.instances,
        cpuCount: quota.cpu_count,
        memoryMiB: Number(quota.memory_mib),
        diskGiB: Number(quota.disk_gib),
        ipv4Addresses: quota.ipv4_addresses,
        snapshots: quota.snapshots,
      },
      usage: {
        instances: Number(usage.instances),
        cpuCount: Number(usage.cpu_count ?? 0),
        memoryMiB: Number(usage.memory_mib ?? 0),
        diskGiB: Number(usage.disk_gib ?? 0),
        ipv4Addresses: Number(leases.count),
        snapshots: 0,
      },
      measuredAt: new Date().toISOString(),
    };
  }

  public async listImages(_projectId: string, limit: number): Promise<Page<ImageView>> {
    const rows = await this.db
      .selectFrom('control.images')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('id')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        providerProfileId: row.provider_profile_id,
        enabled: row.enabled,
        architecture: row.architecture as 'x86_64' | 'arm64',
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      page: { limit, nextCursor: null },
    };
  }

  public async listFlavors(_projectId: string, limit: number): Promise<Page<FlavorView>> {
    const rows = await this.db
      .selectFrom('control.flavors')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('id')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        cpuCount: row.cpu_count,
        memoryMiB: Number(row.memory_mib),
        minimumDiskGiB: Number(row.minimum_disk_gib),
        enabled: row.enabled,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      page: { limit, nextCursor: null },
    };
  }

  public async listNetworks(_projectId: string, limit: number): Promise<Page<NetworkView>> {
    const rows = await this.db
      .selectFrom('control.networks')
      .selectAll()
      .where('enabled', '=', true)
      .orderBy('id')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ipv4Cidr: row.ipv4_cidr,
        gateway: row.gateway,
        dnsServers: json<string[]>(row.dns_servers),
        exclusions: json<string[]>(row.exclusions),
        enabled: row.enabled,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      page: { limit, nextCursor: null },
    };
  }

  public async getInstance(projectId: string, instanceId: string): Promise<InstanceView | null> {
    const row = await this.db
      .selectFrom('projection.instances')
      .select('document')
      .where('project_id', '=', projectId)
      .where('instance_id', '=', instanceId)
      .executeTakeFirst();
    return row ? json<InstanceView>(row.document) : null;
  }

  public async listInstances(projectId: string, limit: number): Promise<Page<InstanceView>> {
    const rows = await this.db
      .selectFrom('projection.instances')
      .select('document')
      .where('project_id', '=', projectId)
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => json<InstanceView>(row.document)),
      page: { limit, nextCursor: null },
    };
  }

  public async getOperation(projectId: string, operationId: string): Promise<OperationView | null> {
    const row = await this.db
      .selectFrom('projection.operations')
      .select('document')
      .where('project_id', '=', projectId)
      .where('operation_id', '=', operationId)
      .executeTakeFirst();
    return row ? json<OperationView>(row.document) : null;
  }

  public async listOperations(projectId: string, limit: number): Promise<Page<OperationView>> {
    const rows = await this.db
      .selectFrom('projection.operations')
      .select('document')
      .where('project_id', '=', projectId)
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => json<OperationView>(row.document)),
      page: { limit, nextCursor: null },
    };
  }
}
