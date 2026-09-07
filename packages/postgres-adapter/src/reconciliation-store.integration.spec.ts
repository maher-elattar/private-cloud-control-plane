/**
 * Integration coverage for the reconciliation store.
 *
 * The claim query is the part that needs a real database: `FOR UPDATE ... SKIP LOCKED` and the
 * `last_reconciled_at` stamp are what let several reconciler replicas sweep in parallel without
 * observing the same instance twice, and neither is observable against a stub.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';
import { PostgresReconciliationStore } from './reconciliation-store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const store = new PostgresReconciliationStore(db);
const projectId = '00000000-0000-4000-8000-000000000001';

/** Seeds an instance with a completed create workflow, which is what makes it observable. */
async function reconcilableInstance(lifecycleState = 'active'): Promise<string> {
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
      hostname: `rec-${instanceId.slice(0, 8)}`,
      ssh_public_keys: JSON.stringify([]),
      desired_cpu_count: 2,
      desired_memory_mib: '4096',
      desired_disk_gib: '32',
      desired_power_state: 'running',
      lifecycle_state: lifecycleState,
      create_operation_id: operationId,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('workflow.workflows')
    .values({
      operation_id: operationId,
      event_id: randomUUID(),
      project_id: projectId,
      instance_id: instanceId,
      action: 'create_instance',
      command: JSON.stringify({}),
      status: 'succeeded',
      stage: 'completed',
      attempt: 1,
      stage_attempt: 0,
      replay_generation: 0,
      fencing_token: '1',
      provider_resource_id: '910001',
      trace_context: JSON.stringify({}),
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return instanceId;
}

beforeEach(() => resetIntegrationState(db));
afterAll(async () => {
  await db.destroy();
});

describe('claimStaleInstances', () => {
  it('claims an instance that has never been reconciled', async () => {
    const instanceId = await reconcilableInstance();
    const claimed = await store.claimStaleInstances(10, new Date());
    expect(claimed.map((candidate) => candidate.instanceId)).toContain(instanceId);
    const candidate = claimed.find((entry) => entry.instanceId === instanceId);
    expect(candidate?.providerResourceId).toBe('910001');
    expect(candidate?.desiredCpuCount).toBe(2);
  });

  it('does not claim the same instance twice in a row', async () => {
    // The claim stamps `last_reconciled_at`, so a parallel replica skips it on its next pass.
    await reconcilableInstance();
    const first = await store.claimStaleInstances(10, new Date());
    expect(first).toHaveLength(1);
    const second = await store.claimStaleInstances(10, new Date(Date.now() - 60_000));
    expect(second).toHaveLength(0);
  });

  it('skips instances with no provider resource to observe', async () => {
    // Nothing exists on the provider until a create workflow has recorded a resource.
    await db
      .insertInto('control.instances')
      .values({
        id: randomUUID(),
        project_id: projectId,
        image_id: 'ubuntu-24-04-cloud',
        flavor_id: 'lab-small',
        network_id: 'lab-primary',
        provider_profile_id: 'fake-lab',
        hostname: 'no-resource',
        ssh_public_keys: JSON.stringify([]),
        desired_cpu_count: 2,
        desired_memory_mib: '4096',
        desired_disk_gib: '32',
        desired_power_state: 'running',
        lifecycle_state: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    expect(await store.claimStaleInstances(10, new Date())).toHaveLength(0);
  });

  it('never claims a purged instance', async () => {
    await reconcilableInstance('purged');
    expect(await store.claimStaleInstances(10, new Date())).toHaveLength(0);
  });

  it('honours the batch size', async () => {
    await reconcilableInstance();
    await reconcilableInstance();
    await reconcilableInstance();
    expect(await store.claimStaleInstances(2, new Date())).toHaveLength(2);
  });
});

describe('recordObservation', () => {
  it('records observed state without publishing an event when nothing drifted', async () => {
    const instanceId = await reconcilableInstance();
    await store.recordObservation({
      instanceId,
      projectId,
      drift: 'none',
      dangerous: false,
      exists: true,
      powerState: 'running',
      markerMatch: true,
      observedAt: new Date(),
    });

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instance.drift).toBe('none');
    expect(instance.observed_power_state).toBe('running');
    // No finding, no event: a quiet sweep must not fill the topic with non-news.
    expect(await db.selectFrom('control.outbox').selectAll().execute()).toEqual([]);
  });

  it('publishes a drift event to the reconciliation topic when something differs', async () => {
    const instanceId = await reconcilableInstance();
    await store.recordObservation({
      instanceId,
      projectId,
      drift: 'missing_resource',
      dangerous: true,
      exists: false,
      powerState: 'unknown',
      markerMatch: false,
      observedAt: new Date(),
    });

    const outbox = await db.selectFrom('control.outbox').selectAll().executeTakeFirstOrThrow();
    expect(outbox.topic).toBe('reconciliation.events.v1');
    expect(outbox.partition_key).toBe(instanceId);
    const payload = outbox.payload as unknown as { data: Record<string, unknown> };
    expect(payload.data['classification']).toBe('missing_resource');
    // The flag a consumer uses to decide between acting and raising a manual review.
    expect(payload.data['dangerous']).toBe(true);
  });

  it('records the drift classification on the instance for querying', async () => {
    const instanceId = await reconcilableInstance();
    await store.recordObservation({
      instanceId,
      projectId,
      drift: 'power_drift',
      dangerous: false,
      exists: true,
      powerState: 'stopped',
      markerMatch: true,
      observedAt: new Date(),
    });
    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instance.drift).toBe('power_drift');
    expect(instance.observed_exists).toBe(true);
  });
});
