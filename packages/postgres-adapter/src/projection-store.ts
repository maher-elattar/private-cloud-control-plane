import type { InstanceView, OperationView, ProjectionStore } from '@private-cloud/application';
import type {
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';
import { sql, type Transaction } from 'kysely';
import type { PostgresClient, PostgresDatabase } from './database.js';

function json<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

const progressByStage: Readonly<Record<string, number>> = {
  accepted: 0,
  submitting_create: 10,
  polling_create: 25,
  configuring: 40,
  polling_configuration: 55,
  starting: 70,
  polling_start: 82,
  observing: 92,
  completed: 100,
};

interface EventRow {
  readonly event_id: string;
  readonly aggregate_id: string;
  readonly schema_name: string;
  readonly payload: unknown;
  readonly occurred_at: Date | string;
}

export class PostgresProjectionStore implements ProjectionStore {
  public constructor(private readonly db: PostgresClient) {}

  public applyNextWorkflowEvent(): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
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
      `.execute(transaction);
      const row = result.rows[0];
      if (!row) return false;

      if (row.schema_name === 'workflow.progressed') {
        await this.applyProgress(transaction, json<WorkflowProgressedV1>(row.payload));
      } else if (row.schema_name === 'instance.mutation.completed') {
        await this.applyCompleted(transaction, json<InstanceMutationCompletedV1>(row.payload));
      } else if (row.schema_name === 'instance.mutation.failed') {
        await this.applyFailed(transaction, json<InstanceMutationFailedV1>(row.payload));
      } else {
        throw new Error(`Unsupported workflow event: ${row.schema_name}`);
      }

      await transaction
        .insertInto('projection.event_receipts')
        .values({
          event_id: row.event_id,
          consumer_name: 'control-api.phase3-projection',
          received_at: new Date(),
        })
        .execute();
      return true;
    });
  }

  private async applyProgress(
    transaction: Transaction<PostgresDatabase>,
    event: WorkflowProgressedV1,
  ): Promise<void> {
    const now = new Date(event.occurredAt);
    const operationRow = await transaction
      .selectFrom('projection.operations')
      .select('document')
      .where('operation_id', '=', event.operationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const instanceRow = await transaction
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', event.aggregateId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const operation = json<OperationView>(operationRow.document);
    const instance = json<InstanceView>(instanceRow.document);
    const nextOperation: OperationView = {
      ...operation,
      state: event.data.operationState,
      stage: event.data.stage,
      progressPercent: progressByStage[event.data.stage] ?? operation.progressPercent,
      startedAt: operation.startedAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
    };
    const nextInstance: InstanceView = {
      ...instance,
      lifecycleState: 'provisioning',
      updatedAt: event.occurredAt,
    };
    await transaction
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
    await transaction
      .updateTable('control.instances')
      .set({ lifecycle_state: 'provisioning', updated_at: now })
      .where('id', '=', event.aggregateId)
      .executeTakeFirstOrThrow();
    await this.writeDocuments(transaction, nextInstance, nextOperation, now);
  }

  private async applyCompleted(
    transaction: Transaction<PostgresDatabase>,
    event: InstanceMutationCompletedV1,
  ): Promise<void> {
    const now = new Date(event.occurredAt);
    const documents = await this.lockDocuments(transaction, event.aggregateId, event.operationId);
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
      progressPercent: 100,
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
      manualReviewRequired: false,
    };
    await transaction
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null, updated_at: now })
      .where('id', '=', event.aggregateId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('control.operations')
      .set({
        state: 'succeeded',
        stage: 'completed',
        progress_percent: 100,
        updated_at: now,
        completed_at: now,
        error_category: null,
        error_code: null,
        error_message: null,
        manual_review_required: false,
      })
      .where('id', '=', event.operationId)
      .executeTakeFirstOrThrow();
    await this.writeDocuments(transaction, nextInstance, nextOperation, now);
  }

  private async applyFailed(
    transaction: Transaction<PostgresDatabase>,
    event: InstanceMutationFailedV1,
  ): Promise<void> {
    const now = new Date(event.occurredAt);
    const documents = await this.lockDocuments(transaction, event.aggregateId, event.operationId);
    const manual =
      event.data.failure.category === 'unknown_outcome' ||
      event.data.failure.category === 'manual_review' ||
      event.data.compensationState === 'unsafe';
    const nextInstance: InstanceView = {
      ...documents.instance,
      lifecycleState: manual ? 'manual_review' : 'failed',
      activeOperationId: null,
      updatedAt: event.occurredAt,
    };
    const nextOperation: OperationView = {
      ...documents.operation,
      state: manual ? 'manual_review' : 'failed',
      stage: manual ? 'manual_review' : 'failed',
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
      errorCategory: event.data.failure.category,
      errorCode: event.data.failure.code,
      errorMessage: event.data.failure.safeMessage,
      manualReviewRequired: manual,
    };
    await transaction
      .updateTable('control.instances')
      .set({
        lifecycle_state: manual ? 'manual_review' : 'failed',
        active_operation_id: null,
        updated_at: now,
      })
      .where('id', '=', event.aggregateId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('control.operations')
      .set({
        state: manual ? 'manual_review' : 'failed',
        stage: manual ? 'manual_review' : 'failed',
        updated_at: now,
        completed_at: now,
        error_category: event.data.failure.category,
        error_code: event.data.failure.code,
        error_message: event.data.failure.safeMessage,
        manual_review_required: manual,
      })
      .where('id', '=', event.operationId)
      .executeTakeFirstOrThrow();
    await this.writeDocuments(transaction, nextInstance, nextOperation, now);
  }

  private async lockDocuments(
    transaction: Transaction<PostgresDatabase>,
    instanceId: string,
    operationId: string,
  ): Promise<{ instance: InstanceView; operation: OperationView }> {
    const instance = await transaction
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', instanceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const operation = await transaction
      .selectFrom('projection.operations')
      .select('document')
      .where('operation_id', '=', operationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return {
      instance: json<InstanceView>(instance.document),
      operation: json<OperationView>(operation.document),
    };
  }

  private async writeDocuments(
    transaction: Transaction<PostgresDatabase>,
    instance: InstanceView,
    operation: OperationView,
    updatedAt: Date,
  ): Promise<void> {
    await transaction
      .updateTable('projection.instances')
      .set({ document: instance, updated_at: updatedAt })
      .where('instance_id', '=', instance.id)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('projection.operations')
      .set({ document: operation, updated_at: updatedAt })
      .where('operation_id', '=', operation.id)
      .executeTakeFirstOrThrow();
  }
}
