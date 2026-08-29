import { sql } from 'kysely';
import type { PostgresClient } from './database.js';

/** Snapshot consumed by low-cardinality outbox gauges. */
export interface OutboxBacklog {
  readonly count: number;
  readonly oldestAgeSeconds: number;
}

/** Snapshot consumed by workflow scheduler gauges. */
export interface WorkflowActivity {
  readonly active: number;
  readonly oldestReadyAgeSeconds: number;
}

/** Reads non-terminal workflow count and the age of the oldest claimable checkpoint. */
export async function readWorkflowActivity(db: PostgresClient): Promise<WorkflowActivity> {
  const result = await sql<{ active: string; oldest_ready_age_seconds: string | null }>`
    SELECT
      count(*) FILTER (WHERE w.status IN ('running', 'retry_wait'))::text AS active,
      extract(epoch FROM (
        now() - min(w.next_attempt_at) FILTER (
          WHERE w.status IN ('running', 'retry_wait')
            AND w.next_attempt_at <= now()
            AND (l.instance_id IS NULL OR l.leased_until <= now())
        )
      ))::text AS oldest_ready_age_seconds
    FROM workflow.workflows w
    LEFT JOIN workflow.instance_leases l ON l.instance_id = w.instance_id
  `.execute(db);
  const row = result.rows[0];
  return {
    active: Number.parseInt(row?.active ?? '0', 10),
    oldestReadyAgeSeconds: Math.max(
      0,
      Number.parseFloat(row?.oldest_ready_age_seconds ?? '0') || 0,
    ),
  };
}

/** Reads one logical owner's unconsumed outbox backlog. */
export async function readOutboxBacklog(
  db: PostgresClient,
  owner: 'control' | 'workflow',
): Promise<OutboxBacklog> {
  const query =
    owner === 'control'
      ? sql<{ count: string; oldest_age_seconds: string | null }>`
          SELECT count(*)::text AS count,
            extract(epoch FROM (now() - min(o.created_at)))::text AS oldest_age_seconds
          FROM control.outbox o
          WHERE NOT EXISTS (
            SELECT 1
            FROM workflow.command_receipts r
            WHERE r.consumer_name = 'provisioning-orchestrator.v1'
              AND r.event_id = o.event_id
              AND r.replay_generation = o.replay_generation
          )
            AND NOT EXISTS (
              SELECT 1
              FROM workflow.dead_letters d
              WHERE d.original_event_id = o.event_id
            )
        `
      : sql<{ count: string; oldest_age_seconds: string | null }>`
          SELECT count(*)::text AS count,
            extract(epoch FROM (now() - min(o.created_at)))::text AS oldest_age_seconds
          FROM workflow.outbox o
          WHERE NOT EXISTS (
            SELECT 1
            FROM projection.event_receipts r
            WHERE r.event_id = o.event_id
              AND r.replay_generation = o.replay_generation
              AND r.consumer_name = CASE
                WHEN o.topic = 'provisioning.dlq.v1' THEN 'control-api.provisioning-dlq.v1'
                ELSE 'control-api.provisioning-events.v1'
              END
          )
        `;
  const result = await query.execute(db);
  const row = result.rows[0];
  return {
    count: Number.parseInt(row?.count ?? '0', 10),
    oldestAgeSeconds: Math.max(0, Number.parseFloat(row?.oldest_age_seconds ?? '0') || 0),
  };
}
