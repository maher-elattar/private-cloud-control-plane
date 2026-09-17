/**
 * PostgreSQL adapter for the `ControlPlaneStore` port.
 *
 * PATTERN — Transactional outbox. The heart of this file is {@link
 * PostgresControlPlaneStore.acceptCreate}: one transaction that commits durable intent *and*
 * the outbox row that will drive provisioning. Everything else is straightforward readback.
 *
 * Two advisory locks appear here, both guarding a check-then-insert race that row locks
 * cannot cover because the row in question does not exist yet.
 *
 * @see docs/architecture/glossary.md#transactional-outbox
 * @see docs/architecture/phase-3-persistence.md
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { NOOP_APPLICATION_TELEMETRY, STAGE_PROGRESS_PERCENT } from '@private-cloud/application';
import type {
  AcceptedMutation,
  Actor,
  AdministrativeOperationView,
  ApplicationTelemetry,
  ApplicationTraceContext,
  AuditEventFilter,
  AuditEventView,
  ControlPlaneStore,
  CreateInstanceCommand,
  DeadLetterView,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  Page,
  PageRequest,
  PowerInstanceCommand,
  ProjectView,
  CreateSnapshotCommand,
  LeaseReleaseMode,
  QuotaView,
  ReplayDeadLetterCommand,
  PurgeInstanceCommand,
  RetainInstanceCommand,
  RetentionPolicyView,
  SnapshotActionCommand,
  SnapshotView,
  ResizeInstanceCommand,
} from '@private-cloud/application';
import type {
  AuditRecordedV1,
  EventEnvelope,
  InstanceCreateRequestedV1,
  InstancePowerRequestedV1,
  InstanceResizeRequestedV1,
  InstanceRetentionRequestedV1,
  InstancePurgeRequestedV1,
  SnapshotCreateRequestedV1,
  SnapshotDeleteRequestedV1,
  SnapshotRollbackRequestedV1,
  ProvisioningReplayRequestedV1,
} from '@private-cloud/contracts';
import { allocateIpv4, DomainError, validateResize } from '@private-cloud/domain';
import { sql, type RawBuilder, type SqlBool, type Transaction } from 'kysely';
import { parseJsonColumn, toIsoTimestamp } from './column-codec.js';
import { decodePageCursor, paginate } from './page-cursor.js';
import { lockInstanceForMutation } from './instance-guard.js';
import type { PostgresClient, PostgresDatabase } from './database.js';
import { serializeDebeziumTraceContext } from './trace-carrier.js';
import { auditRecordedEvent } from './audit-event.js';

/**
 * How long an idempotency record stays replayable (24 hours).
 *
 * Long enough to cover any realistic client retry window, short enough that the table does
 * not grow without bound. After expiry the same key is treated as a fresh request.
 */
const IDEMPOTENCY_RECORD_TTL_MS = 86_400_000;

/** Operation type recorded on idempotency and audit records for this command. */
const CREATE_INSTANCE_ACTION = 'create_instance';
/** Operation type recorded for power transitions; also the idempotency scope discriminator. */
const POWER_INSTANCE_ACTION = 'power_instance';
/** Operation type recorded for flavor resizes; also the idempotency scope discriminator. */
const RESIZE_INSTANCE_ACTION = 'resize_instance';
/** Operation type recorded for snapshot creation; also the idempotency scope discriminator. */
const CREATE_SNAPSHOT_ACTION = 'create_snapshot';
/** Operation type recorded for soft deletion; also the idempotency scope discriminator. */
const RETAIN_INSTANCE_ACTION = 'retain_instance';
/** Operation type recorded for administrative purge; also the idempotency scope discriminator. */
const PURGE_INSTANCE_ACTION = 'purge_instance';

/**
 * Idempotency scope for an administrative action, which has no tenant project of its own.
 *
 * The zero UUID stands in for "no project" so an administrator's key is scoped to them and the
 * action rather than colliding with any tenant's.
 */
function adminScope(command: {
  readonly actor: Actor;
  readonly idempotencyKey: string;
}): MutationIdentity {
  return {
    actor: command.actor,
    projectId: '00000000-0000-0000-0000-000000000000',
    idempotencyKey: command.idempotencyKey,
  };
}

/**
 * The fields every mutation shares for idempotency purposes.
 *
 * Scoping by actor, project, action, and key means one caller's key cannot collide with another's,
 * and the same key may legitimately be reused across different operation types.
 */
interface MutationIdentity {
  readonly actor: Actor;
  readonly projectId: string;
  readonly idempotencyKey: string;
}

/*
 * The contract fixes the DNS server list at 1-4 entries and SSH keys at 0-5, and expresses
 * that as a tuple rather than an array. These aliases and their guards below are how a
 * runtime-length array is proven to fit the tuple before it is placed in an event payload.
 */
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

/** Narrows a configured DNS list to the 1-4 entries the event contract allows. */
function dnsTuple(values: readonly string[]): DnsTuple {
  if (values.length < 1 || values.length > 4) {
    throw new DomainError('VALIDATION_FAILED', 'The configured DNS server list is invalid.');
  }
  return [...values] as DnsTuple;
}

/** Narrows an SSH key list to the 0-5 entries the event contract allows. */
function sshTuple(values: readonly string[]): SshTuple {
  if (values.length > 5) {
    throw new DomainError('VALIDATION_FAILED', 'At most five SSH public keys are accepted.');
  }
  return [...values] as SshTuple;
}

/**
 * Generates a W3C `traceparent` for a request that arrived without one.
 *
 * Every accepted command must carry trace context so provider calls made minutes later by
 * another process can still be correlated back to the request that caused them.
 */
function generatedTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

/** Prefix length parsed out of a network's CIDR, e.g. `24` from `10.0.0.0/24`. */
function prefixLengthOf(ipv4Cidr: string): number {
  return Number(ipv4Cidr.split('/')[1]);
}

/** Catalog and quota rows resolved once, then reused across acceptance. */
interface AcceptanceContext {
  readonly providerProfileId: string;
  readonly flavor: {
    readonly cpu_count: number;
    readonly memory_mib: string;
    readonly minimum_disk_gib: string;
  };
  readonly network: {
    readonly id: string;
    readonly ipv4_cidr: string;
    readonly gateway: string;
    readonly dns_servers: unknown;
    readonly exclusions: unknown;
  };
  readonly quota: {
    readonly instances: number;
    readonly cpu_count: number;
    readonly memory_mib: string;
    readonly disk_gib: string;
    readonly ipv4_addresses: number;
  };
}

/** The records an accepted create writes, built in memory before any of them are inserted. */
interface AcceptanceRecords {
  readonly instanceId: string;
  readonly operationId: string;
  readonly eventId: string;
  readonly leaseId: string;
  readonly now: Date;
  readonly address: string;
  readonly prefixLength: number;
  readonly accepted: AcceptedMutation;
  readonly instance: InstanceView;
  readonly operation: OperationView;
  readonly event: InstanceCreateRequestedV1;
}

/** Open transaction handle passed between the acceptance steps. */
type Tx = Transaction<PostgresDatabase>;

/**
 * Commits create intent and serves project readback from PostgreSQL.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */
export class PostgresControlPlaneStore implements ControlPlaneStore {
  /** @param db Kysely client owned by the calling service's DI container. */
  public constructor(
    private readonly db: PostgresClient,
    private readonly telemetry: ApplicationTelemetry = NOOP_APPLICATION_TELEMETRY,
  ) {}

