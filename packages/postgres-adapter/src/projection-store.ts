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
 * Driven by `ProjectionConsumer` in `apps/control-api`, which reads the Kafka event and
 * dead-letter topics and commits each inbox receipt in the same transaction as the apply.
 *
 * @see docs/architecture/glossary.md#read-projection-cqrs
 */
import {
  STAGE_PROGRESS_PERCENT,
  type DeadLetterView,
  type InstanceView,
  type MessageDeliveryIdentity,
  type OperationView,
  type PersistedStage,
  type ProjectionStore,
  type SnapshotView,
  type WorkflowEvent,
} from '@private-cloud/application';
import type {
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  EventEnvelope,
  ProvisioningDeadLetteredV1,
  ProvisioningReplayResolvedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { parseJsonColumn } from './column-codec.js';
import type { PostgresClient, PostgresDatabase } from './database.js';

/** Identifies this consumer in `projection.event_receipts`. */
const EVENT_CONSUMER_NAME = 'control-api.provisioning-events.v1';
const DLQ_CONSUMER_NAME = 'control-api.provisioning-dlq.v1';
const DRIFT_CONSUMER_NAME = 'control-api.reconciliation-events.v1';

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

  /** Applies one Kafka workflow event and its inbox receipt atomically. */
  public applyWorkflowEvent(
    event: WorkflowEvent,
    delivery: MessageDeliveryIdentity,
  ): Promise<'applied' | 'duplicate'> {
    return this.db.transaction().execute(async (tx) => {
      const receipt = await this.insertReceipt(tx, EVENT_CONSUMER_NAME, event.eventId, delivery);
      if (!receipt) return 'duplicate';
      await this.applyEvent(tx, event);
      return 'applied';
    });
  }

  /** Projects governed DLQ evidence for the administrator API. */
  public applyDeadLetterEvent(
    event: ProvisioningDeadLetteredV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'applied' | 'duplicate'> {
    return this.db.transaction().execute(async (tx) => {
      const receipt = await this.insertReceipt(tx, DLQ_CONSUMER_NAME, event.eventId, delivery);
      if (!receipt) return 'duplicate';
      const document: DeadLetterView = {
        eventId: event.data.originalEventId,
        schemaName: event.data.originalSchemaName,
        schemaVersion: event.data.originalSchemaVersion,
        aggregateId: event.aggregateId,
        projectId: event.projectId,
        operationId: event.operationId,
        category: event.data.failure.category,
        safeMessage: event.data.failure.safeMessage,
        attempts: event.data.attempts,
        deadLetteredAt: event.data.deadLetteredAt,
        replayAllowed: event.data.replayAllowed,
        lastReplayAt: null,
      };
      await tx
        .insertInto('projection.dead_letters')
        .values({
          original_event_id: event.data.originalEventId,
          project_id: event.projectId,
          operation_id: event.operationId,
          aggregate_id: event.aggregateId,
          document,
          trace_context: event.traceContext,
          updated_at: new Date(event.occurredAt),
        })
        .onConflict((conflict) =>
          conflict.column('original_event_id').doUpdateSet({
            project_id: event.projectId,
            operation_id: event.operationId,
            aggregate_id: event.aggregateId,
            document,
            trace_context: event.traceContext,
            updated_at: new Date(event.occurredAt),
          }),
        )
        .executeTakeFirst();
      // WHY: `AdministrativeOperation.deadLetterEventId` is the only navigation an operator has
      // from a stalled operation to the evidence explaining it. Writing it here, in the same
      // transaction as the projected dead letter, keeps the two from disagreeing.
      await tx
        .updateTable('projection.operations')
        .set({ dead_letter_event_id: event.data.originalEventId })
        .where('operation_id', '=', event.operationId)
        .execute();
      return 'applied';
    });
  }

  /** Quarantines malformed or unsupported projection input without retaining its raw body. */
  public quarantineRecord(
    input: Parameters<ProjectionStore['quarantineRecord']>[0],
  ): Promise<'quarantined' | 'duplicate'> {
    return this.db.transaction().execute(async (tx) => {
      const consumerName =
        input.delivery.topic === 'provisioning.dlq.v1' ? DLQ_CONSUMER_NAME : EVENT_CONSUMER_NAME;
      const inserted = await tx
        .insertInto('projection.poison_records')
        .values({
          id: randomUUID(),
          consumer_name: consumerName,
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
      if (input.eventId) {
        await this.insertReceipt(tx, consumerName, input.eventId, input.delivery);
      }
      return inserted ? 'quarantined' : 'duplicate';
    });
  }

  /** Dispatches a contract-narrowed workflow event inside its receipt transaction. */
  private async applyEvent(tx: Tx, event: WorkflowEvent): Promise<void> {
    if (event.schemaName === 'workflow.progressed') {
      await this.applyProgress(tx, event as WorkflowProgressedV1);
    } else if (event.schemaName === 'instance.mutation.completed') {
      await this.applyCompleted(tx, event as InstanceMutationCompletedV1);
    } else if (event.schemaName === 'instance.mutation.failed') {
      await this.applyFailed(tx, event as InstanceMutationFailedV1);
    } else if (event.schemaName === 'provisioning.replay.resolved') {
      await this.applyReplayResolved(tx, event as ProvisioningReplayResolvedV1);
    } else {
      throw new Error('Unsupported workflow event.');
    }
  }

  /**
   * Projects a reconciliation drift finding.
   *
   * Deliberately narrow: it writes the classification onto the instance document and nothing else.
   * Desired state, lifecycle, and observed state all stay as they are, because acting on a finding
   * is a separate attributed request rather than something a projection does on its own.
   */
  public applyDriftEvent(
    event: EventEnvelope & { readonly data?: unknown },
    delivery: MessageDeliveryIdentity,
  ): Promise<'applied' | 'duplicate'> {
    return this.db.transaction().execute(async (tx) => {
      const receipt = await this.insertReceipt(tx, DRIFT_CONSUMER_NAME, event.eventId, delivery);
      if (!receipt) return 'duplicate';

      const data = event.data as { readonly classification?: string } | undefined;
      const classification = data?.classification;
      if (!classification) return 'applied';

      const row = await tx
        .selectFrom('projection.instances')
        .select('document')
        .where('instance_id', '=', event.aggregateId)
        .forUpdate()
        .executeTakeFirst();
      // A finding for an instance the projection has never seen is not an error: the reconciler
      // reads authoritative state, which can exist before its read document does.
      if (!row) return 'applied';

      const document = parseJsonColumn<InstanceView>(row.document);
      await tx
        .updateTable('projection.instances')
        .set({
          document: {
            ...document,
            drift: classification as InstanceView['drift'],
            lastReconciledAt: event.occurredAt,
            updatedAt: event.occurredAt,
          },
          updated_at: new Date(event.occurredAt),
        })
        .where('instance_id', '=', event.aggregateId)
        .executeTakeFirstOrThrow();
      return 'applied';
    });
  }

  /** Inserts an inbox receipt, returning false for a redelivery already handled. */
  private async insertReceipt(
    tx: Tx,
    consumerName: string,
    eventId: string,
    delivery: MessageDeliveryIdentity,
  ): Promise<boolean> {
    const receipt = await tx
      .insertInto('projection.event_receipts')
      .values({
        event_id: eventId,
        consumer_name: consumerName,
        replay_generation: delivery.replayGeneration,
        source_topic: delivery.topic,
        source_partition: delivery.partition,
        source_offset: delivery.offset,
        received_at: new Date(),
      })
      .onConflict((conflict) =>
        conflict.columns(['consumer_name', 'event_id', 'replay_generation']).doNothing(),
      )
      .returning('event_id')
      .executeTakeFirst();
    return Boolean(receipt);
  }

  /** Applies the Orchestrator-owned replay decision to Control API state. */
  private async applyReplayResolved(tx: Tx, event: ProvisioningReplayResolvedV1): Promise<void> {
    const updatedRequest = await tx
      .updateTable('control.replay_requests')
      .set({ status: event.data.outcome, updated_at: new Date(event.data.resolvedAt) })
      .where('id', '=', event.data.replayRequestId)
      .where('original_event_id', '=', event.data.originalEventId)
      .returning('id')
      .executeTakeFirst();
    if (!updatedRequest) {
      // The receipt is in this transaction and rolls back with the failed ownership lookup, so
      // Kafka can redeliver after the missing Control API state has been investigated.
      throw new Error('Replay resolution does not match an owned replay request.');
    }

    if (event.data.outcome !== 'completed') return;
    const row = await tx
      .selectFrom('projection.dead_letters')
      .select('document')
      .where('original_event_id', '=', event.data.originalEventId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const document = parseJsonColumn<DeadLetterView>(row.document);
    await tx
      .updateTable('projection.dead_letters')
      .set({
        document: {
          ...document,
          replayAllowed: false,
          lastReplayAt: event.data.resolvedAt,
        },
        updated_at: new Date(event.data.resolvedAt),
      })
      .where('original_event_id', '=', event.data.originalEventId)
      .executeTakeFirstOrThrow();
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
    await this.writeDocuments(tx, nextInstance, nextOperation, now, {
      ...operationRecovery(event),
      checkpoint: event.data.stage,
      // `attempt` counts claims and starts at one, so the first attempt is zero retries.
      retry_count: Math.max(0, event.data.attempt - 1),
      provider_task_reference: event.data.providerTaskReference ?? null,
    });
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

    // WHY read the lifecycle state from the event rather than hardcoding `active`: with more than
    // one capability, a terminal success can leave an instance `retained` or `purged` just as
    // legitimately as `active`.
    const lifecycleState = event.data.lifecycleState as InstanceView['lifecycleState'];
    const observed = observedFromEvent(event, event.occurredAt);
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

    const instanceRow = await tx
      .updateTable('control.instances')
      .set({
        lifecycle_state: lifecycleState,
        active_operation_id: null,
        updated_at: now,
        // Mirrored onto columns as well as the document because purge and reconciliation query
        // observed state, and a guard deciding whether a VM may be destroyed must not depend on
        // reading a jsonb body.
        observed_exists: observed.exists,
        observed_power_state: observed.powerState,
        observed_cpu_count: observed.cpuCount,
        observed_memory_mib: observed.memoryMiB === null ? null : String(observed.memoryMiB),
        observed_disk_gib: observed.diskGiB === null ? null : String(observed.diskGiB),
        observed_marker_match: observed.markerMatch,
        observed_at: new Date(observed.observedAt),
        drift: 'none',
        last_reconciled_at: now,
      })
      .where('id', '=', event.aggregateId)
      .returning(['retention_deadline', 'purge_eligible'])
      .executeTakeFirstOrThrow();

    // Retention state is read back from the authoritative row rather than carried forward from the
    // previous document. WHY: `acceptRetention` stamps `retention_deadline` and `purge_eligible`
    // onto `control.instances` at acceptance and does not touch the projection, so a document built
    // by copying its predecessor reported `retentionDeadline: null` for the whole life of a retained
    // instance — the tenant could see that their instance was retained but never when it stops
    // being recoverable.
    const nextInstance: InstanceView = {
      ...documents.instance,
      lifecycleState,
      observed,
      activeOperationId: null,
      drift: 'none',
      lastReconciledAt: event.occurredAt,
      retentionDeadline: instanceRow.retention_deadline
        ? new Date(instanceRow.retention_deadline).toISOString()
        : null,
      purgeEligible: instanceRow.purge_eligible,
      updatedAt: event.occurredAt,
    };

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
    await this.settleSnapshot(tx, event, documents.operation, now);
    await this.writeDocuments(tx, nextInstance, nextOperation, now, {
      ...operationRecovery(event),
      checkpoint: nextOperation.stage,
      // WHY: the operation is terminal, so any handle it was polling is no longer in flight.
      // Leaving a stale reference here would invite an operator to poll a finished task.
      provider_task_reference: null,
    });
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
    await this.writeDocuments(tx, nextInstance, nextOperation, now, {
      ...operationRecovery(event),
      checkpoint: nextOperation.stage,
      provider_task_reference: null,
    });
  }

  /**
   * Reads and locks both documents for a read-modify-write.
   *
   * `FOR UPDATE` is required because each apply reads a document, edits it in memory, and
   * writes it back. Without the lock a concurrent apply could interleave between the read and
   * the write, and the second writer would silently discard the first one's changes.
   */
  /**
   * Settles the snapshot a completed snapshot operation acted on.
   *
   * WHY this is needed at all: a snapshot is created in `creating` at acceptance, and nothing else
   * moved it. The workflow succeeded, the operation reported `succeeded`, and the snapshot stayed
   * `creating` forever — which is not merely cosmetic, because `rollbackSnapshot` and
   * `deleteSnapshot` both refuse anything that is not `available` and answered `INSTANCE_BUSY`. A
   * snapshot could be taken and then never used.
   *
   * The snapshot is identified from the operation's own target rather than from the event, because
   * `instance.mutation.completed` is addressed to the instance: its `aggregateId` is the VM for
   * every capability, and only the operation records which snapshot the request named.
   *
   * A delete removes both rows. Retaining a tombstone would keep the name occupied, and
   * `control.snapshots` has a `UNIQUE (instance_id, name)` that would then refuse to take the same
   * snapshot again.
   */
  private async settleSnapshot(
    tx: Tx,
    event: InstanceMutationCompletedV1,
    operation: OperationView,
    now: Date,
  ): Promise<void> {
    if (operation.targetType !== 'snapshot') return;
    const snapshotId = operation.targetId;

    if (event.data.action === 'delete_snapshot') {
      await tx.deleteFrom('projection.snapshots').where('snapshot_id', '=', snapshotId).execute();
      await tx.deleteFrom('control.snapshots').where('id', '=', snapshotId).execute();
      return;
    }

    // Both create and rollback leave the snapshot usable. Rollback restores the disk and leaves the
    // snapshot itself in place, which is why it settles to the same state a create does.
    const row = await tx
      .updateTable('control.snapshots')
      .set({ state: 'available', updated_at: now })
      .where('id', '=', snapshotId)
      .returningAll()
      .executeTakeFirst();
    if (!row) return;

    const document: SnapshotView = {
      id: row.id,
      instanceId: row.instance_id,
      name: row.name,
      description: row.description,
      state: 'available',
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: now.toISOString(),
    };
    await tx
      .updateTable('projection.snapshots')
      .set({ document, updated_at: now })
      .where('snapshot_id', '=', snapshotId)
      .execute();
  }

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

  /**
   * Writes both updated documents back to the read model.
   *
   * `recovery` carries the administrative sidecar columns. They are written in the same
   * statement as the document so the two can never disagree about which event last touched the
   * operation.
   */
  private async writeDocuments(
    tx: Tx,
    instance: InstanceView,
    operation: OperationView,
    updatedAt: Date,
    recovery: OperationRecovery,
  ): Promise<void> {
    await tx
      .updateTable('projection.instances')
      .set({ document: instance, updated_at: updatedAt })
      .where('instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('projection.operations')
      .set({ document: operation, updated_at: updatedAt, ...recovery })
      .where('operation_id', '=', operation.id)
      .executeTakeFirstOrThrow();
  }
}

/** Administrative sidecar columns written alongside a projected operation document. */
interface OperationRecovery {
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly trace_id: string | null;
  readonly checkpoint?: string;
  readonly retry_count?: number;
  readonly provider_task_reference?: string | null;
}

/**
 * Derives the administrative sidecar shared by every workflow event.
 *
 * WHY: these values live on the envelope of every event the projection already consumes, so the
 * administrator route needs no read of workflow-owned tables to serve them. Extracting the trace
 * ID here rather than storing the whole carrier keeps the restricted W3C context out of a column
 * that an administrative response reads from.
 */
function operationRecovery(event: {
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly traceContext?: { readonly traceparent?: string };
}): OperationRecovery {
  return {
    correlation_id: event.correlationId,
    causation_id: event.causationId ?? null,
    trace_id: traceIdOf(event.traceContext?.traceparent),
  };
}

/**
 * Extracts the 32-character trace ID from a W3C `traceparent`.
 *
 * Returns `null` rather than throwing for anything malformed: a projection must never fail to
 * record a real state change because a trace header was unusable.
 */
function traceIdOf(traceparent: string | undefined): string | null {
  if (!traceparent) return null;
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
  return match?.[1] ?? null;
}

/**
 * Builds the read model's observed block from a terminal event.
 *
 * Before capability 1 this projection hardcoded `exists: true`, `powerState: 'running'`, and
 * `markerMatch: true`, and nulled every measurement — publishing as confirmed fact four things it
 * had never measured. The workflow does observe all of them, so the event now carries them and
 * this reads what was actually seen.
 *
 * Sizing stays `null` when the provider did not report it. Substituting the desired sizing would
 * make desired and observed agree by construction, which is exactly the disagreement the
 * reconciler exists to surface.
 */
function observedFromEvent(
  event: InstanceMutationCompletedV1,
  fallbackObservedAt: string,
): NonNullable<InstanceView['observed']> {
  const observed = event.data.observed;
  const resources = observed?.resources;
  return {
    exists: observed?.exists ?? true,
    powerState: observed?.powerState ?? 'unknown',
    cpuCount: resources?.cpuCount ?? null,
    memoryMiB: resources?.memoryMiB ?? null,
    diskGiB: resources?.diskGiB ?? null,
    markerMatch: observed?.markerMatch ?? true,
    observedAt: observed?.observedAt ?? fallbackObservedAt,
  };
}
