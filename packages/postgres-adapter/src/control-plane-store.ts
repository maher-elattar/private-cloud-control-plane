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
import { NOOP_APPLICATION_TELEMETRY } from '@private-cloud/application';
import type {
  AcceptedMutation,
  ApplicationTelemetry,
  ApplicationTraceContext,
  ControlPlaneStore,
  CreateInstanceCommand,
  DeadLetterView,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  Page,
  ProjectView,
  QuotaView,
  ReplayDeadLetterCommand,
} from '@private-cloud/application';
import type {
  AuditRecordedV1,
  EventEnvelope,
  InstanceCreateRequestedV1,
  ProvisioningReplayRequestedV1,
} from '@private-cloud/contracts';
import { allocateIpv4, DomainError } from '@private-cloud/domain';
import { sql, type Transaction } from 'kysely';
import { parseJsonColumn, toIsoTimestamp } from './column-codec.js';
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
          await this.lockIdempotencyScope(tx, command);

          const replayed = await this.findReplayedResponse(tx, command, requestHash);
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

  /** Lists the Kafka-projected dead-letter view without exposing original payloads. */
  public async listDeadLetters(limit: number): Promise<Page<DeadLetterView>> {
    const rows = await this.db
      .selectFrom('projection.dead_letters')
      .select('document')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => parseJsonColumn<DeadLetterView>(row.document)),
      page: { limit, nextCursor: null },
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
  private async lockIdempotencyScope(tx: Tx, command: CreateInstanceCommand): Promise<void> {
    const scope = [
      command.actor.subject,
      command.projectId,
      CREATE_INSTANCE_ACTION,
      command.idempotencyKey,
    ].join(':');
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
    command: CreateInstanceCommand,
    requestHash: string,
  ): Promise<AcceptedMutation | null> {
    const previous = await tx
      .selectFrom('control.idempotency_records')
      .select(['request_hash', 'response'])
      .where('actor_id', '=', command.actor.subject)
      .where('project_id', '=', command.projectId)
      .where('operation_type', '=', CREATE_INSTANCE_ACTION)
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
      .set({ active_operation_id: operationId })
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
        // Snapshots are out of scope for Phase 3; the field is published as zero rather than
        // omitted so the response always matches the contract.
        snapshots: 0,
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
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
      page: { limit, nextCursor: null },
    };
  }

  /** Lists enabled catalog flavors. */
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
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
      page: { limit, nextCursor: null },
    };
  }

  /** Lists enabled catalog networks. */
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
        dnsServers: parseJsonColumn<string[]>(row.dns_servers),
        exclusions: parseJsonColumn<string[]>(row.exclusions),
        enabled: row.enabled,
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
      page: { limit, nextCursor: null },
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
  public async listInstances(projectId: string, limit: number): Promise<Page<InstanceView>> {
    const rows = await this.db
      .selectFrom('projection.instances')
      .select('document')
      .where('project_id', '=', projectId)
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => parseJsonColumn<InstanceView>(row.document)),
      page: { limit, nextCursor: null },
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
  public async listOperations(projectId: string, limit: number): Promise<Page<OperationView>> {
    const rows = await this.db
      .selectFrom('projection.operations')
      .select('document')
      .where('project_id', '=', projectId)
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return {
      items: rows.map((row) => parseJsonColumn<OperationView>(row.document)),
      page: { limit, nextCursor: null },
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
