/**
 * Integration coverage for the read projection's observed-state handling.
 *
 * Capability 1 is "list, inspect, and observed status", and the interesting half is the last one.
 * Before this checkpoint the projection asserted `exists: true`, `powerState: 'running'`, and
 * `markerMatch: true` as constants and nulled every measurement, so the read model reported four
 * facts it had never measured. These tests pin the corrected behaviour in both places the state
 * now lands: the `Instance` document and the queryable columns.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { InstanceMutationCompletedV1 } from '@private-cloud/contracts';
import type { InstanceView, MessageDeliveryIdentity } from '@private-cloud/application';
import { createPostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';
import { PostgresProjectionStore } from './projection-store.js';
import { parseJsonColumn } from './column-codec.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const store = new PostgresProjectionStore(db);
const projectId = '00000000-0000-4000-8000-000000000001';

let offset = 0;
function delivery(): MessageDeliveryIdentity {
  offset += 1;
  return {
    topic: 'provisioning.events.v1',
    partition: 0,
    offset: String(offset),
    replayGeneration: 0,
  };
}

/** Seeds an instance mid-provisioning plus its operation and both projection documents. */
async function seedProvisioning(): Promise<{ instanceId: string; operationId: string }> {
  const instanceId = randomUUID();
  const operationId = randomUUID();
  const now = new Date();
  await db
    .insertInto('control.instances')
    .values({
      id: instanceId,
      project_id: projectId,
      image_id: 'ubuntu-24-04-cloud',
      flavor_id: 'lab-small',
      network_id: 'lab-primary',
      provider_profile_id: 'fake-lab',
      hostname: `obs-${instanceId.slice(0, 8)}`,
      ssh_public_keys: JSON.stringify([]),
      desired_cpu_count: 2,
      desired_memory_mib: '4096',
      desired_disk_gib: '32',
      desired_power_state: 'running',
      lifecycle_state: 'provisioning',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('control.operations')
    .values({
      id: operationId,
      project_id: projectId,
      action: 'create_instance',
      target_type: 'instance',
      target_id: instanceId,
      state: 'running',
      stage: 'observing',
      progress_percent: 92,
      accepted_at: now,
      updated_at: now,
      manual_review_required: false,
    })
    .execute();
  await db
    .updateTable('control.instances')
    .set({ active_operation_id: operationId })
    .where('id', '=', instanceId)
    .execute();

  const instanceDocument: InstanceView = {
    id: instanceId,
    projectId,
    lifecycleState: 'provisioning',
    desired: {
      imageId: 'ubuntu-24-04-cloud',
      flavorId: 'lab-small',
      networkId: 'lab-primary',
      hostname: 'obs',
      powerState: 'running',
      retentionRequested: false,
    },
    observed: null,
    ipv4Lease: null,
    activeOperationId: operationId,
    drift: 'none',
    lastReconciledAt: null,
    retentionDeadline: null,
    purgeEligible: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await db
    .insertInto('projection.instances')
    .values({
      instance_id: instanceId,
      project_id: projectId,
      document: instanceDocument,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('projection.operations')
    .values({
      operation_id: operationId,
      project_id: projectId,
      target_id: instanceId,
      document: {
        id: operationId,
        projectId,
        action: 'create_instance',
        targetType: 'instance',
        targetId: instanceId,
        state: 'running',
        stage: 'observing',
        progressPercent: 92,
        acceptedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        manualReviewRequired: false,
      },
      updated_at: now,
    })
    .execute();
  return { instanceId, operationId };
}

function completedEvent(
  ids: { instanceId: string; operationId: string },
  observed?: InstanceMutationCompletedV1['data']['observed'],
): InstanceMutationCompletedV1 {
  return {
    eventId: randomUUID(),
    schemaName: 'instance.mutation.completed',
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: ids.instanceId,
    projectId,
    operationId: ids.operationId,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    partitionKey: ids.instanceId,
    data: {
      action: 'create_instance',
      lifecycleState: 'active',
      providerResourceId: '910001',
      evidenceId: randomUUID(),
      ...(observed ? { observed } : {}),
    },
  } as InstanceMutationCompletedV1;
}

beforeEach(() => resetIntegrationState(db));
afterAll(async () => {
  await db.destroy();
});

/**
 * Seeds a snapshot in `creating`, plus the operation that created it, as acceptance would.
 *
 * @param instanceId Instance the snapshot belongs to.
 * @returns The snapshot and operation identifiers.
 */
async function seedSnapshot(
  instanceId: string,
): Promise<{ snapshotId: string; operationId: string; name: string }> {
  const snapshotId = randomUUID();
  const operationId = randomUUID();
  const name = `snap-${snapshotId.slice(0, 8)}`;
  const now = new Date();
  await db
    .insertInto('control.snapshots')
    .values({
      id: snapshotId,
      project_id: projectId,
      instance_id: instanceId,
      name,
      description: null,
      state: 'creating',
      provider_snapshot_name: name,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('projection.snapshots')
    .values({
      snapshot_id: snapshotId,
      project_id: projectId,
      instance_id: instanceId,
      document: {
        id: snapshotId,
        instanceId,
        name,
        description: null,
        state: 'creating',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('control.operations')
    .values({
      id: operationId,
      project_id: projectId,
      action: 'create_snapshot',
      target_type: 'snapshot',
      target_id: snapshotId,
      state: 'running',
      stage: 'observing_snapshot',
      progress_percent: 85,
      accepted_at: now,
      updated_at: now,
      manual_review_required: false,
    })
    .execute();
  await db
    .insertInto('projection.operations')
    .values({
      operation_id: operationId,
      project_id: projectId,
      target_id: snapshotId,
      document: {
        id: operationId,
        projectId,
        action: 'create_snapshot',
        targetType: 'snapshot',
        targetId: snapshotId,
        state: 'running',
        stage: 'observing_snapshot',
        progressPercent: 85,
        acceptedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        manualReviewRequired: false,
      },
      updated_at: now,
    })
    .execute();
  return { snapshotId, operationId, name };
}

describe('snapshot settlement on completion', () => {
  it('moves a created snapshot out of `creating` so it can be used', async () => {
    // The bug this guards: nothing advanced the snapshot after acceptance. The workflow succeeded
    // and the operation reported `succeeded`, but the snapshot stayed `creating` — and both
    // rollback and delete refuse anything that is not `available`, answering INSTANCE_BUSY. A
    // snapshot could be taken and then never used, with no error anywhere to explain why.
    const ids = await seedProvisioning();
    const snapshot = await seedSnapshot(ids.instanceId);
    const event = completedEvent({ instanceId: ids.instanceId, operationId: snapshot.operationId });

    await store.applyWorkflowEvent(
      { ...event, data: { ...event.data, action: 'create_snapshot' } } as typeof event,
      delivery(),
    );

    const row = await db
      .selectFrom('control.snapshots')
      .select('state')
      .where('id', '=', snapshot.snapshotId)
      .executeTakeFirst();
    const projected = await db
      .selectFrom('projection.snapshots')
      .select('document')
      .where('snapshot_id', '=', snapshot.snapshotId)
      .executeTakeFirst();

    expect(row?.state).toBe('available');
    expect(parseJsonColumn<{ state: string }>(projected?.document).state).toBe('available');
  });

  it('removes both rows when a snapshot is deleted, freeing its name', async () => {
    // A tombstone would keep `UNIQUE (instance_id, name)` occupied and refuse the same snapshot
    // name for the rest of the instance's life.
    const ids = await seedProvisioning();
    const snapshot = await seedSnapshot(ids.instanceId);
    const event = completedEvent({ instanceId: ids.instanceId, operationId: snapshot.operationId });

    await store.applyWorkflowEvent(
      { ...event, data: { ...event.data, action: 'delete_snapshot' } } as typeof event,
      delivery(),
    );

    const row = await db
      .selectFrom('control.snapshots')
      .select('id')
      .where('id', '=', snapshot.snapshotId)
      .executeTakeFirst();
    const projected = await db
      .selectFrom('projection.snapshots')
      .select('snapshot_id')
      .where('snapshot_id', '=', snapshot.snapshotId)
      .executeTakeFirst();

    expect(row).toBeUndefined();
    expect(projected).toBeUndefined();
  });
});

describe('observed state on completion', () => {
  it('publishes what the provider actually reported, in both the document and the columns', async () => {
    const ids = await seedProvisioning();
    const observedAt = '2026-09-04T10:00:00.000Z';
    await store.applyWorkflowEvent(
      completedEvent(ids, {
        exists: true,
        powerState: 'running',
        resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 },
        markerMatch: true,
        observedAt,
      }),
      delivery(),
    );

    const row = await db
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', ids.instanceId)
      .executeTakeFirstOrThrow();
    const document = parseJsonColumn<InstanceView>(row.document);
    expect(document.lifecycleState).toBe('active');
    expect(document.observed).toEqual({
      exists: true,
      powerState: 'running',
      cpuCount: 2,
      memoryMiB: 4096,
      diskGiB: 32,
      markerMatch: true,
      observedAt,
    });

    const columns = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', ids.instanceId)
      .executeTakeFirstOrThrow();
    expect(columns.observed_exists).toBe(true);
    expect(columns.observed_power_state).toBe('running');
    expect(columns.observed_cpu_count).toBe(2);
    expect(Number(columns.observed_memory_mib)).toBe(4096);
    expect(Number(columns.observed_disk_gib)).toBe(32);
    expect(columns.observed_marker_match).toBe(true);
    expect(columns.active_operation_id).toBeNull();
  });

  it('leaves sizing null when the provider reported none, rather than echoing desired', async () => {
    // Substituting desired sizing would make desired and observed agree by construction, hiding
    // exactly the drift reconciliation exists to find.
    const ids = await seedProvisioning();
    await store.applyWorkflowEvent(
      completedEvent(ids, {
        exists: true,
        powerState: 'running',
        markerMatch: true,
        observedAt: '2026-09-04T10:00:00.000Z',
      }),
      delivery(),
    );

    const row = await db
      .selectFrom('projection.instances')
      .select('document')
      .where('instance_id', '=', ids.instanceId)
      .executeTakeFirstOrThrow();
    const document = parseJsonColumn<InstanceView>(row.document);
    expect(document.observed?.cpuCount).toBeNull();
    expect(document.observed?.memoryMiB).toBeNull();
    expect(document.observed?.diskGiB).toBeNull();

    const columns = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', ids.instanceId)
      .executeTakeFirstOrThrow();
    expect(columns.observed_cpu_count).toBeNull();
    expect(columns.observed_memory_mib).toBeNull();
  });

  it('records a non-running observed power state instead of assuming running', async () => {
    const ids = await seedProvisioning();
    await store.applyWorkflowEvent(
      completedEvent(ids, {
        exists: true,
        powerState: 'stopped',
        markerMatch: false,
        observedAt: '2026-09-04T10:00:00.000Z',
      }),
      delivery(),
    );

    const columns = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', ids.instanceId)
      .executeTakeFirstOrThrow();
    expect(columns.observed_power_state).toBe('stopped');
    expect(columns.observed_marker_match).toBe(false);
  });

  it('deduplicates a redelivered terminal event', async () => {
    const ids = await seedProvisioning();
    const event = completedEvent(ids, {
      exists: true,
      powerState: 'running',
      markerMatch: true,
      observedAt: '2026-09-04T10:00:00.000Z',
    });
    const first = await store.applyWorkflowEvent(event, delivery());
    const second = await store.applyWorkflowEvent(event, delivery());

    expect(first).toBe('applied');
    expect(second).toBe('duplicate');
  });
});
