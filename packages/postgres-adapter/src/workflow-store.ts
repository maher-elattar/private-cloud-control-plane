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
import {
  toWorkflowStage,
  type ClaimedCreateWorkflow,
  type WorkflowEvent,
  type WorkflowStore,
} from '@private-cloud/application';
import type { InstanceCreateRequestedV1 } from '@private-cloud/contracts';
import { canonicalSha256 } from '@private-cloud/domain';
import { sql, type Transaction } from 'kysely';
import { parseJsonColumn } from './column-codec.js';
import type { PostgresClient, PostgresDatabase } from './database.js';

/** Identifies this consumer in `workflow.command_receipts`. */
const CONSUMER_NAME = 'provisioning-orchestrator.phase3';

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
 * @throws Error if the payload is not a well-formed create command.
 */
function createCommand(value: unknown): InstanceCreateRequestedV1 {
  const command = parseJsonColumn<Partial<InstanceCreateRequestedV1>>(value);
  if (
    command.schemaName !== 'instance.create.requested' ||
    !command.eventId ||
    !command.operationId ||
    !command.aggregateId ||
    !command.projectId ||
    !command.data
  ) {
    throw new Error('The create-instance outbox command is malformed.');
  }
  return command as InstanceCreateRequestedV1;
}

/** A row of `workflow.workflows` as returned by the raw claim queries. */
interface WorkflowRow {
  readonly operation_id: string;
  readonly event_id: string;
  readonly instance_id: string;
  readonly command: unknown;
  readonly stage: string;
  readonly attempt: number;
  readonly fencing_token: string;
  readonly provider_resource_id: string | null;
  readonly provider_task_reference: string | null;
}

/** An unconsumed command row read from `control.outbox`. */
interface CommandRow {
  readonly event_id: string;
  readonly payload: unknown;
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
  public constructor(private readonly db: PostgresClient) {}

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
      let workflow = await this.readyWorkflow(tx, workerId);
      if (!workflow) workflow = await this.receiveCommand(tx);
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

      return {
        command: createCommand(claimed.command),
        stage: toWorkflowStage(claimed.stage),
        attempt: claimed.attempt,
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
        .executeTakeFirstOrThrow();
      await this.writeEvent(tx, input.event);
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

  /**
   * Admits one accepted command from the outbox and turns it into a workflow.
   *
   * PATTERN — Inbox. The `NOT EXISTS` against `command_receipts` is what makes admission
   * exactly-once: a command already seen has a receipt and is never selected again, no matter
   * how many times it is delivered.
   *
   * `payload_hash` stores a canonical hash of the command, so a redelivery whose *content*
   * differs can be detected rather than silently accepted.
   *
   * In Phase 4 this method's role is taken over by Kafka consumption. The receipts table, the
   * hash, and the exactly-once property stay exactly as they are.
   */
  private async receiveCommand(tx: Tx): Promise<WorkflowRow | null> {
    const result = await sql<CommandRow>`
      SELECT o.event_id, o.payload
      FROM control.outbox o
      WHERE o.schema_name = 'instance.create.requested'
        AND NOT EXISTS (
          SELECT 1 FROM workflow.command_receipts r WHERE r.event_id = o.event_id
        )
      ORDER BY o.occurred_at, o.event_id
      FOR UPDATE OF o SKIP LOCKED
      LIMIT 1
    `.execute(tx);
    const row = result.rows[0];
    if (!row) return null;

    const command = createCommand(row.payload);
    const now = new Date();
    await tx
      .insertInto('workflow.command_receipts')
      .values({
        event_id: command.eventId,
        consumer_name: CONSUMER_NAME,
        payload_hash: canonicalSha256(command),
        received_at: now,
        // Set by `complete`, not here — an in-progress workflow must not look consumed.
        completed_at: null,
      })
      .execute();
    return tx
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
        fencing_token: '0',
        provider_resource_id: null,
        provider_task_reference: null,
        next_attempt_at: now,
        failure_category: null,
        failure_code: null,
        failure_message: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .returningAll()
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

  /**
   * Appends an event to the workflow outbox.
   *
   * Always called inside the same transaction as the stage change it explains, so the two can
   * never diverge. The projection worker reads this table.
   *
   * @see docs/architecture/glossary.md#transactional-outbox
   */
  private writeEvent(tx: Tx, event: WorkflowEvent): Promise<unknown> {
    return tx
      .insertInto('workflow.outbox')
      .values({
        event_id: event.eventId,
        aggregate_id: event.aggregateId,
        schema_name: event.schemaName,
        payload: event,
        occurred_at: new Date(event.occurredAt),
      })
      .executeTakeFirst();
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
