/**
 * Shared fixtures for the container-backed integration suites.
 *
 * Excluded from the library build: this is test scaffolding, not part of the published adapter.
 *
 * WHY one shared reset rather than one per suite: the suites share a database and run in sequence,
 * so a suite that clears only the tables it writes leaves rows behind for the next one. That
 * surfaced as a foreign-key violation when the guard suite deleted operations that the acceptance
 * suite's idempotency records still referenced. Deleting everything, in dependency order, in one
 * place is the only version that stays correct as suites are added.
 */
import type { PostgresClient } from './database.js';

/**
 * The seeded project quota, mirrored from `db/seeds/0001_phase3_fake.sql`.
 *
 * Restored on every reset because quota is seed data that tests legitimately mutate — a resize
 * test has to tighten it to prove the delta check — and the seed's `ON CONFLICT DO NOTHING` cannot
 * put it back.
 */
const SEEDED_QUOTA = {
  instances: 20,
  cpu_count: 160,
  memory_mib: '327680',
  disk_gib: '2560',
  ipv4_addresses: 20,
  snapshots: 60,
};

/** The default retention policy, mirrored from migration `0007_phase5_lifecycle.sql`. */
const SEEDED_RETENTION_POLICY = {
  retention_hours: 168,
  lease_release_mode: 'quarantine_until_purge',
  updated_by: 'system:default',
};

/**
 * Removes every row the integration suites can create and restores mutated seed rows.
 *
 * The order matters: children before parents, because these are real foreign keys. Within
 * `control`, idempotency records and leases reference operations and instances, and
 * `active_operation_id` is a self-referential edge that has to be broken before operations go.
 *
 * Quota and retention policy are restored rather than deleted: they are configuration a test
 * legitimately mutates, and the seed's `ON CONFLICT DO NOTHING` cannot put a changed row back.
 */
export async function resetIntegrationState(db: PostgresClient): Promise<void> {
  await db.deleteFrom('workflow.poison_records').execute();
  await db.deleteFrom('workflow.replay_requests').execute();
  await db.deleteFrom('workflow.dead_letters').execute();
  await db.deleteFrom('workflow.outbox').execute();
  await db.deleteFrom('workflow.command_receipts').execute();
  await db.deleteFrom('workflow.instance_leases').execute();
  await db.deleteFrom('workflow.workflows').execute();

  await db.deleteFrom('projection.snapshots').execute();
  await db.deleteFrom('projection.operations').execute();
  await db.deleteFrom('projection.instances').execute();
  await db.deleteFrom('projection.dead_letters').execute();
  await db.deleteFrom('projection.event_receipts').execute();
  await db.deleteFrom('projection.poison_records').execute();

  await db.deleteFrom('audit.entries').execute();
  await db.deleteFrom('control.outbox').execute();
  await db.deleteFrom('control.replay_requests').execute();
  await db.deleteFrom('control.idempotency_records').execute();
  await db.deleteFrom('control.manual_reviews').execute();
  await db.deleteFrom('control.snapshots').execute();
  await db.deleteFrom('control.ipv4_leases').execute();
  // Break the instance-to-operation edge before deleting either side.
  await db.updateTable('control.instances').set({ active_operation_id: null }).execute();
  await db.deleteFrom('control.operations').execute();
  await db.deleteFrom('control.instances').execute();

  // Seed rows a test may have changed in place.
  await db
    .updateTable('control.quotas')
    .set({ ...SEEDED_QUOTA, updated_at: new Date() })
    .execute();
  await db
    .updateTable('control.retention_policy')
    .set({ ...SEEDED_RETENTION_POLICY, updated_at: new Date() })
    .execute();
}
