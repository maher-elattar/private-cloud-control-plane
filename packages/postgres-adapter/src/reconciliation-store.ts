/**
 * PostgreSQL adapter for the `ReconciliationStore` port.
 *
 * PATTERN — Read projection plus transactional outbox, with one deliberate omission: this store
 * has no method that destroys, shrinks, detaches, or overwrites anything on a provider. SAFE-029
 * makes that a rule; giving the reconciler a port that cannot express destruction makes it a
 * property of the code rather than a discipline someone has to maintain.
 *
 * @see docs/architecture/safety-invariants.md
 * @see docs/adr/0008-non-destructive-reconciliation.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { ReconciliationCandidate, ReconciliationOutcome } from '@private-cloud/application';
import type { ReconciliationStore } from '@private-cloud/application';
import type { PostgresClient } from './database.js';
import { serializeDebeziumTraceContext } from './trace-carrier.js';

/** Reconciliation events are published on their own topic, consumed by the Control API. */
const RECONCILIATION_TOPIC = 'reconciliation.events.v1';

/** Reads and records reconciliation state. */
export class PostgresReconciliationStore implements ReconciliationStore {
  /** @param db Kysely client owned by the reconciler's DI container. */
  public constructor(private readonly db: PostgresClient) {}

  /**
   * Claims the instances least recently reconciled.
   *
   * `FOR UPDATE ... SKIP LOCKED` lets several reconciler replicas sweep in parallel without any of
   * them waiting on another, and `last_reconciled_at` is stamped inside the same transaction so a
   * concurrent sweep does not pick the same instance again.
   *
   * Instances that have never been created on a provider are excluded: there is nothing to observe
   * until a create workflow has recorded a provider resource.
   */
  public async claimStaleInstances(
    limit: number,
    staleAfter: Date,
  ): Promise<readonly ReconciliationCandidate[]> {
    return this.db.transaction().execute(async (tx) => {
      const rows = await sql<{
        id: string;
        project_id: string;
        provider_profile_id: string;
        create_operation_id: string | null;
        lifecycle_state: string;
        desired_power_state: string;
        desired_cpu_count: number;
        desired_memory_mib: string;
        desired_disk_gib: string;
        provider_resource_id: string | null;
      }>`
        SELECT i.id, i.project_id, i.provider_profile_id, i.create_operation_id,
               i.lifecycle_state, i.desired_power_state, i.desired_cpu_count,
               i.desired_memory_mib, i.desired_disk_gib,
               (SELECT w.provider_resource_id
                  FROM workflow.workflows w
                 WHERE w.instance_id = i.id AND w.provider_resource_id IS NOT NULL
                 ORDER BY w.created_at
                 LIMIT 1) AS provider_resource_id
        FROM control.instances i
        WHERE i.lifecycle_state NOT IN ('purged', 'pending')
          AND (i.last_reconciled_at IS NULL OR i.last_reconciled_at <= ${staleAfter})
        ORDER BY i.last_reconciled_at NULLS FIRST
        FOR UPDATE OF i SKIP LOCKED
        LIMIT ${limit}
      `.execute(tx);

      const claimed = rows.rows.filter(
        (row) => row.provider_resource_id && row.create_operation_id,
      );
      if (claimed.length > 0) {
        // Stamped inside the claim so a parallel sweep skips these on its next pass, whether or
        // not the observation that follows succeeds.
        await tx
          .updateTable('control.instances')
          .set({ last_reconciled_at: new Date() })
          .where(
            'id',
            'in',
            claimed.map((row) => row.id),
          )
          .execute();
      }

      return claimed.map((row) => ({
        instanceId: row.id,
        projectId: row.project_id,
        providerProfileId: row.provider_profile_id,
        createOperationId: row.create_operation_id ?? '',
        providerResourceId: row.provider_resource_id ?? '',
        lifecycleState: row.lifecycle_state,
        desiredPowerState: row.desired_power_state,
        desiredCpuCount: row.desired_cpu_count,
        desiredMemoryMiB: Number(row.desired_memory_mib),
        desiredDiskGiB: Number(row.desired_disk_gib),
      }));
    });
  }

  /**
   * Records what a sweep observed and publishes the finding.
   *
   * The write and the event commit together, so a drift the database believes in is always one the
   * Control API will hear about. Note what is *not* here: no lifecycle change, no provider call,
   * no correction. Reconciliation reports.
   */
  public async recordObservation(outcome: ReconciliationOutcome): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('control.instances')
        .set({
          drift: outcome.drift,
          observed_exists: outcome.exists,
          observed_power_state: outcome.powerState,
          observed_marker_match: outcome.markerMatch,
          observed_at: outcome.observedAt,
          last_reconciled_at: outcome.observedAt,
          updated_at: new Date(),
        })
        .where('id', '=', outcome.instanceId)
        .execute();

      if (outcome.drift === 'none') return;

      const eventId = randomUUID();
      const occurredAt = outcome.observedAt.toISOString();
      const traceContext = { traceparent: generatedTraceparent() };
      await tx
        .insertInto('control.outbox')
        .values({
          outbox_id: randomUUID(),
          event_id: eventId,
          aggregate_id: outcome.instanceId,
          aggregate_type: 'instance',
          schema_name: 'drift.detected',
          schema_version: 1,
          topic: RECONCILIATION_TOPIC,
          partition_key: outcome.instanceId,
          payload: {
            eventId,
            schemaName: 'drift.detected',
            schemaVersion: 1,
            aggregateType: 'instance',
            aggregateId: outcome.instanceId,
            projectId: outcome.projectId,
            operationId: eventId,
            correlationId: eventId,
            causationId: eventId,
            occurredAt,
            traceContext,
            partitionKey: outcome.instanceId,
            data: {
              classification: outcome.drift,
              dangerous: outcome.dangerous,
              evidenceId: randomUUID(),
            },
          },
          tracingspancontext: serializeDebeziumTraceContext(traceContext),
          replay_generation: 0,
          occurred_at: outcome.observedAt,
          created_at: new Date(),
        })
        .execute();
    });
  }
}

/**
 * Builds a W3C traceparent for a sweep that has no inbound request to inherit from.
 *
 * A periodic sweep starts its own trace; generating a well-formed one here keeps every published
 * event carrying a valid carrier rather than an empty or all-zero placeholder.
 */
function generatedTraceparent(): string {
  const bytes = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 256))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  return `00-${bytes(16)}-${bytes(8)}-01`;
}
