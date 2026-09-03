/**
 * PostgreSQL adapter for the `WorkflowStore` port.
 *
 * PATTERN — Inbox, lease with fencing token, and transactional outbox, working together:
 *
 * - **Inbox.** {@link PostgresWorkflowStore.receiveCommand} converts an accepted command from
 *   `control.outbox` into a workflow exactly once, recording its event ID in
 *   `workflow.command_receipts`. A redelivered command finds its receipt and is ignored.
 * - **Lease + fencing.** One instance is handed to one worker at a time, with a monotonic
 *   token proving the claim is current. A worker that stalled past its lease is rejected.
 * - **Outbox.** Every stage change writes its explaining event in the same transaction, so
 *   the stage and the event that justifies it can never disagree.
 *
 * WHY all three: provisioning is the one place where a duplicate action costs real money and
 * cannot be undone. Each pattern closes a different door — duplicate delivery, concurrent
 * workers, and partial writes respectively.
 *
 * @see docs/architecture/glossary.md#lease-and-fencing-token
 * @see docs/architecture/phase-3-persistence.md
 */
import { randomUUID } from 'node:crypto';
import {
  NOOP_APPLICATION_TELEMETRY,
  isInstanceCreateRequestedV1,
  isProvisioningReplayRequestedV1,
  toWorkflowStage,
  type ClaimedCreateWorkflow,
  type ApplicationTelemetry,
  type MessageDeliveryIdentity,
  type WorkflowEvent,
  type WorkflowStore,
} from '@private-cloud/application';
import type {
  EventEnvelope,
  InstanceCreateRequestedV1,
  ProvisioningDeadLetteredV1,
  ProvisioningReplayResolvedV1,
  ProvisioningReplayRequestedV1,
} from '@private-cloud/contracts';
import { canonicalSha256 } from '@private-cloud/domain';
import { sql, type Transaction } from 'kysely';
import { parseJsonColumn } from './column-codec.js';
import type { PostgresClient, PostgresDatabase } from './database.js';
import { serializeDebeziumTraceContext } from './trace-carrier.js';
import { auditRecordedEvent } from './audit-event.js';

/** Identifies this consumer in `workflow.command_receipts`. */
const CONSUMER_NAME = 'provisioning-orchestrator.v1';

/** Shortest lease a caller may request. Below this, normal provider latency outlives it. */
const MINIMUM_LEASE_SECONDS = 5;
/** Longest lease a caller may request. Above this, a dead worker blocks an instance too long. */
const MAXIMUM_LEASE_SECONDS = 300;

/**
 * Validates and narrows a command replayed from the outbox.
 *
 * WHY it is checked rather than cast: the payload is `jsonb` written by another service and
 * possibly by an older version of it. Rejecting a malformed command at the boundary is far
 * cheaper than discovering a missing field midway through provisioning, when a VM may already
 * exist.
 *
 * Returns `null` while the current deployment does not support the stored command contract.
 */
function createCommand(value: unknown): InstanceCreateRequestedV1 | null {
  const command = parseJsonColumn<EventEnvelope & { readonly data?: unknown }>(value);
  return isInstanceCreateRequestedV1(command) ? command : null;
}

/** Validates the attributed request retained until its authorized command is broker-delivered. */
function storedReplayRequest(value: unknown): ProvisioningReplayRequestedV1 | null {
  const request = parseJsonColumn<EventEnvelope & { readonly data?: unknown }>(value);
  return isProvisioningReplayRequestedV1(request) ? request : null;
}

/** A row of `workflow.workflows` as returned by the raw claim queries. */
interface WorkflowRow {
  readonly operation_id: string;
  readonly event_id: string;
  readonly instance_id: string;
  readonly command: unknown;
  readonly stage: string;
  readonly attempt: number;
  readonly stage_attempt: number;
  readonly retry_started_at: Date | null;
  readonly replay_generation: number;
  readonly trace_context: unknown;
  readonly fencing_token: string;
  readonly provider_resource_id: string | null;
  readonly provider_task_reference: string | null;
}

/** Open transaction handle passed between the private steps. */
type Tx = Transaction<PostgresDatabase>;

/**
 * Leased, fenced workflow persistence backed by PostgreSQL.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */
export class PostgresWorkflowStore implements WorkflowStore {
  /** @param db Kysely client owned by the orchestrator's DI container. */
  public constructor(
    private readonly db: PostgresClient,
    private readonly telemetry: ApplicationTelemetry = NOOP_APPLICATION_TELEMETRY,
  ) {}

