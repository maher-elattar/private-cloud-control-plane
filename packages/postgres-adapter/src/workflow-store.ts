import type {
  ClaimedCreateWorkflow,
  WorkflowEvent,
  WorkflowStore,
} from '@private-cloud/application';
import type { InstanceCreateRequestedV1 } from '@private-cloud/contracts';
import { canonicalSha256 } from '@private-cloud/domain';
import { sql, type Transaction } from 'kysely';
import type { PostgresClient, PostgresDatabase } from './database.js';

function json<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function createCommand(value: unknown): InstanceCreateRequestedV1 {
  const command = json<Partial<InstanceCreateRequestedV1>>(value);
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

interface CommandRow {
  readonly event_id: string;
  readonly payload: unknown;
}

export class PostgresWorkflowStore implements WorkflowStore {
  public constructor(private readonly db: PostgresClient) {}

  public claimNextCreate(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ClaimedCreateWorkflow | null> {
    if (!workerId || !Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error('A worker ID and a lease between 5 and 300 seconds are required.');
    }
    return this.db.transaction().execute(async (transaction) => {
      let workflow = await this.readyWorkflow(transaction, workerId);
      if (!workflow) workflow = await this.receiveCommand(transaction);
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
      `.execute(transaction);
      const fencingToken = lease.rows[0]?.fencing_token;
      if (!fencingToken) return null;

      const claimed = await transaction
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
        stage: claimed.stage,
        attempt: claimed.attempt,
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

  public checkpoint(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly stage: string;
    readonly providerResourceId?: string;
    readonly providerTaskReference?: string | null;
    readonly nextAttemptAt?: Date;
    readonly event: WorkflowEvent;
  }): Promise<void> {
    return this.db.transaction().execute(async (transaction) => {
      const workflow = await this.assertLease(transaction, input);
      const nextAttemptAt = input.nextAttemptAt ?? new Date();
      await transaction
        .updateTable('workflow.workflows')
        .set({
          status: input.nextAttemptAt ? 'retry_wait' : 'running',
          stage: input.stage,
          ...(input.providerResourceId ? { provider_resource_id: input.providerResourceId } : {}),
          ...('providerTaskReference' in input
            ? { provider_task_reference: input.providerTaskReference ?? null }
            : {}),
          next_attempt_at: nextAttemptAt,
          updated_at: new Date(),
        })
        .where('operation_id', '=', input.operationId)
        .where('fencing_token', '=', String(input.fencingToken))
        .executeTakeFirstOrThrow();
      await this.writeEvent(transaction, input.event);
      await this.releaseLease(transaction, workflow.instance_id, input);
    });
  }

  public complete(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly status: 'succeeded' | 'failed' | 'manual_review';
    readonly event: WorkflowEvent;
  }): Promise<void> {
    return this.db.transaction().execute(async (transaction) => {
      const workflow = await this.assertLease(transaction, input);
      const now = new Date();
      const failed =
        input.event.schemaName === 'instance.mutation.failed' ? input.event.data.failure : null;
      await transaction
        .updateTable('workflow.workflows')
        .set({
          status: input.status,
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
      await transaction
        .updateTable('workflow.command_receipts')
        .set({ completed_at: now })
        .where('event_id', '=', workflow.event_id)
        .executeTakeFirstOrThrow();
      await this.writeEvent(transaction, input.event);
      await this.releaseLease(transaction, workflow.instance_id, input);
    });
  }

  private async readyWorkflow(
    transaction: Transaction<PostgresDatabase>,
    workerId: string,
  ): Promise<WorkflowRow | null> {
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
    `.execute(transaction);
    return result.rows[0] ?? null;
  }

  private async receiveCommand(
    transaction: Transaction<PostgresDatabase>,
  ): Promise<WorkflowRow | null> {
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
    `.execute(transaction);
    const row = result.rows[0];
    if (!row) return null;
    const command = createCommand(row.payload);
    const now = new Date();
    await transaction
      .insertInto('workflow.command_receipts')
      .values({
        event_id: command.eventId,
        consumer_name: 'provisioning-orchestrator.phase3',
        payload_hash: canonicalSha256(command),
        received_at: now,
        completed_at: null,
      })
      .execute();
    const inserted = await transaction
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
    return inserted;
  }

  private async assertLease(
    transaction: Transaction<PostgresDatabase>,
    input: {
      readonly operationId: string;
      readonly workerId: string;
      readonly fencingToken: bigint;
    },
  ): Promise<WorkflowRow> {
    const workflow = await transaction
      .selectFrom('workflow.workflows')
      .selectAll()
      .where('operation_id', '=', input.operationId)
      .forUpdate()
      .executeTakeFirst();
    if (!workflow || BigInt(workflow.fencing_token) !== input.fencingToken) {
      throw new Error('Workflow fencing token is stale.');
    }
    const lease = await transaction
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

  private writeEvent(
    transaction: Transaction<PostgresDatabase>,
    event: WorkflowEvent,
  ): Promise<unknown> {
    return transaction
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

  private releaseLease(
    transaction: Transaction<PostgresDatabase>,
    instanceId: string,
    input: { readonly workerId: string; readonly fencingToken: bigint },
  ): Promise<unknown> {
    return transaction
      .updateTable('workflow.instance_leases')
      .set({ leased_until: new Date(), updated_at: new Date() })
      .where('instance_id', '=', instanceId)
      .where('owner_id', '=', input.workerId)
      .where('fencing_token', '=', String(input.fencingToken))
      .executeTakeFirst();
  }
}