  /**
   * Commits a create request as durable intent, or replays a previous identical one.
   *
   * Reads as the acceptance transaction documented in
   * docs/architecture/phase-3-persistence.md: lock the idempotency scope, replay if this is a
   * retry, resolve and validate the catalog, check quota, reserve an address, then write
   * every record — including the outbox row — atomically.
   *
   * @see ControlPlaneStore.acceptCreate for the full contract and error codes.
   */
  public async acceptCreate(
    command: CreateInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_create',
      { 'command.type': CREATE_INSTANCE_ACTION },
      () =>
        this.db.transaction().execute(async (tx) => {
          await this.lockIdempotencyScope(tx, command, CREATE_INSTANCE_ACTION);

          const replayed = await this.findReplayedResponse(
            tx,
            command,
            CREATE_INSTANCE_ACTION,
            requestHash,
          );
          if (replayed) return replayed;

          const context = await this.loadAcceptanceContext(tx, command);
          await this.assertQuotaHeadroom(tx, command, context);
          const address = await this.reserveIpv4Address(tx, context);

          const records = this.buildAcceptanceRecords(command, context, address);
          await this.writeAcceptanceRecords(tx, command, context, records, requestHash);
          return records.accepted;
        }),
    );
  }

  /**
   * Commits a power request as durable intent, or replays a previous identical one.
   *
   * Shorter than {@link PostgresControlPlaneStore.acceptCreate} because the instance already
   * exists: there is no catalog to resolve, no quota to check, and no address to reserve. What it
   * adds instead is the per-instance concurrency lock, which create does not need — create has no
   * prior instance that another operation could already be acting on.
   *
   * @see ControlPlaneStore.acceptPowerAction for the full contract and error codes.
   */
  public async acceptPowerAction(
    command: PowerInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_power',
      { 'command.type': POWER_INSTANCE_ACTION },
      () =>
        this.db.transaction().execute(async (tx) => {
          await this.lockIdempotencyScope(tx, command, POWER_INSTANCE_ACTION);
          const replayed = await this.findReplayedResponse(
            tx,
            command,
            POWER_INSTANCE_ACTION,
            requestHash,
          );
          if (replayed) return replayed;

          // Takes the row lock for the rest of the transaction, so a concurrent request for the
          // same instance waits and then sees `active_operation_id` set.
          const instance = await lockInstanceForMutation(tx, command.projectId, command.instanceId);

          const now = new Date();
          const occurredAt = now.toISOString();
          const operationId = randomUUID();
          const accepted: AcceptedMutation = {
            operationId,
            targetId: instance.id,
            acceptedAt: occurredAt,
            statusUrl: `/v1/projects/${command.projectId}/operations/${operationId}`,
            replayed: false,
          };

          const event: InstancePowerRequestedV1 = {
            eventId: randomUUID(),
            schemaName: 'instance.power.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: instance.id,
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: operationId,
            occurredAt,
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            // Partitioned by instance so every command touching one VM is ordered behind the
            // last, which is what lets the orchestrator rely on per-instance sequencing.
            partitionKey: instance.id,
            data: {
              action: command.action,
              providerProfileId: instance.providerProfileId,
              // WHY the create operation and not this one: the ownership markers on the VM were
              // written by create, and the provider matches all five markers or refuses.
              createOperationId: instance.createOperationId ?? '',
            },
          };

          await tx
            .insertInto('control.operations')
            .values({
              id: operationId,
              project_id: command.projectId,
              action: POWER_INSTANCE_ACTION,
              target_type: 'instance',
              target_id: instance.id,
              state: 'accepted',
              stage: 'accepted',
              progress_percent: STAGE_PROGRESS_PERCENT.accepted,
              accepted_at: now,
              updated_at: now,
              manual_review_required: false,
            })
            .executeTakeFirstOrThrow();
          await tx
            .updateTable('control.instances')
            .set({
              active_operation_id: operationId,
              // Desired power state records accepted intent, not a provider outcome. `reboot`
              // leaves it unchanged because the instance is meant to end up running either way.
              ...(command.action === 'start' || command.action === 'reboot'
                ? { desired_power_state: 'running' }
                : { desired_power_state: 'stopped' }),
              updated_at: now,
            })
            .where('id', '=', instance.id)
            .executeTakeFirstOrThrow();

          const operationDocument: OperationView = {
            id: operationId,
            projectId: command.projectId,
            action: POWER_INSTANCE_ACTION,
            targetType: 'instance',
            targetId: instance.id,
            state: 'accepted',
            stage: 'accepted',
            progressPercent: STAGE_PROGRESS_PERCENT.accepted,
            acceptedAt: occurredAt,
            updatedAt: occurredAt,
            manualReviewRequired: false,
          };
          await tx
            .insertInto('projection.operations')
            .values({
              operation_id: operationId,
              project_id: command.projectId,
              target_id: instance.id,
              document: operationDocument,
              updated_at: now,
              correlation_id: command.correlationId,
              trace_id: traceIdOf(command.traceparent),
              checkpoint: 'accepted',
            })
            .execute();
          await this.markInstanceBusyInProjection(tx, instance.id, operationId, now);

          await tx
            .insertInto('control.idempotency_records')
            .values({
              actor_id: command.actor.subject,
              project_id: command.projectId,
              operation_type: POWER_INSTANCE_ACTION,
              idempotency_key: command.idempotencyKey,
              target_id: instance.id,
              request_hash: requestHash,
              operation_id: operationId,
              response: accepted,
              created_at: now,
              expires_at: new Date(now.getTime() + IDEMPOTENCY_RECORD_TTL_MS),
            })
            .executeTakeFirstOrThrow();

          await this.writeControlOutbox(tx, event, 'provisioning.commands.v1', now);
          await this.writeControlAudit(tx, {
            eventId: randomUUID(),
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: event.eventId,
            occurredAt: now,
            traceContext: event.traceContext,
            actorId: command.actor.subject,
            actorRole: 'tenant_developer',
            action: `power_${command.action}`,
            targetType: 'instance',
            targetId: instance.id,
            outcome: 'accepted',
          });
          return accepted;
        }),
    );
  }

  /**
   * Commits a resize as durable intent, or replays a previous identical one.
   *
   * The quota check is a *delta* check, unlike create's. A resize consumes only the difference
   * between the instance's current sizing and the flavor's, so charging the full target against
   * the project would refuse resizes that free capacity as often as ones that consume it.
   *
   * @see ControlPlaneStore.acceptResize for the full contract and error codes.
   */
  public async acceptResize(
    command: ResizeInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_resize',
      { 'command.type': RESIZE_INSTANCE_ACTION },
      () =>
        this.db.transaction().execute(async (tx) => {
          await this.lockIdempotencyScope(tx, command, RESIZE_INSTANCE_ACTION);
          const replayed = await this.findReplayedResponse(
            tx,
            command,
            RESIZE_INSTANCE_ACTION,
            requestHash,
          );
          if (replayed) return replayed;

          const instance = await lockInstanceForMutation(tx, command.projectId, command.instanceId);
          const flavor = await tx
            .selectFrom('control.flavors')
            .selectAll()
            .where('id', '=', command.flavorId)
            .where('enabled', '=', true)
            .executeTakeFirst();
          if (!flavor) {
            throw new DomainError('VALIDATION_FAILED', 'The requested flavor is not available.');
          }

          const current = {
            cpuCount: instance.desiredCpuCount,
            memoryMiB: instance.desiredMemoryMib,
            diskGiB: instance.desiredDiskGib,
          };
          const target = {
            cpuCount: flavor.cpu_count,
            memoryMiB: Number(flavor.memory_mib),
            // Three inputs, and the largest wins. The flavor's minimum is a floor, the current
            // size is a floor, and an explicit request may raise it further. `validateResize`
            // refuses the case this cannot express: an explicit request *below* the current size.
            diskGiB: Math.max(
              current.diskGiB,
              Number(flavor.minimum_disk_gib),
              command.diskGiB ?? 0,
            ),
          };
          // Checked against what the tenant asked for, not the computed maximum, so an explicit
          // shrink is refused rather than silently rounded back up to the current size.
          validateResize({
            current,
            target: { ...target, diskGiB: command.diskGiB ?? target.diskGiB },
          });
          await this.assertResizeQuotaHeadroom(tx, command.projectId, current, target);

          const now = new Date();
          const occurredAt = now.toISOString();
          const operationId = randomUUID();
          const accepted: AcceptedMutation = {
            operationId,
            targetId: instance.id,
            acceptedAt: occurredAt,
            statusUrl: `/v1/projects/${command.projectId}/operations/${operationId}`,
            replayed: false,
          };

          const event: InstanceResizeRequestedV1 = {
            eventId: randomUUID(),
            schemaName: 'instance.resize.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: instance.id,
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: operationId,
            occurredAt,
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            partitionKey: instance.id,
            data: {
              flavorId: command.flavorId,
              targetResources: target,
              providerProfileId: instance.providerProfileId,
              createOperationId: instance.createOperationId ?? '',
            },
          };

          await tx
            .insertInto('control.operations')
            .values({
              id: operationId,
              project_id: command.projectId,
              action: RESIZE_INSTANCE_ACTION,
              target_type: 'instance',
              target_id: instance.id,
              state: 'accepted',
              stage: 'accepted',
              progress_percent: STAGE_PROGRESS_PERCENT.accepted,
              accepted_at: now,
              updated_at: now,
              manual_review_required: false,
            })
            .executeTakeFirstOrThrow();
          await tx
            .updateTable('control.instances')
            .set({
              active_operation_id: operationId,
              // Desired sizing records accepted intent. Observed sizing stays as it was until the
              // workflow proves the provider applied it.
              flavor_id: command.flavorId,
              desired_cpu_count: target.cpuCount,
              desired_memory_mib: String(target.memoryMiB),
              desired_disk_gib: String(target.diskGiB),
              updated_at: now,
            })
            .where('id', '=', instance.id)
            .executeTakeFirstOrThrow();

          await tx
            .insertInto('projection.operations')
            .values({
              operation_id: operationId,
              project_id: command.projectId,
              target_id: instance.id,
              document: {
                id: operationId,
                projectId: command.projectId,
                action: RESIZE_INSTANCE_ACTION,
                targetType: 'instance',
                targetId: instance.id,
                state: 'accepted',
                stage: 'accepted',
                progressPercent: STAGE_PROGRESS_PERCENT.accepted,
                acceptedAt: occurredAt,
                updatedAt: occurredAt,
                manualReviewRequired: false,
              } satisfies OperationView,
              updated_at: now,
              correlation_id: command.correlationId,
              trace_id: traceIdOf(command.traceparent),
              checkpoint: 'accepted',
            })
            .execute();
          await this.markInstanceBusyInProjection(tx, instance.id, operationId, now);

          await tx
            .insertInto('control.idempotency_records')
            .values({
              actor_id: command.actor.subject,
              project_id: command.projectId,
              operation_type: RESIZE_INSTANCE_ACTION,
              idempotency_key: command.idempotencyKey,
              target_id: instance.id,
              request_hash: requestHash,
              operation_id: operationId,
              response: accepted,
              created_at: now,
              expires_at: new Date(now.getTime() + IDEMPOTENCY_RECORD_TTL_MS),
            })
            .executeTakeFirstOrThrow();

          await this.writeControlOutbox(tx, event, 'provisioning.commands.v1', now);
          await this.writeControlAudit(tx, {
            eventId: randomUUID(),
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: event.eventId,
            occurredAt: now,
            traceContext: event.traceContext,
            actorId: command.actor.subject,
            actorRole: 'tenant_developer',
            action: 'resize_instance',
            targetType: 'instance',
            targetId: instance.id,
            outcome: 'accepted',
          });
          return accepted;
        }),
    );
  }

  /**
   * Checks project quota against the *change* a resize makes, not its absolute target.
   *
   * Charging the full target would refuse a resize that frees capacity as readily as one that
   * consumes it, because the instance's current usage is already counted in the project total.
   */
  private async assertResizeQuotaHeadroom(
    tx: Tx,
    projectId: string,
    current: { cpuCount: number; memoryMiB: number; diskGiB: number },
    target: { cpuCount: number; memoryMiB: number; diskGiB: number },
  ): Promise<void> {
    const quota = await tx
      .selectFrom('control.quotas')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!quota) throw new DomainError('PROJECT_NOT_FOUND', 'The project does not exist.');

    const usage = await tx
      .selectFrom('control.instances')
      .select((builder) => [
        builder.fn.sum<number>('desired_cpu_count').as('cpu_count'),
        builder.fn.sum<string>('desired_memory_mib').as('memory_mib'),
        builder.fn.sum<string>('desired_disk_gib').as('disk_gib'),
      ])
      .where('project_id', '=', projectId)
      .where('lifecycle_state', '!=', 'purged')
      .executeTakeFirstOrThrow();

    if (
      Number(usage.cpu_count ?? 0) - current.cpuCount + target.cpuCount > quota.cpu_count ||
      Number(usage.memory_mib ?? 0) - current.memoryMiB + target.memoryMiB >
        Number(quota.memory_mib) ||
      Number(usage.disk_gib ?? 0) - current.diskGiB + target.diskGiB > Number(quota.disk_gib)
    ) {
      throw new DomainError('QUOTA_EXCEEDED', 'The resize request exceeds project quota.');
    }
  }

  /**
   * Mirrors the busy marker onto the projected instance document.
   *
   * WHY eagerly rather than waiting for the first workflow event: a client that polls its own
   * instance immediately after a 202 would otherwise see `activeOperationId: null` and reasonably
   * conclude nothing had been accepted.
   */
  private async markInstanceBusyInProjection(
    tx: Tx,
    instanceId: string,
    operationId: string,
    now: Date,
  ): Promise<void> {
    const row = await tx
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', instanceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    const document = parseJsonColumn<InstanceView>(row.document);
    await tx
      .updateTable('projection.instances')
      .set({
        document: { ...document, activeOperationId: operationId, updatedAt: now.toISOString() },
        updated_at: now,
      })
      .where('instance_id', '=', instanceId)
      .execute();
  }

  /**
   * Moves an instance's IPv4 lease out of `active`.
   *
   * The two modes differ in one consequential way: the partial unique index on
   * `control.ipv4_leases` treats `active` and `quarantined` as occupying an address and `released`
   * as freeing it. So quarantining holds the address against reallocation while a retained VM may
   * still be answering on it, and releasing hands it back to the pool.
   *
   * The state progression is one-way: `active` to `quarantined` to `released`. Retention
   * quarantines, purge releases, and a redelivered retention command arriving after a purge cannot
   * re-reserve an address the pool has already handed out.
   *
   * @see ControlPlaneStore.releaseIpv4Lease for the full contract.
   */
  public async releaseIpv4Lease(
    instanceId: string,
    mode: LeaseReleaseMode,
  ): Promise<'quarantined' | 'released' | null> {
    const target = mode === 'quarantine_until_purge' ? 'quarantined' : 'released';
    return this.db.transaction().execute(async (tx) => {
      const lease = await tx
        .selectFrom('control.ipv4_leases')
        .select(['id', 'state'])
        .where('instance_id', '=', instanceId)
        .forUpdate()
        .executeTakeFirst();
      if (!lease) return null;

      // WHY a one-way progression rather than a plain assignment: retention quarantines an
      // address, and purge later releases it, so `quarantined` must be able to advance. The
      // reverse must not happen — a redelivered retention command arriving after a purge would
      // otherwise re-reserve an address the pool has already handed out.
      const order = { active: 0, quarantined: 1, released: 2 } as const;
      const current = lease.state as keyof typeof order;
      if (order[current] >= order[target]) return current === 'active' ? null : current;

      await tx
        .updateTable('control.ipv4_leases')
        .set({ state: target, updated_at: new Date() })
        .where('id', '=', lease.id)
        .where('state', '=', lease.state)
        .executeTakeFirstOrThrow();
      return target;
    });
  }

  /** Reads the single-row retention policy. */
  public async getRetentionPolicy(): Promise<RetentionPolicyView> {
    const row = await this.db
      .selectFrom('control.retention_policy')
      .selectAll()
      .executeTakeFirstOrThrow();
    return {
      retentionHours: row.retention_hours,
      leaseReleaseMode: row.lease_release_mode as RetentionPolicyView['leaseReleaseMode'],
      version: Number(row.version),
      updatedAt: toIsoTimestamp(row.updated_at),
      updatedBy: row.updated_by,
    };
  }

  /**
   * Commits a snapshot creation as durable intent, or replays a previous identical one.
   *
   * The snapshot row is written in the same transaction as the command, in `creating` state, so a
   * client polling immediately after its 202 sees the snapshot rather than an empty list.
   *
   * @see ControlPlaneStore.acceptSnapshotCreate for the full contract and error codes.
   */
  public async acceptSnapshotCreate(
    command: CreateSnapshotCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_snapshot_create',
      { 'command.type': CREATE_SNAPSHOT_ACTION },
      () =>
        this.db.transaction().execute(async (tx) => {
          await this.lockIdempotencyScope(tx, command, CREATE_SNAPSHOT_ACTION);
          const replayed = await this.findReplayedResponse(
            tx,
            command,
            CREATE_SNAPSHOT_ACTION,
            requestHash,
          );
          if (replayed) return replayed;

          const instance = await lockInstanceForMutation(tx, command.projectId, command.instanceId);
          await this.assertSnapshotHeadroom(tx, command.projectId);

          const duplicate = await tx
            .selectFrom('control.snapshots')
            .select('id')
            .where('instance_id', '=', instance.id)
            .where('name', '=', command.name)
            .executeTakeFirst();
          if (duplicate) {
            // Proxmox refuses a duplicate snapshot name on one VM, so the database refuses it too
            // rather than discovering the conflict after a provider call has already been made.
            throw new DomainError(
              'VALIDATION_FAILED',
              'A snapshot with this name already exists on the instance.',
            );
          }

          const now = new Date();
          const occurredAt = now.toISOString();
          const operationId = randomUUID();
          const snapshotId = randomUUID();
          const accepted: AcceptedMutation = {
            operationId,
            targetId: snapshotId,
            acceptedAt: occurredAt,
            statusUrl: `/v1/projects/${command.projectId}/operations/${operationId}`,
            replayed: false,
          };

          await tx
            .insertInto('control.snapshots')
            .values({
              id: snapshotId,
              project_id: command.projectId,
              instance_id: instance.id,
              name: command.name,
              description: command.description ?? null,
              state: 'creating',
              // The provider-side name is the caller's name; recorded now so a later rollback or
              // delete has a reference even if the create workflow never finishes.
              provider_snapshot_name: command.name,
              created_at: now,
              updated_at: now,
            })
            .executeTakeFirstOrThrow();

          const event: SnapshotCreateRequestedV1 = {
            eventId: randomUUID(),
            schemaName: 'snapshot.create.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: instance.id,
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: operationId,
            occurredAt,
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            partitionKey: instance.id,
            data: {
              snapshotId,
              name: command.name,
              ...(command.description ? { description: command.description } : {}),
              providerProfileId: instance.providerProfileId,
              createOperationId: instance.createOperationId ?? '',
            },
          };
          await this.writeSnapshotOperation(
            tx,
            command,
            CREATE_SNAPSHOT_ACTION,
            operationId,
            snapshotId,
            instance.id,
            accepted,
            event,
            requestHash,
            now,
          );
          return accepted;
        }),
    );
  }

  /**
   * Commits a rollback or delete of an existing snapshot.
   *
   * Both are destructive and both take the instance lock, so neither can run while another
   * operation is in flight on the same VM.
   *
   * @see ControlPlaneStore.acceptSnapshotAction for the full contract and error codes.
   */
  public async acceptSnapshotAction(
    action: 'rollback_snapshot' | 'delete_snapshot',
    command: SnapshotActionCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_snapshot_action',
      { 'command.type': action },
      () =>
        this.db.transaction().execute(async (tx) => {
          await this.lockIdempotencyScope(tx, command, action);
          const replayed = await this.findReplayedResponse(tx, command, action, requestHash);
          if (replayed) return replayed;

          const instance = await lockInstanceForMutation(tx, command.projectId, command.instanceId);
          const snapshot = await tx
            .selectFrom('control.snapshots')
            .selectAll()
            .where('id', '=', command.snapshotId)
            .forUpdate()
            .executeTakeFirst();
          if (!snapshot) {
            throw new DomainError('SNAPSHOT_NOT_FOUND', 'The requested snapshot does not exist.');
          }
          if (snapshot.instance_id !== instance.id) {
            // Reported as a conflict rather than as missing: the snapshot exists, just not on the
            // instance the caller named, and telling them it is missing would leave them retrying
            // a request that can never succeed.
            throw new DomainError(
              'SNAPSHOT_OWNERSHIP_MISMATCH',
              'The snapshot does not belong to the requested instance.',
            );
          }
          if (snapshot.state !== 'available') {
            throw new DomainError(
              'INSTANCE_BUSY',
              'The snapshot is not in a state that accepts this operation.',
            );
          }

          const now = new Date();
          const occurredAt = now.toISOString();
          const operationId = randomUUID();
          const accepted: AcceptedMutation = {
            operationId,
            targetId: snapshot.id,
            acceptedAt: occurredAt,
            statusUrl: `/v1/projects/${command.projectId}/operations/${operationId}`,
            replayed: false,
          };

          await tx
            .updateTable('control.snapshots')
            .set({
              state: action === 'rollback_snapshot' ? 'rolling_back' : 'deleting',
              updated_at: now,
            })
            .where('id', '=', snapshot.id)
            .executeTakeFirstOrThrow();

          const event: SnapshotRollbackRequestedV1 | SnapshotDeleteRequestedV1 = {
            eventId: randomUUID(),
            schemaName:
              action === 'rollback_snapshot'
                ? 'snapshot.rollback.requested'
                : 'snapshot.delete.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: instance.id,
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: operationId,
            occurredAt,
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            partitionKey: instance.id,
            data: {
              snapshotId: snapshot.id,
              providerSnapshotReference: snapshot.provider_snapshot_name ?? snapshot.name,
              providerProfileId: instance.providerProfileId,
              createOperationId: instance.createOperationId ?? '',
            },
          } as SnapshotRollbackRequestedV1;

          await this.writeSnapshotOperation(
            tx,
            command,
            action,
            operationId,
            snapshot.id,
            instance.id,
            accepted,
            event,
            requestHash,
            now,
          );
          return accepted;
        }),
    );
  }

  /** Lists an instance's snapshots from the read projection. */
  public async listSnapshots(
    projectId: string,
    instanceId: string,
    page: PageRequest,
  ): Promise<Page<SnapshotView>> {
    const rows = await this.db
      .selectFrom('projection.snapshots')
      .select(['document', 'updated_at', 'snapshot_id'])
      .where('project_id', '=', projectId)
      .where('instance_id', '=', instanceId)
      .$if(Boolean(page.cursor), (query) =>
        query.where(seekDescending(page.cursor, 'updated_at', 'snapshot_id', 'uuid')),
      )
      .orderBy('updated_at', 'desc')
      .orderBy('snapshot_id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({
      sortKey: toIsoTimestamp(row.updated_at),
      id: row.snapshot_id,
    }));
    return {
      items: trimmed.items.map((row) => parseJsonColumn<SnapshotView>(row.document)),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /** Refuses a snapshot that would exceed the project's snapshot quota. */
  private async assertSnapshotHeadroom(tx: Tx, projectId: string): Promise<void> {
    const quota = await tx
      .selectFrom('control.quotas')
      .select('snapshots')
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!quota) throw new DomainError('PROJECT_NOT_FOUND', 'The project does not exist.');
    const used = await tx
      .selectFrom('control.snapshots')
      .select((builder) => builder.fn.countAll<number>().as('count'))
      .where('project_id', '=', projectId)
      .where('state', 'in', ['creating', 'available', 'rolling_back', 'deleting'])
      .executeTakeFirstOrThrow();
    if (Number(used.count) + 1 > quota.snapshots) {
      throw new DomainError('QUOTA_EXCEEDED', 'The snapshot request exceeds project quota.');
    }
  }

  /**
   * Writes the operation, projections, idempotency record, outbox command, and audit fact.
   *
   * Shared by all three snapshot actions, which differ only in the event they publish.
   */
  private async writeSnapshotOperation(
    tx: Tx,
    command: MutationIdentity & { readonly correlationId: string; readonly traceparent: string },
    action: string,
    operationId: string,
    snapshotId: string,
    instanceId: string,
    accepted: AcceptedMutation,
    event: EventEnvelope,
    requestHash: string,
    now: Date,
  ): Promise<void> {
    const occurredAt = now.toISOString();
    const document: OperationView = {
      id: operationId,
      projectId: command.projectId,
      action,
      targetType: 'snapshot',
      targetId: snapshotId,
      state: 'accepted',
      stage: 'accepted',
      progressPercent: STAGE_PROGRESS_PERCENT.accepted,
      acceptedAt: occurredAt,
      updatedAt: occurredAt,
      manualReviewRequired: false,
    };

    await tx
      .insertInto('control.operations')
      .values({
        id: operationId,
        project_id: command.projectId,
        action,
        target_type: 'snapshot',
        target_id: snapshotId,
        state: 'accepted',
        stage: 'accepted',
        progress_percent: STAGE_PROGRESS_PERCENT.accepted,
        accepted_at: now,
        updated_at: now,
        manual_review_required: false,
      })
      .executeTakeFirstOrThrow();
    // The instance is busy for the duration, even though the operation targets a snapshot: the
    // provider mutation acts on the VM.
    await tx
      .updateTable('control.instances')
      .set({ active_operation_id: operationId, updated_at: now })
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('projection.operations')
      .values({
        operation_id: operationId,
        project_id: command.projectId,
        target_id: snapshotId,
        document,
        updated_at: now,
        correlation_id: command.correlationId,
        trace_id: traceIdOf(command.traceparent),
        checkpoint: 'accepted',
      })
      .execute();
    await this.markInstanceBusyInProjection(tx, instanceId, operationId, now);
    await this.writeSnapshotProjection(tx, snapshotId, command.projectId, instanceId, now);
    await tx
      .insertInto('control.idempotency_records')
      .values({
        actor_id: command.actor.subject,
        project_id: command.projectId,
        operation_type: action,
        idempotency_key: command.idempotencyKey,
        target_id: snapshotId,
        request_hash: requestHash,
        operation_id: operationId,
        response: accepted,
        created_at: now,
        expires_at: new Date(now.getTime() + IDEMPOTENCY_RECORD_TTL_MS),
      })
      .executeTakeFirstOrThrow();
    await this.writeControlOutbox(tx, event, 'provisioning.commands.v1', now);
    await this.writeControlAudit(tx, {
      eventId: randomUUID(),
      projectId: command.projectId,
      operationId,
      correlationId: command.correlationId,
      causationId: event.eventId,
      occurredAt: now,
      traceContext: event.traceContext,
      actorId: command.actor.subject,
      actorRole: 'tenant_developer',
      action,
      targetType: 'snapshot',
      targetId: snapshotId,
      outcome: 'accepted',
    });
  }

  /** Mirrors the authoritative snapshot row into the read projection. */
  private async writeSnapshotProjection(
    tx: Tx,
    snapshotId: string,
    projectId: string,
    instanceId: string,
    now: Date,
  ): Promise<void> {
    const row = await tx
      .selectFrom('control.snapshots')
      .selectAll()
      .where('id', '=', snapshotId)
      .executeTakeFirstOrThrow();
    const document: SnapshotView = {
      id: row.id,
      instanceId: row.instance_id,
      name: row.name,
      description: row.description,
      state: row.state as SnapshotView['state'],
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
    };
    await tx
      .insertInto('projection.snapshots')
      .values({
        snapshot_id: snapshotId,
        project_id: projectId,
        instance_id: instanceId,
        document,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column('snapshot_id').doUpdateSet({ document, updated_at: now }),
      )
      .execute();
  }

  /**
   * Commits a soft deletion as durable intent, or replays a previous identical one.
   *
   * The IPv4 lease moves at acceptance rather than on completion. WHY: the point of retention is
   * that the tenant loses access immediately, and an address still marked `active` could be
   * handed to a new instance while the old VM is still answering on it. The policy decides
   * whether the address is quarantined until purge or returned to the pool now.
   *
   * @see ControlPlaneStore.acceptRetention for the full contract and error codes.
   */
  public async acceptRetention(
    command: RetainInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_retention',
      { 'command.type': RETAIN_INSTANCE_ACTION },
      () =>
        this.db.transaction().execute(async (tx) => {
          await this.lockIdempotencyScope(tx, command, RETAIN_INSTANCE_ACTION);
          const replayed = await this.findReplayedResponse(
            tx,
            command,
            RETAIN_INSTANCE_ACTION,
            requestHash,
          );
          if (replayed) return replayed;

          const instance = await lockInstanceForMutation(tx, command.projectId, command.instanceId);
          const policy = await tx
            .selectFrom('control.retention_policy')
            .selectAll()
            .executeTakeFirstOrThrow();

          const now = new Date();
          const occurredAt = now.toISOString();
          const operationId = randomUUID();
          const retentionDeadline = new Date(
            now.getTime() + policy.retention_hours * 60 * 60 * 1000,
          );
          const accepted: AcceptedMutation = {
            operationId,
            targetId: instance.id,
            acceptedAt: occurredAt,
            statusUrl: `/v1/projects/${command.projectId}/operations/${operationId}`,
            replayed: false,
          };

          const event: InstanceRetentionRequestedV1 = {
            eventId: randomUUID(),
            schemaName: 'instance.retention.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: instance.id,
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: operationId,
            occurredAt,
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            partitionKey: instance.id,
            data: {
              retentionDeadline: retentionDeadline.toISOString(),
              leaseReleaseMode:
                policy.lease_release_mode as InstanceRetentionRequestedV1['data']['leaseReleaseMode'],
              providerProfileId: instance.providerProfileId,
              createOperationId: instance.createOperationId ?? '',
            },
          };

          await tx
            .insertInto('control.operations')
            .values({
              id: operationId,
              project_id: command.projectId,
              action: RETAIN_INSTANCE_ACTION,
              target_type: 'instance',
              target_id: instance.id,
              state: 'accepted',
              stage: 'accepted',
              progress_percent: STAGE_PROGRESS_PERCENT.accepted,
              accepted_at: now,
              updated_at: now,
              manual_review_required: false,
            })
            .executeTakeFirstOrThrow();
          await tx
            .updateTable('control.instances')
            .set({
              active_operation_id: operationId,
              // `deleting` for the duration; the workflow's terminal event moves it to `retained`.
              lifecycle_state: 'deleting',
              retention_deadline: retentionDeadline,
              // Not purgeable until the deadline passes; capability 8 enforces that.
              purge_eligible: false,
              updated_at: now,
            })
            .where('id', '=', instance.id)
            .executeTakeFirstOrThrow();

          await tx
            .updateTable('control.ipv4_leases')
            .set({
              state: policy.lease_release_mode === 'release_on_retain' ? 'released' : 'quarantined',
              updated_at: now,
            })
            .where('instance_id', '=', instance.id)
            .where('state', '=', 'active')
            .execute();

          await tx
            .insertInto('projection.operations')
            .values({
              operation_id: operationId,
              project_id: command.projectId,
              target_id: instance.id,
              document: {
                id: operationId,
                projectId: command.projectId,
                action: RETAIN_INSTANCE_ACTION,
                targetType: 'instance',
                targetId: instance.id,
                state: 'accepted',
                stage: 'accepted',
                progressPercent: STAGE_PROGRESS_PERCENT.accepted,
                acceptedAt: occurredAt,
                updatedAt: occurredAt,
                manualReviewRequired: false,
              } satisfies OperationView,
              updated_at: now,
              correlation_id: command.correlationId,
              trace_id: traceIdOf(command.traceparent),
              checkpoint: 'accepted',
            })
            .execute();
          await this.markInstanceBusyInProjection(tx, instance.id, operationId, now);
          await tx
            .insertInto('control.idempotency_records')
            .values({
              actor_id: command.actor.subject,
              project_id: command.projectId,
              operation_type: RETAIN_INSTANCE_ACTION,
              idempotency_key: command.idempotencyKey,
              target_id: instance.id,
              request_hash: requestHash,
              operation_id: operationId,
              response: accepted,
              created_at: now,
              expires_at: new Date(now.getTime() + IDEMPOTENCY_RECORD_TTL_MS),
            })
            .executeTakeFirstOrThrow();
          await this.writeControlOutbox(tx, event, 'provisioning.commands.v1', now);
          await this.writeControlAudit(tx, {
            eventId: randomUUID(),
            projectId: command.projectId,
            operationId,
            correlationId: command.correlationId,
            causationId: event.eventId,
            occurredAt: now,
            traceContext: event.traceContext,
            actorId: command.actor.subject,
            actorRole: 'tenant_developer',
            action: RETAIN_INSTANCE_ACTION,
            targetType: 'instance',
            targetId: instance.id,
            outcome: 'accepted',
          });
          return accepted;
        }),
    );
  }

  /**
   * Commits an administrative purge as durable intent.
   *
   * Three guards, all before any command is published, and each refusing a different mistake:
   *
   * 1. The confirmation must repeat the instance id. An administrator pasting the wrong
   *    identifier is the most likely way this operation destroys the wrong machine.
   * 2. The instance must be `retained`. Purging straight from `active` would let a single
   *    request destroy a VM a tenant is still using.
   * 3. The retention deadline must have passed. Retention exists so someone can change their
   *    mind; purging before it expires removes that window.
   *
   * The live provider ownership check that SAFE-006 also requires cannot happen here — it needs a
   * provider call — so the workflow performs it immediately before destroying anything.
   *
   * @see ControlPlaneStore.acceptPurge for the full contract and error codes.
   */
  public async acceptPurge(
    command: PurgeInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.accept_purge',
      { 'command.type': PURGE_INSTANCE_ACTION },
      () =>
        this.db.transaction().execute(async (tx) => {
          if (command.confirmInstanceId !== command.instanceId) {
            throw new DomainError(
              'VALIDATION_FAILED',
              'The confirmation identifier does not match the instance being purged.',
            );
          }
          await this.lockIdempotencyScope(tx, adminScope(command), PURGE_INSTANCE_ACTION);
          const replayed = await this.findReplayedResponse(
            tx,
            adminScope(command),
            PURGE_INSTANCE_ACTION,
            requestHash,
          );
          if (replayed) return replayed;

          const instance = await tx
            .selectFrom('control.instances')
            .selectAll()
            .where('id', '=', command.instanceId)
            .forUpdate()
            .executeTakeFirst();
          if (!instance) {
            throw new DomainError('INSTANCE_NOT_FOUND', 'The requested instance does not exist.');
          }
          if (instance.active_operation_id !== null) {
            throw new DomainError(
              'INSTANCE_BUSY',
              'Another operation is already in progress for this instance.',
            );
          }
          if (instance.lifecycle_state !== 'retained') {
            throw new DomainError('INSTANCE_BUSY', 'Only a retained instance can be purged.');
          }
          const now = new Date();
          const deadline = instance.retention_deadline
            ? new Date(instance.retention_deadline)
            : null;
          if (!deadline || deadline > now) {
            throw new DomainError('INSTANCE_BUSY', 'The retention period has not expired.');
          }

          const occurredAt = now.toISOString();
          const operationId = randomUUID();
          const purgeAuthorizationId = randomUUID();
          const accepted: AcceptedMutation = {
            operationId,
            targetId: instance.id,
            acceptedAt: occurredAt,
            statusUrl: `/v1/admin/operations/${operationId}`,
            replayed: false,
          };

          const event: InstancePurgeRequestedV1 = {
            eventId: randomUUID(),
            schemaName: 'instance.purge.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: instance.id,
            projectId: instance.project_id,
            operationId,
            correlationId: command.correlationId,
            causationId: operationId,
            occurredAt,
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            partitionKey: instance.id,
            data: {
              purgeAuthorizationId,
              retentionDeadline: deadline.toISOString(),
              // The justification itself stays in the audit trail; the command carries only a
              // reference, so free text an administrator typed never crosses the broker.
              reasonReference: purgeAuthorizationId,
              providerProfileId: instance.provider_profile_id,
              createOperationId: instance.create_operation_id ?? '',
            },
          };

          await tx
            .insertInto('control.operations')
            .values({
              id: operationId,
              project_id: instance.project_id,
              action: PURGE_INSTANCE_ACTION,
              target_type: 'instance',
              target_id: instance.id,
              state: 'accepted',
              stage: 'accepted',
              progress_percent: STAGE_PROGRESS_PERCENT.accepted,
              accepted_at: now,
              updated_at: now,
              manual_review_required: false,
            })
            .executeTakeFirstOrThrow();
          await tx
            .updateTable('control.instances')
            .set({
              active_operation_id: operationId,
              lifecycle_state: 'purge_pending',
              purge_eligible: true,
              updated_at: now,
            })
            .where('id', '=', instance.id)
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('projection.operations')
            .values({
              operation_id: operationId,
              project_id: instance.project_id,
              target_id: instance.id,
              document: {
                id: operationId,
                projectId: instance.project_id,
                action: PURGE_INSTANCE_ACTION,
                targetType: 'instance',
                targetId: instance.id,
                state: 'accepted',
                stage: 'accepted',
                progressPercent: STAGE_PROGRESS_PERCENT.accepted,
                acceptedAt: occurredAt,
                updatedAt: occurredAt,
                manualReviewRequired: false,
              } satisfies OperationView,
              updated_at: now,
              correlation_id: command.correlationId,
              trace_id: traceIdOf(command.traceparent),
              checkpoint: 'accepted',
            })
            .execute();
          await this.markInstanceBusyInProjection(tx, instance.id, operationId, now);
          await tx
            .insertInto('control.idempotency_records')
            .values({
              actor_id: command.actor.subject,
              // The same administrative scope the lookup uses. Writing the instance's project here
              // instead meant a repeated key never matched, and the second request was refused as
              // busy rather than replayed — which for a destructive operation is the worst place
              // to be inconsistent. `project_id` carries no foreign key, so the sentinel is safe.
              project_id: adminScope(command).projectId,
              operation_type: PURGE_INSTANCE_ACTION,
              idempotency_key: command.idempotencyKey,
              target_id: instance.id,
              request_hash: requestHash,
              operation_id: operationId,
              response: accepted,
              created_at: now,
              expires_at: new Date(now.getTime() + IDEMPOTENCY_RECORD_TTL_MS),
            })
            .executeTakeFirstOrThrow();
          await this.writeControlOutbox(tx, event, 'provisioning.commands.v1', now);
          await this.writeControlAudit(tx, {
            eventId: randomUUID(),
            projectId: instance.project_id,
            operationId,
            correlationId: command.correlationId,
            causationId: event.eventId,
            occurredAt: now,
            traceContext: event.traceContext,
            actorId: command.actor.subject,
            actorRole: 'platform_administrator',
            action: PURGE_INSTANCE_ACTION,
            targetType: 'instance',
            targetId: instance.id,
            outcome: 'accepted',
            reasonReference: purgeAuthorizationId,
          });
          return accepted;
        }),
    );
  }

  /**
   * Marks an instance for reconciliation on the next sweep.
   *
   * Clearing `last_reconciled_at` is the whole mechanism: the sweep claims by staleness, so a null
   * sorts first. No provider call happens here, deliberately — see the port contract.
   */
  public async requestReconciliation(instanceId: string): Promise<boolean> {
    const updated = await this.db
      .updateTable('control.instances')
      .set({ last_reconciled_at: null })
      .where('id', '=', instanceId)
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  /** Lists the Kafka-projected dead-letter view without exposing original payloads. */
  public async listDeadLetters(page: PageRequest): Promise<Page<DeadLetterView>> {
    const rows = await this.db
      .selectFrom('projection.dead_letters')
      .select(['document', 'updated_at', 'original_event_id'])
      .$if(Boolean(page.cursor), (query) =>
        query.where(seekDescending(page.cursor, 'updated_at', 'original_event_id', 'uuid')),
      )
      .orderBy('updated_at', 'desc')
      .orderBy('original_event_id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({
      sortKey: toIsoTimestamp(row.updated_at),
      id: row.original_event_id,
    }));
    return {
      items: trimmed.items.map((row) => parseJsonColumn<DeadLetterView>(row.document)),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /** Reads only the bounded W3C carrier needed to link replay to the failed trace. */
  public async getDeadLetterTraceContext(
    originalEventId: string,
  ): Promise<ApplicationTraceContext | null> {
    const row = await this.db
      .selectFrom('projection.dead_letters')
      .select('trace_context')
      .where('original_event_id', '=', originalEventId)
      .executeTakeFirst();
    return row?.trace_context ? parseJsonColumn<ApplicationTraceContext>(row.trace_context) : null;
  }

  /** Persists attributed replay intent and its Debezium-routed command atomically. */
  public requestDeadLetterReplay(
    command: ReplayDeadLetterCommand,
    requestHash: string,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.transaction.request_replay',
      { 'command.type': 'replay_dead_letter' },
      () =>
        this.db.transaction().execute(async (tx) => {
          const scope = `${command.actor.subject}:replay_dead_letter:${command.idempotencyKey}`;
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`.execute(tx);

          const previous = await tx
            .selectFrom('control.replay_requests')
            .selectAll()
            .where('actor_id', '=', command.actor.subject)
            .where('idempotency_key', '=', command.idempotencyKey)
            .executeTakeFirst();
          const projected = await tx
            .selectFrom('projection.dead_letters')
            .select('document')
            .where('original_event_id', '=', command.originalEventId)
            .executeTakeFirst();
          if (!projected) {
            throw new DomainError('DEAD_LETTER_NOT_FOUND', 'The dead letter was not found.');
          }
          const deadLetter = parseJsonColumn<DeadLetterView>(projected.document);
          if (previous) {
            if (previous.request_hash !== requestHash) {
              throw new DomainError(
                'IDEMPOTENCY_CONFLICT',
                'The idempotency key is already bound to different replay intent.',
              );
            }
            return {
              operationId: deadLetter.operationId,
              targetId: deadLetter.aggregateId,
              acceptedAt: toIsoTimestamp(previous.requested_at),
              statusUrl: `/v1/projects/${deadLetter.projectId}/operations/${deadLetter.operationId}`,
              replayed: true,
            };
          }
          if (!deadLetter.replayAllowed) {
            throw new DomainError('REPLAY_NOT_ALLOWED', 'This dead letter is not replayable.');
          }

          const now = new Date();
          const replayRequestId = randomUUID();
          const event: ProvisioningReplayRequestedV1 = {
            eventId: randomUUID(),
            schemaName: 'provisioning.replay.requested',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: deadLetter.aggregateId,
            projectId: deadLetter.projectId,
            operationId: deadLetter.operationId,
            correlationId: command.correlationId,
            causationId: command.originalEventId,
            occurredAt: now.toISOString(),
            traceContext: {
              traceparent: command.traceparent,
              ...(command.tracestate ? { tracestate: command.tracestate } : {}),
            },
            partitionKey: deadLetter.aggregateId,
            data: {
              replayRequestId,
              originalEventId: command.originalEventId,
              requestedAt: now.toISOString(),
            },
          };
          await tx
            .insertInto('control.replay_requests')
            .values({
              id: replayRequestId,
              original_event_id: command.originalEventId,
              actor_id: command.actor.subject,
              idempotency_key: command.idempotencyKey,
              request_hash: requestHash,
              reason: command.reason,
              correlation_id: command.correlationId,
              trace_context: event.traceContext,
              status: 'accepted',
              requested_at: now,
              updated_at: now,
            })
            .executeTakeFirstOrThrow();
          await this.writeControlOutbox(tx, event, 'provisioning.commands.v1', now);
          await this.writeControlAudit(tx, {
            eventId: randomUUID(),
            projectId: deadLetter.projectId,
            operationId: deadLetter.operationId,
            correlationId: command.correlationId,
            causationId: event.eventId,
            occurredAt: now,
            traceContext: event.traceContext,
            actorId: command.actor.subject,
            actorRole: 'platform_administrator',
            action: 'replay_dead_letter',
            targetType: 'event',
            targetId: command.originalEventId,
            outcome: 'accepted',
            reasonReference: replayRequestId,
          });
          return {
            operationId: deadLetter.operationId,
            targetId: deadLetter.aggregateId,
            acceptedAt: now.toISOString(),
            statusUrl: `/v1/projects/${deadLetter.projectId}/operations/${deadLetter.operationId}`,
            replayed: false,
          };
        }),
    );
  }

  /**
   * Serialises concurrent requests that share an idempotency scope.
   *
   * WHY: two requests carrying the same `Idempotency-Key` would both miss the SELECT in
   * {@link PostgresControlPlaneStore.findReplayedResponse}, both conclude they are the first,
   * and both provision a VM. A row lock cannot help — the record they are racing to create
   * does not exist yet. Serialising on a hash of the scope makes the loser wait, then find
   * the winner's committed record and replay it.
   *
   * `pg_advisory_xact_lock` releases at transaction end, so there is no unlock to forget.
   */
  private async lockIdempotencyScope(
    tx: Tx,
    command: MutationIdentity,
    action: string,
  ): Promise<void> {
    const scope = [command.actor.subject, command.projectId, action, command.idempotencyKey].join(
      ':',
    );
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`.execute(tx);
  }

  /**
   * Returns the original response when this request has already been accepted.
   *
   * A key bound to *different* input is a client bug, not a retry, so it raises
   * `IDEMPOTENCY_CONFLICT` rather than replaying a response that would not describe what the
   * caller just asked for.
   */
  private async findReplayedResponse(
    tx: Tx,
    command: MutationIdentity,
    action: string,
    requestHash: string,
  ): Promise<AcceptedMutation | null> {
    const previous = await tx
      .selectFrom('control.idempotency_records')
      .select(['request_hash', 'response'])
      .where('actor_id', '=', command.actor.subject)
      .where('project_id', '=', command.projectId)
      .where('operation_type', '=', action)
      .where('idempotency_key', '=', command.idempotencyKey)
      .executeTakeFirst();
    if (!previous) return null;

    if (previous.request_hash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key is already bound to different input.',
      );
    }
    return { ...parseJsonColumn<AcceptedMutation>(previous.response), replayed: true };
  }

  /**
   * Resolves the project, catalog, and quota rows, rejecting anything unusable.
   *
   * The image is joined to its provider profile because two facts about that profile gate
   * acceptance: the profile must be `active`, and its network must be the one the caller
   * asked for. WHY the second check: an image and a network from different provider profiles
   * would produce a VM the control plane could not later observe or reconcile, since the
   * observation call is scoped to a single profile.
   *
   * @throws DomainError `PROJECT_NOT_FOUND`, `PROJECT_ACCESS_DENIED`, `PROFILE_DISABLED`, or
   *   `VALIDATION_FAILED`.
   */
  private async loadAcceptanceContext(
    tx: Tx,
    command: CreateInstanceCommand,
  ): Promise<AcceptanceContext> {
    const project = await tx
      .selectFrom('control.projects')
      .select(['id', 'enabled'])
      .where('id', '=', command.projectId)
      .executeTakeFirst();
    if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found.');
    if (!project.enabled) throw new DomainError('PROJECT_ACCESS_DENIED', 'Project is disabled.');

    const image = await tx
      .selectFrom('control.images as image')
      .innerJoin('control.provider_profiles as profile', 'profile.id', 'image.provider_profile_id')
      .select([
        'image.id',
        'image.enabled',
        'profile.id as provider_profile_id',
        'profile.state',
        'profile.network_id as provider_network_id',
      ])
      .where('image.id', '=', command.imageId)
      .executeTakeFirst();
    const flavor = await tx
      .selectFrom('control.flavors')
      .selectAll()
      .where('id', '=', command.flavorId)
      .where('enabled', '=', true)
      .executeTakeFirst();
    const network = await tx
      .selectFrom('control.networks')
      .selectAll()
      .where('id', '=', command.networkId)
      .where('enabled', '=', true)
      .executeTakeFirst();
    const quota = await tx
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
    if (image.state !== 'active') {
      throw new DomainError('PROFILE_DISABLED', 'Provider profile is disabled.');
    }
    if (image.provider_network_id !== network.id) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'The selected image and network do not share a provider profile.',
      );
    }

    return { providerProfileId: image.provider_profile_id, flavor, network, quota };
  }

  /**
   * Rejects the request if adding this instance would exceed any project quota.
   *
   * Usage is measured live rather than kept as a running counter, so it cannot drift out of
   * step with reality. `purged` instances are excluded because their resources are released.
   *
   * @throws DomainError `QUOTA_EXCEEDED`.
   */
  private async assertQuotaHeadroom(
    tx: Tx,
    command: CreateInstanceCommand,
    context: AcceptanceContext,
  ): Promise<void> {
    const usage = await tx
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

    const { flavor, quota } = context;
    if (
      Number(usage.instances) + 1 > quota.instances ||
      Number(usage.cpu_count ?? 0) + flavor.cpu_count > quota.cpu_count ||
      Number(usage.memory_mib ?? 0) + Number(flavor.memory_mib) > Number(quota.memory_mib) ||
      Number(usage.disk_gib ?? 0) + Number(flavor.minimum_disk_gib) > Number(quota.disk_gib)
    ) {
      throw new DomainError('QUOTA_EXCEEDED', 'The create request exceeds project quota.');
    }
  }

  /**
   * Reserves the lowest free IPv4 address on the network.
   *
   * WHY the second advisory lock: allocation is a scan-then-claim sequence, so two requests
   * on the same network would read the same lease set, compute the same lowest free address,
   * and both take it. Serialising per network makes the scan and the claim atomic with
   * respect to each other.
   *
   * The partial unique index on `control.ipv4_leases` remains the final correctness guard —
   * this lock exists so the common case does not lose work to a constraint violation.
   *
   * @throws DomainError `QUOTA_EXCEEDED` if the address quota is reached or the pool is full.
   */
  private async reserveIpv4Address(tx: Tx, context: AcceptanceContext): Promise<string> {
    const { network, quota } = context;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${network.id}, 0))`.execute(tx);

    const leaseRows = await tx
      .selectFrom('control.ipv4_leases')
      .select('address')
      .where('network_id', '=', network.id)
      // `quarantined` addresses count as taken: they are held back deliberately after a
      // failed release, and handing one out could collide with a VM that still holds it.
      .where('state', 'in', ['active', 'quarantined'])
      .execute();
    if (leaseRows.length + 1 > quota.ipv4_addresses) {
      throw new DomainError('QUOTA_EXCEEDED', 'The create request exceeds IPv4 quota.');
    }

    return allocateIpv4(
      {
        cidr: network.ipv4_cidr,
        gateway: network.gateway,
        exclusions: parseJsonColumn<string[]>(network.exclusions),
      },
      new Set(leaseRows.map((row) => row.address)),
    );
  }

  /**
   * Builds every record the acceptance will write. Pure — performs no I/O.
   *
   * Kept separate so the shapes of the API response, the two read-model documents, and the
   * outbox event can be read in one place, without SQL interleaved between them. All records
   * share one `now` and one set of identifiers so the committed state is self-consistent.
   */
  private buildAcceptanceRecords(
    command: CreateInstanceCommand,
    context: AcceptanceContext,
    address: string,
  ): AcceptanceRecords {
    const { flavor, network } = context;
    const now = new Date();
    const instanceId = randomUUID();
    const operationId = randomUUID();
    const eventId = randomUUID();
    const leaseId = randomUUID();
    const occurredAt = now.toISOString();
    const prefixLength = prefixLengthOf(network.ipv4_cidr);

    const accepted: AcceptedMutation = {
      operationId,
      targetId: instanceId,
      acceptedAt: occurredAt,
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
      // Nothing has been observed on the provider yet; the workflow fills this in only after
      // it has proven the VM exists, is owned, and is running.
      observed: null,
      ipv4Lease: { address, prefixLength, gateway: network.gateway, state: 'active' },
      activeOperationId: operationId,
      drift: 'none',
      lastReconciledAt: null,
      retentionDeadline: null,
      purgeEligible: false,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };

    const operation: OperationView = {
      id: operationId,
      projectId: command.projectId,
      action: CREATE_INSTANCE_ACTION,
      targetType: 'instance',
      targetId: instanceId,
      state: 'accepted',
      stage: 'accepted',
      progressPercent: 0,
      acceptedAt: occurredAt,
      startedAt: null,
      updatedAt: occurredAt,
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
      // The operation is the cause of this event; there is no earlier event to point at.
      causationId: operationId,
      correlationId: command.correlationId,
      occurredAt,
      traceContext: {
        traceparent: command.traceparent || generatedTraceparent(),
        ...(command.tracestate ? { tracestate: command.tracestate } : {}),
      },
      // Partitioning by instance is what will preserve per-instance ordering once Kafka
      // replaces the poller in Phase 4.
      partitionKey: instanceId,
      data: {
        imageId: command.imageId,
        flavorId: command.flavorId,
        networkId: command.networkId,
        providerProfileId: context.providerProfileId,
        hostname: command.hostname,
        // Flavor and address are resolved to concrete values here, not left as references.
        // WHY: the workflow runs minutes later and must build exactly what was accepted, even
        // if an operator edits the catalog in the meantime.
        resources: {
          cpuCount: flavor.cpu_count,
          memoryMiB: Number(flavor.memory_mib),
          diskGiB: Number(flavor.minimum_disk_gib),
        },
        ipv4: {
          address,
          prefixLength,
          gateway: network.gateway,
          dnsServers: dnsTuple(parseJsonColumn<string[]>(network.dns_servers)),
        },
        ...(command.sshPublicKeys.length > 0
          ? { sshPublicKeys: sshTuple(command.sshPublicKeys) }
          : {}),
      },
    };

    return {
      instanceId,
      operationId,
      eventId,
      leaseId,
      now,
      address,
      prefixLength,
      accepted,
      instance,
      operation,
      event,
    };
  }

  /**
   * Writes every acceptance record inside the caller's transaction.
   *
   * The outbox row is the reason this must be one transaction: it is what causes a VM to be
   * built. Committing it without the instance row would provision something the control plane
   * does not know about; committing the instance without it would return `202 Accepted` for
   * work that never starts.
   */
  private async writeAcceptanceRecords(
    tx: Tx,
    command: CreateInstanceCommand,
    context: AcceptanceContext,
    records: AcceptanceRecords,
    requestHash: string,
  ): Promise<void> {
    const { instanceId, operationId, now } = records;

    // --- Authoritative write model ------------------------------------------------------
    await tx
      .insertInto('control.instances')
      .values({
        id: instanceId,
        project_id: command.projectId,
        image_id: command.imageId,
        flavor_id: command.flavorId,
        network_id: command.networkId,
        provider_profile_id: context.providerProfileId,
        hostname: command.hostname,
        ssh_public_keys: JSON.stringify(command.sshPublicKeys),
        desired_cpu_count: context.flavor.cpu_count,
        desired_memory_mib: context.flavor.memory_mib,
        desired_disk_gib: context.flavor.minimum_disk_gib,
        desired_power_state: 'running',
        lifecycle_state: 'pending',
        // Set in the follow-up UPDATE below rather than here: the operations table has a
        // foreign key onto instances, so the operation row cannot exist yet.
        active_operation_id: null,
        version: '1',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await tx
      .insertInto('control.operations')
      .values({
        id: operationId,
        project_id: command.projectId,
        action: CREATE_INSTANCE_ACTION,
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
    await tx
      .updateTable('control.instances')
      .set({
        active_operation_id: operationId,
        // Recorded here because this is the operation whose id goes into the provider ownership
        // markers; every later capability has to present it rather than its own.
        create_operation_id: operationId,
      })
      .where('id', '=', instanceId)
      .execute();
    await tx
      .insertInto('control.ipv4_leases')
      .values({
        id: records.leaseId,
        project_id: command.projectId,
        instance_id: instanceId,
        network_id: context.network.id,
        address: records.address,
        prefix_length: records.prefixLength,
        gateway: context.network.gateway,
        state: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    // --- Idempotency record, outbox, and audit trail ------------------------------------
    await tx
      .insertInto('control.idempotency_records')
      .values({
        actor_id: command.actor.subject,
        project_id: command.projectId,
        operation_type: CREATE_INSTANCE_ACTION,
        idempotency_key: command.idempotencyKey,
        target_id: instanceId,
        request_hash: requestHash,
        operation_id: operationId,
        // The exact response body is stored so a replay is byte-identical rather than rebuilt.
        response: records.accepted,
        created_at: now,
        expires_at: new Date(now.getTime() + IDEMPOTENCY_RECORD_TTL_MS),
      })
      .execute();
    await this.writeControlOutbox(tx, records.event, 'provisioning.commands.v1', now);
    await this.writeControlAudit(tx, {
      eventId: randomUUID(),
      projectId: command.projectId,
      operationId,
      correlationId: command.correlationId,
      causationId: operationId,
      occurredAt: now,
      traceContext: records.event.traceContext,
      actorId: command.actor.subject,
      actorRole: 'tenant_developer',
      action: CREATE_INSTANCE_ACTION,
      targetType: 'instance',
      targetId: instanceId,
      outcome: 'accepted',
    });

    // --- Read projections ---------------------------------------------------------------
    // Seeded here rather than by the projection worker so a client that polls immediately
    // after its 202 finds the instance and operation already readable.
    await tx
      .insertInto('projection.instances')
      .values({
        instance_id: instanceId,
        project_id: command.projectId,
        document: records.instance,
        updated_at: now,
      })
      .execute();
    await tx
      .insertInto('projection.operations')
      .values({
        operation_id: operationId,
        project_id: command.projectId,
        target_id: instanceId,
        document: records.operation,
        updated_at: now,
        // WHY seed these at acceptance rather than waiting for the first workflow event: an
        // administrator inspecting a stuck operation is most likely to look before any progress
        // event exists, which is exactly when the correlation and trace would otherwise be null.
        correlation_id: command.correlationId,
        trace_id: traceIdOf(command.traceparent),
        checkpoint: records.operation.stage,
      })
      .execute();
  }

  /** Reads a project, or `null` when it does not exist. */
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
          createdAt: toIsoTimestamp(row.created_at),
          updatedAt: toIsoTimestamp(row.updated_at),
        }
      : null;
  }

  /**
   * Reads quota limits together with freshly measured usage.
   *
   * Usage is computed on every call rather than cached, matching the acceptance check in
   * {@link PostgresControlPlaneStore.assertQuotaHeadroom}. `measuredAt` tells the caller how
   * fresh the numbers are, since they can change between the read and any decision made on it.
   */
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
    const snapshots = await this.db
      .selectFrom('control.snapshots')
      .select((builder) => builder.fn.countAll<number>().as('count'))
      .where('project_id', '=', projectId)
      // A snapshot being deleted still occupies provider storage until the delete completes, so it
      // counts. One that failed does not exist and does not.
      .where('state', 'in', ['creating', 'available', 'rolling_back', 'deleting'])
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
        snapshots: Number(snapshots.count),
      },
      measuredAt: new Date().toISOString(),
    };
  }

  /*
   * Catalog reads below query `control.*` directly rather than a projection. WHY: catalog
   * rows are few, static, and change only through operator action, so the write model is
   * already the right shape to serve. Instances and operations do need projections because
   * their documents merge several tables and change on every workflow event.
   */

  /** Lists enabled catalog images. */
  public async listImages(_projectId: string, page: PageRequest): Promise<Page<ImageView>> {
    const rows = await this.db
      .selectFrom('control.images')
      .selectAll()
      .where('enabled', '=', true)
      .$if(Boolean(page.cursor), (query) => query.where(seekAscending(page.cursor, 'id')))
      .orderBy('id')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({ sortKey: row.id, id: row.id }));
    return {
      items: trimmed.items.map((row) => ({
        id: row.id,
        name: row.name,
        providerProfileId: row.provider_profile_id,
        enabled: row.enabled,
        architecture: row.architecture as 'x86_64' | 'arm64',
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /** Lists enabled catalog flavors. */
  public async listFlavors(_projectId: string, page: PageRequest): Promise<Page<FlavorView>> {
    const rows = await this.db
      .selectFrom('control.flavors')
      .selectAll()
      .where('enabled', '=', true)
      .$if(Boolean(page.cursor), (query) => query.where(seekAscending(page.cursor, 'id')))
      .orderBy('id')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({ sortKey: row.id, id: row.id }));
    return {
      items: trimmed.items.map((row) => ({
        id: row.id,
        name: row.name,
        cpuCount: row.cpu_count,
        memoryMiB: Number(row.memory_mib),
        minimumDiskGiB: Number(row.minimum_disk_gib),
        enabled: row.enabled,
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /**
   * Lists enabled catalog networks, each naming the provider profile it belongs to.
   *
   * WHY the join: acceptance resolves the provider profile through the requested image and then
   * refuses the request unless that profile's network is the one named. A client that cannot see
   * which network belongs to which profile has no way to offer only valid combinations, so it
   * offers invalid ones and the user meets a 400 for a choice the interface presented.
   *
   * A left join, because a network no profile references is still a catalog row — it simply has
   * no pairing to report, and hiding it here would make it invisible rather than unusable.
   */
  public async listNetworks(_projectId: string, page: PageRequest): Promise<Page<NetworkView>> {
    const rows = await this.db
      .selectFrom('control.networks')
      .leftJoin(
        'control.provider_profiles',
        'control.provider_profiles.network_id',
        'control.networks.id',
      )
      .selectAll('control.networks')
      .select('control.provider_profiles.id as provider_profile_id')
      .where('control.networks.enabled', '=', true)
      .$if(Boolean(page.cursor), (query) =>
        query.where(seekAscending(page.cursor, 'control.networks.id')),
      )
      .orderBy('control.networks.id')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({ sortKey: row.id, id: row.id }));
    return {
      items: trimmed.items.map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.provider_profile_id ? { providerProfileId: row.provider_profile_id } : {}),
        ipv4Cidr: row.ipv4_cidr,
        gateway: row.gateway,
        dnsServers: parseJsonColumn<string[]>(row.dns_servers),
        exclusions: parseJsonColumn<string[]>(row.exclusions),
        enabled: row.enabled,
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /*
   * Instance and operation reads below serve pre-built documents from `projection.*`. The
   * document already matches the API contract, so there is no mapping step and no risk of a
   * response drifting from the shape the projection wrote.
   */

  /** Reads one instance from the read projection, or `null`. */
  public async getInstance(projectId: string, instanceId: string): Promise<InstanceView | null> {
    const row = await this.db
      .selectFrom('projection.instances')
      .select('document')
      .where('project_id', '=', projectId)
      .where('instance_id', '=', instanceId)
      .executeTakeFirst();
    return row ? parseJsonColumn<InstanceView>(row.document) : null;
  }

  /** Lists instances from the read projection, most recently updated first. */
  public async listInstances(projectId: string, page: PageRequest): Promise<Page<InstanceView>> {
    const rows = await this.db
      .selectFrom('projection.instances')
      .select(['document', 'updated_at', 'instance_id'])
      .where('project_id', '=', projectId)
      .$if(Boolean(page.cursor), (query) =>
        query.where(seekDescending(page.cursor, 'updated_at', 'instance_id', 'uuid')),
      )
      .orderBy('updated_at', 'desc')
      .orderBy('instance_id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({
      sortKey: toIsoTimestamp(row.updated_at),
      id: row.instance_id,
    }));
    return {
      items: trimmed.items.map((row) => parseJsonColumn<InstanceView>(row.document)),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /** Reads one operation from the read projection, or `null`. */
  public async getOperation(projectId: string, operationId: string): Promise<OperationView | null> {
    const row = await this.db
      .selectFrom('projection.operations')
      .select('document')
      .where('project_id', '=', projectId)
      .where('operation_id', '=', operationId)
      .executeTakeFirst();
    return row ? parseJsonColumn<OperationView>(row.document) : null;
  }

  /** Lists operations from the read projection, most recently updated first. */
  public async listOperations(projectId: string, page: PageRequest): Promise<Page<OperationView>> {
    const rows = await this.db
      .selectFrom('projection.operations')
      .select(['document', 'updated_at', 'operation_id'])
      .where('project_id', '=', projectId)
      .$if(Boolean(page.cursor), (query) =>
        query.where(seekDescending(page.cursor, 'updated_at', 'operation_id', 'uuid')),
      )
      .orderBy('updated_at', 'desc')
      .orderBy('operation_id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({
      sortKey: toIsoTimestamp(row.updated_at),
      id: row.operation_id,
    }));
    return {
      items: trimmed.items.map((row) => parseJsonColumn<OperationView>(row.document)),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /**
   * Reads one operation with recovery metadata, across every project.
   *
   * WHY no project filter: this route exists because the tenant operation route requires
   * project membership, which the administrator who authorized a replay usually does not have.
   * Re-imposing the filter here would recreate the hole it was added to close. Authorization is
   * the administrator role check in `ControlPlaneApplication`, not a membership test.
   */
  public async getAdministrativeOperation(
    operationId: string,
  ): Promise<AdministrativeOperationView | null> {
    const row = await this.db
      .selectFrom('projection.operations')
      .select([
        'document',
        'correlation_id',
        'causation_id',
        'trace_id',
        'retry_count',
        'checkpoint',
        'dead_letter_event_id',
        'provider_task_reference',
      ])
      .where('operation_id', '=', operationId)
      .executeTakeFirst();
    if (!row) return null;
    const operation = parseJsonColumn<OperationView>(row.document);
    return {
      ...operation,
      // Spread-conditional so an absent value is omitted rather than sent as `undefined`,
      // which would serialise differently from the `null` the schema declares.
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      causationId: row.causation_id,
      traceId: row.trace_id,
      retryCount: row.retry_count,
      checkpoint: row.checkpoint ?? operation.stage,
      deadLetterEventId: row.dead_letter_event_id,
      providerTaskReference: row.provider_task_reference,
    };
  }

  /**
   * Lists attributed audit facts, most recent first.
   *
   * `reason` is deliberately absent. The free-text justification an administrator supplies with
   * a replay is restricted and stays in `control.replay_requests`; publishing it on the audit
   * list would widen its audience from the one administrator who can read that request to every
   * administrator who can list audit events. The contract makes the field optional for exactly
   * this reason.
   */
  public async listAuditEvents(
    filter: AuditEventFilter,
    page: PageRequest,
  ): Promise<Page<AuditEventView>> {
    const rows = await this.db
      .selectFrom('audit.entries')
      .selectAll()
      .$if(Boolean(filter.projectId), (query) =>
        query.where('project_id', '=', filter.projectId ?? ''),
      )
      .$if(Boolean(filter.operationId), (query) =>
        query.where('operation_id', '=', filter.operationId ?? ''),
      )
      .$if(Boolean(page.cursor), (query) =>
        query.where(seekDescending(page.cursor, 'occurred_at', 'id', 'uuid')),
      )
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const trimmed = paginate(rows, page.limit, (row) => ({
      sortKey: toIsoTimestamp(row.occurred_at),
      id: row.id,
    }));
    return {
      items: trimmed.items.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorRole: auditActorRole(row.actor_role),
        projectId: row.project_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        operationId: row.operation_id,
        outcome: auditOutcome(row.outcome),
        occurredAt: toIsoTimestamp(row.occurred_at),
      })),
      page: { limit: page.limit, nextCursor: trimmed.nextCursor },
    };
  }

  /** Appends a command under a dedicated child span inside its owning transaction. */
  private writeControlOutbox(
    tx: Tx,
    event: EventEnvelope,
    topic: 'provisioning.commands.v1' | 'audit.events.v1',
    now: Date,
  ): Promise<unknown> {
    return this.telemetry.trace(
      'controlplane.outbox.write',
      { 'outbox.owner': 'control', 'event.schema.name': event.schemaName },
      () =>
        tx
          .insertInto('control.outbox')
          .values({
            outbox_id: randomUUID(),
            event_id: event.eventId,
            aggregate_id: event.aggregateId,
            aggregate_type: event.aggregateType,
            schema_name: event.schemaName,
            schema_version: event.schemaVersion,
            topic,
            partition_key: event.partitionKey,
            payload: event,
            tracingspancontext: serializeDebeziumTraceContext(event.traceContext),
            replay_generation: 0,
            occurred_at: now,
            created_at: now,
          })
          .executeTakeFirstOrThrow(),
    );
  }

  /** Appends the relational audit row and its archive event in the same owner transaction. */
  private async writeControlAudit(
    tx: Tx,
    input: Parameters<typeof auditRecordedEvent>[0],
  ): Promise<void> {
    const event: AuditRecordedV1 = auditRecordedEvent(input);
    await tx
      .insertInto('audit.entries')
      .values({
        id: event.eventId,
        project_id: event.projectId,
        actor_id: event.data.actorId,
        actor_role: event.data.actorRole,
        action: event.data.action,
        target_type: event.data.targetType,
        target_id: event.data.targetId,
        outcome: event.data.outcome,
        operation_id: event.operationId,
        occurred_at: input.occurredAt,
      })
      .executeTakeFirstOrThrow();
    await this.writeControlOutbox(tx, event, 'audit.events.v1', input.occurredAt);
  }
}

/**
 * Builds the seek predicate for a page ordered by `(sortColumn DESC, idColumn DESC)`.
 *
 * WHY the row-value comparison rather than `sortColumn < x OR (sortColumn = x AND id < y)`: the
 * two are logically identical, but only the row-value form is recognised by PostgreSQL as an
 * index range condition. The disjunction degrades to a filter over the whole ordered set, which
 * is precisely the cost keyset pagination exists to avoid.
 *
 * @param cursor Opaque token from the previous page; the caller guarantees it is present.
 * @param sortColumn Leading order column, cast on the parameter side to match its type.
 * @param idColumn Primary key breaking ties on `sortColumn`.
 * @param idType PostgreSQL type of `idColumn`, needed so the parameter compares without a scan.
 * @throws DomainError `VALIDATION_FAILED` when the cursor was not issued by this service.
 */
function seekDescending(
  cursor: string | undefined,
  sortColumn: string,
  idColumn: string,
  idType: 'uuid' | 'text',
): RawBuilder<SqlBool> {
  const position = decodePageCursor(cursor ?? '');
  return sql<SqlBool>`(${sql.ref(sortColumn)}, ${sql.ref(idColumn)}) < (${position.sortKey}::timestamptz, ${sql.lit(position.id)}::${sql.raw(idType)})`;
}

/**
 * Builds the seek predicate for a page ordered by a single ascending identifier.
 *
 * The catalog tables are ordered by their slug, which is already unique, so no tiebreaker
 * column is needed and a plain comparison suffices.
 *
 * @throws DomainError `VALIDATION_FAILED` when the cursor was not issued by this service.
 */
function seekAscending(cursor: string | undefined, idColumn: string): RawBuilder<SqlBool> {
  const position = decodePageCursor(cursor ?? '');
  return sql<SqlBool>`${sql.ref(idColumn)} > ${position.id}`;
}

/**
 * Narrows a stored actor role to the published enumeration.
 *
 * WHY not a bare cast: the column is free text, and a role written by an older or future
 * deployment would otherwise be published as a value the client's generated type says is
 * impossible. Falling back to `service` keeps the response schema-valid; the audit row itself
 * is unchanged and still holds the original text for forensic reads.
 */
function auditActorRole(value: string): AuditEventView['actorRole'] {
  const roles: readonly AuditEventView['actorRole'][] = [
    'tenant_developer',
    'platform_operator',
    'platform_administrator',
    'service',
  ];
  return roles.find((role) => role === value) ?? 'service';
}

/** Narrows a stored audit outcome to the published enumeration, defaulting to `rejected`. */
function auditOutcome(value: string): AuditEventView['outcome'] {
  const outcomes: readonly AuditEventView['outcome'][] = [
    'accepted',
    'succeeded',
    'rejected',
    'failed',
  ];
  return outcomes.find((outcome) => outcome === value) ?? 'rejected';
}

/**
 * Extracts the 32-character trace ID from a W3C `traceparent`.
 *
 * Returns `null` for anything malformed. Acceptance must never fail because a caller sent an
 * unusable trace header; the request itself is still valid intent.
 */
function traceIdOf(traceparent: string | undefined): string | null {
  if (!traceparent) return null;
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
  return match?.[1] ?? null;
}
