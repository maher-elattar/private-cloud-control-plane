/**
 * Integration coverage for the per-instance concurrency guard.
 *
 * The race this guards cannot be demonstrated without a real database: two transactions both read
 * `active_operation_id IS NULL`, both pass a naive check, and both commit. Only `FOR UPDATE`
 * makes the loser wait and observe the winner's commit.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';
import { lockInstanceForMutation } from './instance-guard.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const projectId = '00000000-0000-4000-8000-000000000001';

/** Inserts one instance in the given lifecycle state and returns its id. */
async function seedInstance(
  lifecycleState = 'active',
  activeOperationId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('control.instances')
    .values({
      id,
      project_id: projectId,
      image_id: 'ubuntu-24-04-cloud',
      flavor_id: 'lab-small',
      network_id: 'lab-primary',
      provider_profile_id: 'fake-lab',
      hostname: `guard-${id.slice(0, 8)}`,
      ssh_public_keys: JSON.stringify([]),
      desired_cpu_count: 2,
      desired_memory_mib: '4096',
      desired_disk_gib: '32',
      desired_power_state: 'running',
      lifecycle_state: lifecycleState,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  if (activeOperationId) {
    await db
      .insertInto('control.operations')
      .values({
        id: activeOperationId,
        project_id: projectId,
        action: 'power_instance',
        target_type: 'instance',
        target_id: id,
        state: 'running',
        stage: 'accepted',
        progress_percent: 0,
        accepted_at: new Date(),
        updated_at: new Date(),
        manual_review_required: false,
      })
      .execute();
    await db
      .updateTable('control.instances')
      .set({ active_operation_id: activeOperationId })
      .where('id', '=', id)
      .execute();
  }
  return id;
}

beforeEach(() => resetIntegrationState(db));
afterAll(async () => {
  await db.destroy();
});

describe('lockInstanceForMutation', () => {
  it('returns the locked instance when it is active and idle', async () => {
    const id = await seedInstance('active');
    const guarded = await db
      .transaction()
      .execute((tx) => lockInstanceForMutation(tx, projectId, id));

    expect(guarded.id).toBe(id);
    expect(guarded.lifecycleState).toBe('active');
    expect(guarded.desiredCpuCount).toBe(2);
    // bigint columns arrive as strings from the driver; the guard must hand back numbers.
    expect(guarded.desiredMemoryMib).toBe(4096);
    expect(guarded.desiredDiskGib).toBe(32);
  });

  it('reports INSTANCE_BUSY while another operation is in flight', async () => {
    const id = await seedInstance('active', randomUUID());
    await expect(
      db.transaction().execute((tx) => lockInstanceForMutation(tx, projectId, id)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_BUSY' }));
  });

  it('refuses lifecycle states that cannot accept a further mutation', async () => {
    for (const state of ['provisioning', 'updating', 'retained', 'purged', 'manual_review']) {
      const id = await seedInstance(state);
      await expect(
        db.transaction().execute((tx) => lockInstanceForMutation(tx, projectId, id)),
      ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_BUSY' }));
    }
  });

  it('reports an instance in another project as missing, not forbidden', async () => {
    // Returning a distinct error would confirm the instance exists to a caller with no access.
    const id = await seedInstance('active');
    await expect(
      db.transaction().execute((tx) => lockInstanceForMutation(tx, randomUUID(), id)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_NOT_FOUND' }));
  });

  it('serialises two concurrent mutations so only the first is accepted', async () => {
    const id = await seedInstance('active');

    // Each transaction takes the guard, then claims the instance exactly as an acceptance would.
    const attempt = async (operationId: string) =>
      db.transaction().execute(async (tx) => {
        await lockInstanceForMutation(tx, projectId, id);
        await tx
          .insertInto('control.operations')
          .values({
            id: operationId,
            project_id: projectId,
            action: 'power_instance',
            target_type: 'instance',
            target_id: id,
            state: 'accepted',
            stage: 'accepted',
            progress_percent: 0,
            accepted_at: new Date(),
            updated_at: new Date(),
            manual_review_required: false,
          })
          .execute();
        await tx
          .updateTable('control.instances')
          .set({ active_operation_id: operationId })
          .where('id', '=', id)
          .execute();
        return operationId;
      });

    const results = await Promise.allSettled([attempt(randomUUID()), attempt(randomUUID())]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      reason: expect.objectContaining({ code: 'INSTANCE_BUSY' }),
    });
  });
});