  /** Records the Kafka delivery and creates a resumable workflow in one transaction. */
  public admitCreateCommand(
    command: InstanceCreateRequestedV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'accepted' | 'duplicate' | 'rejected'> {
    return this.db
      .transaction()
      .execute((tx) =>
        delivery.replayGeneration === 0
          ? this.admitCommand(tx, command, delivery)
          : this.admitAuthorizedReplayCommand(tx, command, delivery),
      );
  }

  /** Authorizes a replay and publishes the restored command through the transactional outbox. */
  public admitReplayRequest(
    request: ProvisioningReplayRequestedV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'accepted' | 'duplicate' | 'rejected'> {
    return this.db.transaction().execute(async (tx) => {
      const now = new Date();
      const receipt = await this.insertCommandReceipt(tx, request, delivery, now);
      if (!receipt) return 'duplicate';

      const deadLetter = await tx
        .selectFrom('workflow.dead_letters')
        .selectAll()
        .where('original_event_id', '=', request.data.originalEventId)
        .forUpdate()
        .executeTakeFirst();
      const original = deadLetter ? createCommand(deadLetter.original_payload) : null;
      if (!deadLetter || !deadLetter.replay_allowed || deadLetter.status !== 'open' || !original) {
        await this.persistReplayRequest(tx, request, 'rejected', now);
        await this.writeReplayResolution(
          tx,
          request,
          'rejected',
          deadLetter?.replay_generation ?? 0,
          now,
        );
        await this.writeServiceAudit(tx, request, 'replay_dead_letter', 'rejected', now, {
          reasonReference: request.data.replayRequestId,
        });
        return 'rejected';
      }

      const replayGeneration = deadLetter.replay_generation + 1;
      const replayed: InstanceCreateRequestedV1 = {
        ...original,
        correlationId: request.correlationId,
        causationId: request.eventId,
        occurredAt: now.toISOString(),
        traceContext: request.traceContext,
      };
      const authorizedOutboxId = randomUUID();
      await this.persistReplayRequest(tx, request, 'authorized', now, {
        replayGeneration,
        authorizedCommandHash: canonicalSha256(replayed),
        authorizedOutboxId,
      });
      await this.writeWorkflowOutbox(tx, replayed, 'provisioning.commands.v1', now, {
        outboxId: authorizedOutboxId,
        replayGeneration,
      });
      await tx
        .updateTable('workflow.dead_letters')
        .set({
          replay_generation: replayGeneration,
          status: 'replay_requested',
          last_replay_at: now,
        })
        .where('original_event_id', '=', original.eventId)
        .where('status', '=', 'open')
        .executeTakeFirstOrThrow();
      await this.writeServiceAudit(tx, request, 'replay_dead_letter', 'accepted', now, {
        reasonReference: request.data.replayRequestId,
      });
      return 'accepted';
    });
  }

  /** Quarantines an undecodable record by hash and broker coordinates, never by raw value. */
  public quarantineRecord(
    input: Parameters<WorkflowStore['quarantineRecord']>[0],
  ): Promise<'quarantined' | 'duplicate'> {
    return this.db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto('workflow.poison_records')
        .values({
          id: randomUUID(),
          consumer_name: CONSUMER_NAME,
          source_topic: input.delivery.topic,
          source_partition: input.delivery.partition,
          source_offset: input.delivery.offset,
          payload_hash: input.payloadHash,
          failure_code: input.failureCode,
          safe_message: input.safeMessage,
          quarantined_at: new Date(),
        })
        .onConflict((conflict) =>
          conflict
            .columns(['consumer_name', 'source_topic', 'source_partition', 'source_offset'])
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      return inserted ? 'quarantined' : 'duplicate';
    });
  }

  /** Stores DLQ evidence and publishes its governed event through the workflow outbox. */
  public deadLetterCommand(
    input: Parameters<WorkflowStore['deadLetterCommand']>[0],
  ): Promise<'dead_lettered' | 'duplicate'> {
    return this.db.transaction().execute(async (tx) => {
      const now = new Date();
      const receipt = await this.insertCommandReceipt(tx, input.event, input.delivery, now);
      if (!receipt) return 'duplicate';
      await this.writeDeadLetter(tx, {
        original: input.event,
        traceContext: input.event.traceContext,
        failureCategory: 'permanent',
        failureCode: input.failureCode,
        safeMessage: input.safeMessage,
        attempts: input.attempts,
        replayAllowed: input.replayAllowed,
        replayGeneration: input.delivery.replayGeneration,
        now,
      });
      await this.writeServiceAudit(tx, input.event, 'dead_letter_command', 'failed', now);
      return 'dead_lettered';
    });
  }

  /**
   * Claims the next ready workflow, admitting a new command if none is in flight.
   *
   * Three things happen in one transaction: find work (either a workflow due for its next
   * transition, or an unconsumed command to convert into one), take an exclusive lease on the
   * instance, and bump the attempt counter.
   *
   * The lease `INSERT … ON CONFLICT DO UPDATE` is the interesting part. Its `WHERE` clause
   * fires only when the existing lease has expired or this worker already owns it, so a lease
   * held by a live worker blocks the claim. When it does fire, `fencing_token` increments —
   * which is what invalidates the previous holder even if that worker is still running and
   * unaware it lost the lease.
   *
   * @returns The claim, or `null` when nothing is ready or the lease could not be taken.
   * @see WorkflowStore.claimNextCreate for the caller's obligations.
   */
  public claimNextCreate(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ClaimedCreateWorkflow | null> {
    if (
      !workerId ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < MINIMUM_LEASE_SECONDS ||
      leaseSeconds > MAXIMUM_LEASE_SECONDS
    ) {
      throw new Error('A worker ID and a lease between 5 and 300 seconds are required.');
    }
    return this.db.transaction().execute(async (tx) => {
      // In-flight work first, so a backlog of new commands cannot starve workflows that have
      // already started — and already have a VM part-built on the provider.
      const workflow = await this.readyWorkflow(tx, workerId);
      if (!workflow) return null;

      const lease = await sql<{ fencing_token: string }>`
        INSERT INTO workflow.instance_leases (
          instance_id, owner_id, fencing_token, leased_until, updated_at
        ) VALUES (
          ${workflow.instance_id}::uuid, ${workerId}, 1,
          now() + (${leaseSeconds} * interval '1 second'), now()
        )
        ON CONFLICT (instance_id) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          fencing_token = workflow.instance_leases.fencing_token + 1,
          leased_until = EXCLUDED.leased_until,
          updated_at = now()
        WHERE workflow.instance_leases.leased_until <= now()
           OR workflow.instance_leases.owner_id = ${workerId}
        RETURNING fencing_token
      `.execute(tx);
      // No row returned means the WHERE above did not match: another worker holds a live
      // lease. Give up this round rather than waiting; there may be other work to do.
      const fencingToken = lease.rows[0]?.fencing_token;
      if (!fencingToken) return null;

      const claimed = await tx
        .updateTable('workflow.workflows')
        .set((builder) => ({
          status: 'running',
          attempt: builder('attempt', '+', 1),
          fencing_token: fencingToken,
          updated_at: new Date(),
        }))
        .where('operation_id', '=', workflow.operation_id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const command = createCommand(claimed.command);
      if (!command) {
        // Workflow rows are admitted only after validation. Reaching this branch means stored
        // state was corrupted or written by an incompatible deployment, so no provider call is safe.
        throw new Error('The persisted create workflow is not supported by this deployment.');
      }

      return {
        command,
        traceContext: parseJsonColumn<InstanceCreateRequestedV1['traceContext']>(
          claimed.trace_context,
        ),
        stage: toWorkflowStage(claimed.stage),
        attempt: claimed.attempt,
        stageAttempt: claimed.stage_attempt,
        ...(claimed.retry_started_at ? { retryStartedAt: claimed.retry_started_at } : {}),
        // `bigint` because the token is a Postgres `bigint` and must not lose precision; the
        // driver hands it over as a string to avoid a lossy number conversion.
        fencingToken: BigInt(claimed.fencing_token),
        ...(claimed.provider_resource_id
          ? { providerResourceId: claimed.provider_resource_id }
          : {}),
        ...(claimed.provider_task_reference
          ? { providerTaskReference: claimed.provider_task_reference }
          : {}),
      };
    });
  }

  /**
   * Advances the stage, records the explaining event, and releases the lease.
   *
   * The lease is released deliberately at the end of every checkpoint. It makes each
   * transition independently durable and lets any worker pick up the next one — which is what
   * allows the orchestrator to be restarted or scaled without special handling.
   *
   * @see WorkflowStore.checkpoint for the contract.
   */
  public checkpoint(input: Parameters<WorkflowStore['checkpoint']>[0]): Promise<void> {
    return this.db.transaction().execute(async (tx) => {
      const workflow = await this.assertLease(tx, input);
      const nextAttemptAt = input.nextAttemptAt ?? new Date();
      await tx
        .updateTable('workflow.workflows')
        .set({
          // A caller-supplied delay is the signal that this is a backoff rather than forward
          // progress, so the row is parked in `retry_wait` until that moment passes.
          status: input.nextAttemptAt ? 'retry_wait' : 'running',
          stage: input.stage,
          ...(input.providerResourceId ? { provider_resource_id: input.providerResourceId } : {}),
          // `in` rather than a truthiness check: an explicit `null` clears a finished task,
          // while omitting the key leaves the existing reference untouched.
          ...('providerTaskReference' in input
            ? { provider_task_reference: input.providerTaskReference ?? null }
            : {}),
          next_attempt_at: nextAttemptAt,
          stage_attempt: input.retry?.attempt ?? 0,
          retry_started_at: input.retry?.startedAt ?? null,
          last_error_category: input.retry?.errorCategory ?? null,
          last_error_code: input.retry?.errorCode ?? null,
          trace_context: input.event.traceContext,
          updated_at: new Date(),
        })
        .where('operation_id', '=', input.operationId)
        // Belt and braces alongside assertLease: even if the lease were somehow taken between
        // the check and here, a stale token matches no row and the update throws.
        .where('fencing_token', '=', String(input.fencingToken))
        .executeTakeFirstOrThrow();
      await this.writeEvent(tx, input.event);
      await this.releaseLease(tx, workflow.instance_id, input);
    });
  }

  /** Terminates an exhausted safe retry and emits operation plus DLQ facts atomically. */
  public deadLetterWorkflow(
    input: Parameters<WorkflowStore['deadLetterWorkflow']>[0],
  ): Promise<void> {
    return this.db.transaction().execute(async (tx) => {
      const workflow = await this.assertLease(tx, input);
      const command = createCommand(workflow.command);
      if (!command) throw new Error('Cannot dead-letter an invalid persisted workflow command.');
      const now = new Date();
      const failure = input.event.data.failure;

      await tx
        .updateTable('workflow.workflows')
        .set({
          status: 'failed',
          stage: 'failed',
          stage_attempt: input.attempts,
          next_attempt_at: now,
          failure_category: failure.category,
          failure_code: failure.code,
          failure_message: failure.safeMessage,
          last_error_category: input.lastErrorCategory,
          last_error_code: input.lastErrorCode,
          trace_context: input.event.traceContext,
          completed_at: now,
          updated_at: now,
        })
        .where('operation_id', '=', input.operationId)
        .where('fencing_token', '=', String(input.fencingToken))
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('workflow.command_receipts')
        .set({ completed_at: now })
        .where('event_id', '=', workflow.event_id)
        .where('consumer_name', '=', CONSUMER_NAME)
        .where('replay_generation', '=', workflow.replay_generation)
        .executeTakeFirstOrThrow();
      await this.writeEvent(tx, input.event);
      await this.writeDeadLetter(tx, {
        original: command,
        traceContext: input.event.traceContext,
        failureCategory: failure.category,
        failureCode: input.failureCode,
        safeMessage: input.safeMessage,
        attempts: input.attempts,
        replayAllowed: true,
        replayGeneration: workflow.replay_generation,
        now,
      });
      await this.writeServiceAudit(tx, input.event, 'provisioning_retry_exhausted', 'failed', now);
      await this.releaseLease(tx, workflow.instance_id, input);
    });
  }

  /**
   * Terminates the workflow and marks its command receipt consumed.
   *
   * Completing the receipt is what stops the command being re-admitted by the inbox. It
   * happens here, at the end, rather than at admission — so a workflow interrupted midway is
   * still recognised as in progress rather than as new work.
   *
   * @see WorkflowStore.complete for the contract.
   */
  public complete(input: Parameters<WorkflowStore['complete']>[0]): Promise<void> {
    return this.db.transaction().execute(async (tx) => {
      const workflow = await this.assertLease(tx, input);
      const now = new Date();
      const failed =
        input.event.schemaName === 'instance.mutation.failed' ? input.event.data.failure : null;
      await tx
        .updateTable('workflow.workflows')
        .set({
          status: input.status,
          // On failure the stage records *how* it ended, so an operator triaging a
          // `manual_review` row can see it terminated for review rather than plain failure.
          stage: input.status === 'succeeded' ? 'completed' : input.status,
          next_attempt_at: now,
          failure_category: failed?.category ?? null,
          failure_code: failed?.code ?? null,
          failure_message: failed?.safeMessage ?? null,
          trace_context: input.event.traceContext,
          completed_at: now,
          updated_at: now,
        })
        .where('operation_id', '=', input.operationId)
        .where('fencing_token', '=', String(input.fencingToken))
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('workflow.command_receipts')
        .set({ completed_at: now })
        .where('event_id', '=', workflow.event_id)
        .where('consumer_name', '=', CONSUMER_NAME)
        .where('replay_generation', '=', workflow.replay_generation)
        .executeTakeFirstOrThrow();
      await this.writeEvent(tx, input.event);
      await this.writeServiceAudit(
        tx,
        input.event,
        'create_instance',
        input.status === 'succeeded' ? 'succeeded' : 'failed',
        now,
      );
      await this.releaseLease(tx, workflow.instance_id, input);
    });
  }

  /**
   * Finds a workflow due for its next transition.
   *
   * `FOR UPDATE OF w SKIP LOCKED` is what makes multiple orchestrator replicas safe: each
   * worker locks a different row and skips rows already locked, instead of queueing behind
   * them. The join to `instance_leases` filters out instances another worker still holds, so
   * the lease attempt that follows is unlikely to be wasted.
   */
  private async readyWorkflow(tx: Tx, workerId: string): Promise<WorkflowRow | null> {
    const result = await sql<WorkflowRow>`
      SELECT w.*
      FROM workflow.workflows w
      LEFT JOIN workflow.instance_leases l ON l.instance_id = w.instance_id
      WHERE w.status IN ('running', 'retry_wait')
        AND w.next_attempt_at <= now()
        AND (l.instance_id IS NULL OR l.leased_until <= now() OR l.owner_id = ${workerId})
      ORDER BY w.next_attempt_at, w.created_at
      FOR UPDATE OF w SKIP LOCKED
      LIMIT 1
    `.execute(tx);
    return result.rows[0] ?? null;
  }

  /** Inserts the command inbox receipt and initial workflow as one atomic admission. */
  private async admitCommand(
    tx: Tx,
    command: InstanceCreateRequestedV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'accepted' | 'duplicate'> {
    const now = new Date();
    const existing = await tx
      .selectFrom('workflow.workflows')
      .select(['operation_id', 'status', 'replay_generation'])
      .where('operation_id', '=', command.operationId)
      .executeTakeFirst();
    if (existing) {
      await this.insertCommandReceipt(tx, command, delivery, now);
      return 'duplicate';
    }

    const receipt = await this.insertCommandReceipt(tx, command, delivery, null);
    if (!receipt) return 'duplicate';

    await tx
      .insertInto('workflow.workflows')
      .values({
        operation_id: command.operationId,
        event_id: command.eventId,
        project_id: command.projectId,
        instance_id: command.aggregateId,
        // The command is stored on the workflow so every later transition replays the exact
        // request that was accepted, even if the catalog it referenced has since changed.
        command,
        status: 'running',
        stage: 'accepted',
        // Zero because the claim in progress will immediately increment it to 1.
        attempt: 0,
        stage_attempt: 0,
        retry_started_at: null,
        replay_generation: delivery.replayGeneration,
        trace_context: command.traceContext,
        fencing_token: '0',
        provider_resource_id: null,
        provider_task_reference: null,
        next_attempt_at: now,
        failure_category: null,
        failure_code: null,
        failure_message: null,
        last_error_category: null,
        last_error_code: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .executeTakeFirstOrThrow();
    return 'accepted';
  }

  /** Reopens a failed workflow only after the authorized command returns through Kafka. */
  private async admitAuthorizedReplayCommand(
    tx: Tx,
    command: InstanceCreateRequestedV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'accepted' | 'duplicate' | 'rejected'> {
    const payloadHash = canonicalSha256(command);
    const existingReceipt = await tx
      .selectFrom('workflow.command_receipts')
      .select('payload_hash')
      .where('consumer_name', '=', CONSUMER_NAME)
      .where('event_id', '=', command.eventId)
      .where('replay_generation', '=', delivery.replayGeneration)
      .executeTakeFirst();
    if (existingReceipt) {
      if (existingReceipt.payload_hash === payloadHash) return 'duplicate';
      await this.rejectReplayCommand(tx, delivery, payloadHash, 'REPLAY_COMMAND_IDENTITY_CONFLICT');
      return 'rejected';
    }

    const authorization = await tx
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', command.eventId)
      .where('replay_generation', '=', delivery.replayGeneration)
      .forUpdate()
      .executeTakeFirst();
    const authorized =
      authorization?.status === 'authorized' &&
      authorization.authorized_command_hash === payloadHash &&
      authorization.authorized_outbox_id === delivery.outboxId;
    if (!authorized) {
      await this.rejectReplayCommand(tx, delivery, payloadHash, 'REPLAY_COMMAND_UNAUTHORIZED');
      return 'rejected';
    }

    const request = storedReplayRequest(authorization.request_payload);
    if (!request) throw new Error('Stored replay authorization payload is invalid.');
    const workflow = await tx
      .selectFrom('workflow.workflows')
      .select(['event_id', 'operation_id', 'status', 'replay_generation'])
      .where('operation_id', '=', command.operationId)
      .forUpdate()
      .executeTakeFirst();
    if (
      workflow &&
      (workflow.event_id !== command.eventId ||
        workflow.status !== 'failed' ||
        delivery.replayGeneration !== workflow.replay_generation + 1)
    ) {
      throw new Error('Authorized replay cannot reopen the current workflow state.');
    }

    const now = new Date();
    const receipt = await this.insertCommandReceipt(tx, command, delivery, null);
    if (!receipt) return 'duplicate';
    if (workflow) {
      // The replay is a fresh provider attempt. Clearing stale handles ensures the idempotency key,
      // rather than an ambiguous pre-exhaustion task reference, determines provider-effect safety.
      await tx
        .updateTable('workflow.workflows')
        .set({
          command,
          status: 'running',
          stage: 'accepted',
          attempt: 0,
          stage_attempt: 0,
          retry_started_at: null,
          replay_generation: delivery.replayGeneration,
          trace_context: command.traceContext,
          provider_resource_id: null,
          provider_task_reference: null,
          next_attempt_at: now,
          failure_category: null,
          failure_code: null,
          failure_message: null,
          last_error_category: null,
          last_error_code: null,
          updated_at: now,
          completed_at: null,
        })
        .where('operation_id', '=', command.operationId)
        .executeTakeFirstOrThrow();
    } else {
      // Compatibility dead letters can occur before workflow admission. Their authorized replay
      // starts the workflow for the first time, still carrying generation one and real coordinates.
      await tx
        .insertInto('workflow.workflows')
        .values({
          operation_id: command.operationId,
          event_id: command.eventId,
          project_id: command.projectId,
          instance_id: command.aggregateId,
          command,
          status: 'running',
          stage: 'accepted',
          attempt: 0,
          stage_attempt: 0,
          retry_started_at: null,
          replay_generation: delivery.replayGeneration,
          trace_context: command.traceContext,
          fencing_token: '0',
          provider_resource_id: null,
          provider_task_reference: null,
          next_attempt_at: now,
          failure_category: null,
          failure_code: null,
          failure_message: null,
          last_error_category: null,
          last_error_code: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        })
        .executeTakeFirstOrThrow();
    }
    await tx
      .updateTable('workflow.dead_letters')
      .set({ status: 'replayed', last_replay_at: now })
      .where('original_event_id', '=', command.eventId)
      .where('status', '=', 'replay_requested')
      .where('replay_generation', '=', delivery.replayGeneration)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('workflow.replay_requests')
      .set({ status: 'completed', completed_at: now })
      .where('replay_request_id', '=', authorization.replay_request_id)
      .where('status', '=', 'authorized')
      .executeTakeFirstOrThrow();
    await this.writeReplayResolution(tx, request, 'completed', delivery.replayGeneration, now);
    return 'accepted';
  }

  /** Persists a rejected physical replay by hash and coordinates without retaining its payload. */
  private async rejectReplayCommand(
    tx: Tx,
    delivery: MessageDeliveryIdentity,
    payloadHash: string,
    failureCode: 'REPLAY_COMMAND_IDENTITY_CONFLICT' | 'REPLAY_COMMAND_UNAUTHORIZED',
  ): Promise<void> {
    await tx
      .insertInto('workflow.poison_records')
      .values({
        id: randomUUID(),
        consumer_name: CONSUMER_NAME,
        source_topic: delivery.topic,
        source_partition: delivery.partition,
        source_offset: delivery.offset,
        payload_hash: payloadHash,
        failure_code: failureCode,
        safe_message: 'The replay command did not match a durable replay authorization.',
        quarantined_at: new Date(),
      })
      .onConflict((conflict) =>
        conflict
          .columns(['consumer_name', 'source_topic', 'source_partition', 'source_offset'])
          .doNothing(),
      )
      .executeTakeFirst();
  }

  /** Inserts one physical command receipt after the owner transaction commits. */
  private async insertCommandReceipt(
    tx: Tx,
    event: EventEnvelope,
    delivery: MessageDeliveryIdentity,
    completedAt: Date | null,
  ): Promise<boolean> {
    const receipt = await tx
      .insertInto('workflow.command_receipts')
      .values({
        event_id: event.eventId,
        consumer_name: CONSUMER_NAME,
        replay_generation: delivery.replayGeneration,
        source_topic: delivery.topic,
        source_partition: delivery.partition,
        source_offset: delivery.offset,
        payload_hash: canonicalSha256(event),
        received_at: new Date(),
        completed_at: completedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(['consumer_name', 'event_id', 'replay_generation']).doNothing(),
      )
      .returning('event_id')
      .executeTakeFirst();
    return Boolean(receipt);
  }

  /** Publishes replay resolution without writing state owned by the Control API. */
  private writeReplayResolution(
    tx: Tx,
    request: ProvisioningReplayRequestedV1,
    outcome: ProvisioningReplayResolvedV1['data']['outcome'],
    replayGeneration: number,
    resolvedAt: Date,
  ): Promise<unknown> {
    const event: ProvisioningReplayResolvedV1 = {
      eventId: randomUUID(),
      schemaName: 'provisioning.replay.resolved',
      schemaVersion: 1,
      aggregateType: 'instance',
      aggregateId: request.aggregateId,
      projectId: request.projectId,
      operationId: request.operationId,
      correlationId: request.correlationId,
      causationId: request.eventId,
      occurredAt: resolvedAt.toISOString(),
      traceContext: request.traceContext,
      partitionKey: request.partitionKey,
      data: {
        replayRequestId: request.data.replayRequestId,
        originalEventId: request.data.originalEventId,
        outcome,
        replayGeneration,
        resolvedAt: resolvedAt.toISOString(),
      },
    };
    return this.writeEvent(tx, event);
  }

  /** Retains the replay decision until its exact authorized outbox record is consumed. */
  private persistReplayRequest(
    tx: Tx,
    request: ProvisioningReplayRequestedV1,
    status: 'authorized' | 'rejected',
    decidedAt: Date,
    authorization?: {
      readonly replayGeneration: number;
      readonly authorizedCommandHash: string;
      readonly authorizedOutboxId: string;
    },
  ): Promise<unknown> {
    if (status === 'authorized' && !authorization) {
      throw new Error('Authorized replay persistence requires command identity.');
    }
    return tx
      .insertInto('workflow.replay_requests')
      .values({
        replay_request_id: request.data.replayRequestId,
        request_event_id: request.eventId,
        original_event_id: request.data.originalEventId,
        replay_generation: authorization?.replayGeneration ?? null,
        status,
        request_payload: request,
        authorized_command_hash: authorization?.authorizedCommandHash ?? null,
        authorized_outbox_id: authorization?.authorizedOutboxId ?? null,
        requested_at: new Date(request.occurredAt),
        decided_at: decidedAt,
        completed_at: status === 'rejected' ? decidedAt : null,
      })
      .executeTakeFirstOrThrow();
  }

  /**
   * Proves this worker still holds a valid, current lease before any write.
   *
   * This is the fence. Four things must hold: the workflow's token matches, a lease row
   * exists, this worker owns it, and it has not expired. Any failure means another worker has
   * taken over — the correct response is to abort, not to force the write through.
   *
   * WHY the expiry check even though the token already matched: the token proves nobody has
   * claimed *since*, but a worker whose lease lapsed during a slow provider call has no right
   * to write, because another worker may be about to claim it. Both conditions are needed.
   *
   * The rows are locked `FOR UPDATE` so a concurrent claim cannot slip between this check and
   * the write that follows it.
   *
   * @throws Error if the token is stale or the lease is missing, expired, or foreign.
   */
  private async assertLease(
    tx: Tx,
    input: {
      readonly operationId: string;
      readonly workerId: string;
      readonly fencingToken: bigint;
    },
  ): Promise<WorkflowRow> {
    const workflow = await tx
      .selectFrom('workflow.workflows')
      .selectAll()
      .where('operation_id', '=', input.operationId)
      .forUpdate()
      .executeTakeFirst();
    if (!workflow || BigInt(workflow.fencing_token) !== input.fencingToken) {
      throw new Error('Workflow fencing token is stale.');
    }
    const lease = await tx
      .selectFrom('workflow.instance_leases')
      .selectAll()
      .where('instance_id', '=', workflow.instance_id)
      .forUpdate()
      .executeTakeFirst();
    if (
      !lease ||
      lease.owner_id !== input.workerId ||
      BigInt(lease.fencing_token) !== input.fencingToken ||
      new Date(lease.leased_until).getTime() <= Date.now()
    ) {
      throw new Error('Workflow lease is missing, expired, or fenced.');
    }
    return workflow;
  }

  /** Writes or reopens governed dead-letter evidence and publishes its independent DLQ fact. */
  private async writeDeadLetter(
    tx: Tx,
    input: {
      readonly original: EventEnvelope;
      readonly traceContext: EventEnvelope['traceContext'];
      readonly failureCategory: ProvisioningDeadLetteredV1['data']['failure']['category'];
      readonly failureCode: string;
      readonly safeMessage: string;
      readonly attempts: number;
      readonly replayAllowed: boolean;
      readonly replayGeneration: number;
      readonly now: Date;
    },
  ): Promise<void> {
    const deadLetterEventId = randomUUID();
    await tx
      .insertInto('workflow.dead_letters')
      .values({
        original_event_id: input.original.eventId,
        dead_letter_event_id: deadLetterEventId,
        original_schema_name: input.original.schemaName,
        original_schema_version: input.original.schemaVersion,
        aggregate_id: input.original.aggregateId,
        project_id: input.original.projectId,
        operation_id: input.original.operationId,
        original_payload: input.original,
        failure_category: input.failureCategory,
        failure_code: input.failureCode,
        safe_message: input.safeMessage,
        attempts: input.attempts,
        replay_allowed: input.replayAllowed,
        replay_generation: input.replayGeneration,
        status: 'open',
        dead_lettered_at: input.now,
        last_replay_at: null,
      })
      .onConflict((conflict) =>
        conflict.column('original_event_id').doUpdateSet({
          dead_letter_event_id: deadLetterEventId,
          failure_category: input.failureCategory,
          failure_code: input.failureCode,
          safe_message: input.safeMessage,
          attempts: input.attempts,
          replay_allowed: input.replayAllowed,
          replay_generation: input.replayGeneration,
          status: 'open',
          dead_lettered_at: input.now,
        }),
      )
      .executeTakeFirstOrThrow();

    const event: ProvisioningDeadLetteredV1 = {
      eventId: deadLetterEventId,
      schemaName: 'provisioning.dead_lettered',
      schemaVersion: 1,
      aggregateType: 'instance',
      aggregateId: input.original.aggregateId,
      projectId: input.original.projectId,
      operationId: input.original.operationId,
      correlationId: input.original.correlationId,
      causationId: input.original.eventId,
      occurredAt: input.now.toISOString(),
      traceContext: input.traceContext,
      partitionKey: input.original.partitionKey,
      data: {
        originalEventId: input.original.eventId,
        originalSchemaName: input.original.schemaName,
        originalSchemaVersion: input.original.schemaVersion,
        failure: {
          category: input.failureCategory,
          code: input.failureCode,
          safeMessage: input.safeMessage,
        },
        attempts: input.attempts,
        replayAllowed: input.replayAllowed,
        deadLetteredAt: input.now.toISOString(),
      },
    };
    await this.writeWorkflowOutbox(tx, event, 'provisioning.dlq.v1', input.now);
  }

  /**
   * Appends an event to the workflow outbox.
   *
   * Always called inside the same transaction as the stage change it explains, so the two can
   * never diverge. The projection worker reads this table.
   *
   * @see docs/architecture/glossary.md#transactional-outbox
   */
  private writeEvent(tx: Tx, event: WorkflowEvent): Promise<unknown> {
    return this.writeWorkflowOutbox(
      tx,
      event,
      'provisioning.events.v1',
      new Date(event.occurredAt),
    );
  }

  /** Writes one service audit row and its archive fact without Kafka delivery coordinates. */
  private async writeServiceAudit(
    tx: Tx,
    cause: EventEnvelope,
    action: string,
    outcome: 'accepted' | 'succeeded' | 'rejected' | 'failed',
    occurredAt: Date,
    options: { readonly reasonReference?: string } = {},
  ): Promise<void> {
    const event = auditRecordedEvent({
      eventId: randomUUID(),
      projectId: cause.projectId,
      operationId: cause.operationId,
      correlationId: cause.correlationId,
      causationId: cause.eventId,
      occurredAt,
      traceContext: cause.traceContext,
      actorId: 'provisioning-orchestrator',
      actorRole: 'service',
      action,
      targetType: cause.aggregateType,
      targetId: cause.aggregateId,
      outcome,
      ...(options.reasonReference ? { reasonReference: options.reasonReference } : {}),
    });
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
        occurred_at: occurredAt,
      })
      .executeTakeFirstOrThrow();
    await this.writeWorkflowOutbox(tx, event, 'audit.events.v1', occurredAt);
  }

  /** Appends an owner event to its explicitly allowlisted topic. */
  private writeWorkflowOutbox(
    tx: Tx,
    event: EventEnvelope,
    topic:
      | 'provisioning.commands.v1'
      | 'provisioning.events.v1'
      | 'provisioning.dlq.v1'
      | 'audit.events.v1',
    occurredAt: Date,
    options: { readonly outboxId?: string; readonly replayGeneration?: number } = {},
  ): Promise<unknown> {
    return this.telemetry.trace(
      'controlplane.outbox.write',
      { 'outbox.owner': 'workflow', 'event.schema.name': event.schemaName },
      () =>
        tx
          .insertInto('workflow.outbox')
          .values({
            outbox_id: options.outboxId ?? randomUUID(),
            event_id: event.eventId,
            aggregate_id: event.aggregateId,
            aggregate_type: event.aggregateType,
            schema_name: event.schemaName,
            schema_version: event.schemaVersion,
            topic,
            partition_key: event.partitionKey,
            payload: event,
            tracingspancontext: serializeDebeziumTraceContext(event.traceContext),
            replay_generation: options.replayGeneration ?? 0,
            occurred_at: occurredAt,
            created_at: new Date(),
          })
          .executeTakeFirst(),
    );
  }

  /**
   * Expires this worker's lease so the next transition can be claimed immediately.
   *
   * Sets `leased_until` to now rather than deleting the row, so `fencing_token` survives and
   * keeps incrementing. Deleting would reset the sequence and let a long-stalled worker's old
   * token look valid again.
   *
   * The owner and token predicates make this a no-op if the lease has already moved on.
   */
  private releaseLease(
    tx: Tx,
    instanceId: string,
    input: { readonly workerId: string; readonly fencingToken: bigint },
  ): Promise<unknown> {
    return tx
      .updateTable('workflow.instance_leases')
      .set({ leased_until: new Date(), updated_at: new Date() })
      .where('instance_id', '=', instanceId)
      .where('owner_id', '=', input.workerId)
      .where('fencing_token', '=', String(input.fencingToken))
      .executeTakeFirst();
  }
}
