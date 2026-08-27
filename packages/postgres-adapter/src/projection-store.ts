/**
 * PostgreSQL adapter for the `ProjectionStore` port.
 *
 * PATTERN — Read projection (CQRS). Reads and writes use different models here. Workflow
 * events arrive from `workflow.outbox`, and each is applied to both the authoritative write
 * tables (`control.instances`, `control.operations`) and the pre-built read documents
 * (`projection.instances`, `projection.operations`).
 *
 * WHY maintain two: an `Instance` API response merges desired state, observed provider state,
 * the IPv4 lease, drift, and the active operation. Assembling that with joins on every `GET`
 * is both slow and a second place the response shape could drift from the contract. Building
 * it once, when state actually changes, keeps reads a single-row lookup with no mapping.
 *
 * Driven by `ProjectionWorker` in `apps/control-api`.
 *
 * @see docs/architecture/glossary.md#read-projection-cqrs
 */
import {
  STAGE_PROGRESS_PERCENT,
  type InstanceView,
  type OperationView,
  type PersistedStage,
  type ProjectionStore,
} from '@private-cloud/application';
import type {
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';
import { sql, type Transaction } from 'kysely';
import { parseJsonColumn } from './column-codec.js';
import type { PostgresClient, PostgresDatabase } from './database.js';

/** Identifies this consumer in `projection.event_receipts`. */
const CONSUMER_NAME = 'control-api.phase3-projection';

/** A row of `workflow.outbox` awaiting projection. */
interface EventRow {
  readonly event_id: string;
  readonly aggregate_id: string;
  readonly schema_name: string;
  readonly payload: unknown;
  readonly occurred_at: Date | string;
}

/** Open transaction handle passed between the private apply steps. */
type Tx = Transaction<PostgresDatabase>;

/**
 * Applies workflow events to the write tables and the read documents.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */
export class PostgresProjectionStore implements ProjectionStore {
  /** @param db Kysely client owned by the control API's DI container. */
  public constructor(private readonly db: PostgresClient) {}

  /**
   * Applies the oldest unconsumed workflow event, then records its receipt.
   *
   * The query is the subtle part. It selects an event only when **both** conditions hold:
   *
   * 1. It has no receipt yet — the idempotency guard, so a re-read applies nothing twice.
   * 2. No *earlier* unconsumed event exists for the same aggregate — the ordering guard.
   *
   * WHY the second, nested `NOT EXISTS`: without it, two workers could take a `progressed`
   * and a `completed` event for one instance concurrently and commit them out of order. The
   * instance would settle at `provisioning` forever, despite having been successfully built,
   * because the older event was written last and overwrote the newer one.
   *
   * Note it orders across *all* aggregates but only blocks within one, so a slow instance
   * never holds up an unrelated one. `SKIP LOCKED` lets replicas work in parallel.
   *
   * @returns `true` when an event was applied — poll again immediately — `false` when drained.
   * @throws Error on an unrecognised event schema, rather than silently consuming it.
   */
  public applyNextWorkflowEvent(): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const result = await sql<EventRow>`
        SELECT o.*
        FROM workflow.outbox o
        WHERE NOT EXISTS (
          SELECT 1 FROM projection.event_receipts r WHERE r.event_id = o.event_id
        )
          AND NOT EXISTS (
            SELECT 1
            FROM workflow.outbox earlier
            WHERE earlier.aggregate_id = o.aggregate_id
              AND (earlier.occurred_at, earlier.event_id) < (o.occurred_at, o.event_id)
              AND NOT EXISTS (
                SELECT 1 FROM projection.event_receipts consumed
                WHERE consumed.event_id = earlier.event_id
              )
          )
        ORDER BY o.occurred_at, o.event_id
        FOR UPDATE OF o SKIP LOCKED
        LIMIT 1
      `.execute(tx);
      const row = result.rows[0];
      if (!row) return false;

      if (row.schema_name === 'workflow.progressed') {
        await this.applyProgress(tx, parseJsonColumn<WorkflowProgressedV1>(row.payload));
      } else if (row.schema_name === 'instance.mutation.completed') {
        await this.applyCompleted(tx, parseJsonColumn<InstanceMutationCompletedV1>(row.payload));
      } else if (row.schema_name === 'instance.mutation.failed') {
        await this.applyFailed(tx, parseJsonColumn<InstanceMutationFailedV1>(row.payload));
      } else {
        // Throwing rolls the transaction back, leaving the event unconsumed. Skipping it
        // instead would let the ordering guard release later events for the same instance and
        // project state that never happened.
        throw new Error(`Unsupported workflow event: ${row.schema_name}`);
      }

      await tx
        .insertInto('projection.event_receipts')
        .values({
          event_id: row.event_id,
          consumer_name: CONSUMER_NAME,
          replay_generation: 0,
          source_topic: null,
          source_partition: null,
          source_offset: null,
          received_at: new Date(),
        })
        .execute();
      return true;
    });
  }

  /**
   * Applies a mid-workflow progress event.
   *
   * Surfaces the stage and a progress percentage for clients polling the operation. The
   * instance moves to `provisioning` on every progress event — idempotent, and correct
   * regardless of which stage this is.
   *
   * `startedAt` is set once, on the first progress event, and preserved afterwards: it
   * records when work actually began, as distinct from when the request was accepted.
   */
  private async applyProgress(tx: Tx, event: WorkflowProgressedV1): Promise<void> {
    const now = new Date(event.occurredAt);
    const operationRow = await tx
      .selectFrom('projection.operations')
      .select('document')
      .where('operation_id', '=', event.operationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const instanceRow = await tx
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', event.aggregateId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const operation = parseJsonColumn<OperationView>(operationRow.document);
    const instance = parseJsonColumn<InstanceView>(instanceRow.document);

    const nextOperation: OperationView = {
      ...operation,
      state: event.data.operationState,
      stage: event.data.stage,
      // Falls back to the current value for an unrecognised stage, so the bar never jumps
      // backwards to zero on an event this version does not know about.
      progressPercent:
        STAGE_PROGRESS_PERCENT[event.data.stage as PersistedStage] ?? operation.progressPercent,
      startedAt: operation.startedAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
    };
    const nextInstance: InstanceView = {
      ...instance,
      lifecycleState: 'provisioning',
      updatedAt: event.occurredAt,
    };

    await tx
      .updateTable('control.operations')
      .set({
        state: event.data.operationState,
        stage: event.data.stage,
        progress_percent: nextOperation.progressPercent,
        started_at: operation.startedAt ? new Date(operation.startedAt) : now,
        updated_at: now,
      })
      .where('id', '=', event.operationId)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('control.instances')
      .set({ lifecycle_state: 'provisioning', updated_at: now })
      .where('id', '=', event.aggregateId)
      .executeTakeFirstOrThrow();
    await this.writeDocuments(tx, nextInstance, nextOperation, now);
  }

  /**
   * Applies a successful terminal event: the instance is built, owned, and running.
   *
   * `activeOperationId` is cleared, which is what releases the instance for its next
   * operation. The observed block is populated from the workflow's proof of a running,
   * marker-matched VM.
   *
   * The sizing fields stay `null` deliberately: the Phase 3 observation contract proves
   * existence, power, and ownership, but does not carry measured CPU, memory, or disk. They
   * are filled in when the reconciliation phase extends that contract — see the deliberate
   * limitations in docs/architecture/phase-3-vertical-slice.md.
   */
  private async applyCompleted(tx: Tx, event: InstanceMutationCompletedV1): Promise<void> {
    const now = new Date(event.occurredAt);
    const documents = await this.lockDocuments(tx, event.aggregateId, event.operationId);

    const nextInstance: InstanceView = {
      ...documents.instance,
      lifecycleState: 'active',
      observed: {
        exists: true,
        powerState: 'running',
        cpuCount: null,
        memoryMiB: null,
        diskGiB: null,
        markerMatch: true,
        observedAt: event.occurredAt,
      },
      activeOperationId: null,
      drift: 'none',
      lastReconciledAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
    const nextOperation: OperationView = {
      ...documents.operation,
      state: 'succeeded',
      stage: 'completed',
      progressPercent: STAGE_PROGRESS_PERCENT.completed,
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
      manualReviewRequired: false,
    };

    await tx
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null, updated_at: now })
      .where('id', '=', event.aggregateId)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('control.operations')
      .set({
        state: 'succeeded',
        stage: 'completed',
        progress_percent: STAGE_PROGRESS_PERCENT.completed,
        updated_at: now,
        completed_at: now,
        error_category: null,
        error_code: null,
        error_message: null,
        manual_review_required: false,
      })
      .where('id', '=', event.operationId)
      .executeTakeFirstOrThrow();
    await this.writeDocuments(tx, nextInstance, nextOperation, now);
  }

  /**
   * Applies a terminal failure, distinguishing a clean failure from one needing a human.
   *
   * WHY the `manual` distinction matters: `failed` tells an operator nothing was left behind
   * and the request can simply be retried. `manual_review` says the opposite — a VM may exist
   * that the control plane could not prove, and retrying blindly could build a second one.
   *
   * Any of three signals forces review: an outcome the provider could not determine, an
   * explicit review request, or an unsafe compensation state. Ambiguity always resolves
   * towards asking a human, never towards assuming the safe case.
   */
  private async applyFailed(tx: Tx, event: InstanceMutationFailedV1): Promise<void> {
    const now = new Date(event.occurredAt);
    const documents = await this.lockDocuments(tx, event.aggregateId, event.operationId);
    const manual =
      event.data.failure.category === 'unknown_outcome' ||
      event.data.failure.category === 'manual_review' ||
      event.data.compensationState === 'unsafe';
    const terminalState = manual ? 'manual_review' : 'failed';

    const nextInstance: InstanceView = {
      ...documents.instance,
      lifecycleState: terminalState,
      activeOperationId: null,
      updatedAt: event.occurredAt,
    };
    const nextOperation: OperationView = {
      ...documents.operation,
      state: terminalState,
      stage: terminalState,
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
      errorCategory: event.data.failure.category,
      errorCode: event.data.failure.code,
      // Already sanitised by the provider adapter; safe to expose to the tenant.
      errorMessage: event.data.failure.safeMessage,
      manualReviewRequired: manual,
    };

    await tx
      .updateTable('control.instances')
      .set({ lifecycle_state: terminalState, active_operation_id: null, updated_at: now })
      .where('id', '=', event.aggregateId)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('control.operations')
      .set({
        state: terminalState,
        stage: terminalState,
        updated_at: now,
        completed_at: now,
        error_category: event.data.failure.category,
        error_code: event.data.failure.code,
        error_message: event.data.failure.safeMessage,
        manual_review_required: manual,
      })
      .where('id', '=', event.operationId)
      .executeTakeFirstOrThrow();
    await this.writeDocuments(tx, nextInstance, nextOperation, now);
  }

  /**
   * Reads and locks both documents for a read-modify-write.
   *
   * `FOR UPDATE` is required because each apply reads a document, edits it in memory, and
   * writes it back. Without the lock a concurrent apply could interleave between the read and
   * the write, and the second writer would silently discard the first one's changes.
   */
  private async lockDocuments(
    tx: Tx,
    instanceId: string,
    operationId: string,
  ): Promise<{ instance: InstanceView; operation: OperationView }> {
    const instance = await tx
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', instanceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const operation = await tx
      .selectFrom('projection.operations')
      .select('document')
      .where('operation_id', '=', operationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return {
      instance: parseJsonColumn<InstanceView>(instance.document),
      operation: parseJsonColumn<OperationView>(operation.document),
    };
  }

  /** Writes both updated documents back to the read model. */
  private async writeDocuments(
    tx: Tx,
    instance: InstanceView,
    operation: OperationView,
    updatedAt: Date,
  ): Promise<void> {
    await tx
      .updateTable('projection.instances')
      .set({ document: instance, updated_at: updatedAt })
      .where('instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('projection.operations')
      .set({ document: operation, updated_at: updatedAt })
      .where('operation_id', '=', operation.id)
      .executeTakeFirstOrThrow();
  }
}
