/**
 * Integration coverage for the acceptance transaction against a real PostgreSQL.
 *
 * WHY these run against a container rather than a stub: every guarantee under test is a property
 * of the database, not of the TypeScript around it. `pg_advisory_xact_lock` serialising two
 * concurrent inserts, a unique constraint rejecting a second lease on one address, and a
 * transaction rolling back as a unit are all invisible to a fake — a stub would only confirm the
 * query string had not changed.
 *
 * @see deploy/local/compose.test.yaml
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256, DomainError } from '@private-cloud/domain';
import type {
  Actor,
  CreateInstanceCommand,
  PowerInstanceCommand,
} from '@private-cloud/application';
import { createPostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';
import { PostgresControlPlaneStore } from './control-plane-store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const store = new PostgresControlPlaneStore(db);
const projectId = '00000000-0000-4000-8000-000000000001';

const actor: Actor = {
  subject: 'integration-actor',
  roles: ['tenant_developer'],
  projects: [projectId],
};

function command(overrides: Partial<CreateInstanceCommand> = {}): CreateInstanceCommand {
  return {
    actor,
    projectId,
    idempotencyKey: `key-${randomUUID()}`,
    correlationId: randomUUID(),
    traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    networkId: 'lab-primary',
    hostname: `host-${randomUUID().slice(0, 8)}`,
    sshPublicKeys: [],
    ...overrides,
  };
}

const hashOf = (input: CreateInstanceCommand) =>
  canonicalSha256({
    actor: input.actor.subject,
    projectId: input.projectId,
    operation: 'create_instance',
    imageId: input.imageId,
    flavorId: input.flavorId,
    networkId: input.networkId,
    hostname: input.hostname,
    sshPublicKeys: [...input.sshPublicKeys].sort(),
  });

beforeEach(() => resetIntegrationState(db));
afterAll(async () => {
  await db.destroy();
});

describe('acceptCreate', () => {
  it('writes instance, operation, lease, outbox, audit, and both projections in one transaction', async () => {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));

    expect(accepted.replayed).toBe(false);
    const counts = await db
      .selectNoFrom((eb) => [
        eb.selectFrom('control.instances').select(eb.fn.countAll().as('n')).as('instances'),
        eb.selectFrom('control.operations').select(eb.fn.countAll().as('n')).as('operations'),
        eb.selectFrom('control.ipv4_leases').select(eb.fn.countAll().as('n')).as('leases'),
        eb.selectFrom('control.outbox').select(eb.fn.countAll().as('n')).as('outbox'),
        eb.selectFrom('audit.entries').select(eb.fn.countAll().as('n')).as('audit'),
        eb.selectFrom('projection.instances').select(eb.fn.countAll().as('n')).as('projInstances'),
        eb
          .selectFrom('projection.operations')
          .select(eb.fn.countAll().as('n'))
          .as('projOperations'),
      ])
      .executeTakeFirstOrThrow();

    expect(Number(counts.instances)).toBe(1);
    expect(Number(counts.operations)).toBe(1);
    expect(Number(counts.leases)).toBe(1);
    // Two outbox rows: the provisioning command and the `audit.recorded` fact.
    expect(Number(counts.outbox)).toBe(2);
    expect(Number(counts.audit)).toBe(1);
    // Both projections are seeded eagerly so a client polling straight after its 202 finds them.
    expect(Number(counts.projInstances)).toBe(1);
    expect(Number(counts.projOperations)).toBe(1);
  });

  it('replays the stored response for a repeated key and creates no second resource', async () => {
    const input = command();
    const first = await store.acceptCreate(input, hashOf(input));
    const second = await store.acceptCreate(input, hashOf(input));

    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);
    expect(second.targetId).toBe(first.targetId);
    const instances = await db.selectFrom('control.instances').selectAll().execute();
    expect(instances).toHaveLength(1);
  });

  it('rejects a reused key carrying different input rather than replaying a wrong response', async () => {
    const input = command();
    await store.acceptCreate(input, hashOf(input));
    const altered = { ...input, hostname: `${input.hostname}-changed` };

    await expect(store.acceptCreate(altered, hashOf(altered))).rejects.toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(await db.selectFrom('control.instances').selectAll().execute()).toHaveLength(1);
  });

  it('serialises concurrent identical requests so exactly one instance is provisioned', async () => {
    // The race the advisory lock exists for: both transactions miss the idempotency SELECT because
    // the row they are racing to create does not exist yet, so a row lock cannot help.
    const input = command();
    const results = await Promise.all([
      store.acceptCreate(input, hashOf(input)),
      store.acceptCreate(input, hashOf(input)),
      store.acceptCreate(input, hashOf(input)),
    ]);

    const operationIds = new Set(results.map((result) => result.operationId));
    expect(operationIds.size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(2);
    expect(await db.selectFrom('control.instances').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('control.ipv4_leases').selectAll().execute()).toHaveLength(1);
  });

  it('gives concurrent distinct requests distinct addresses', async () => {
    // Different idempotency scopes take different advisory locks, so these serialise only on the
    // network lock. That is the guard proving two instances never share one address.
    const results = await Promise.all([
      store.acceptCreate(command(), randomUUID().replaceAll('-', '').padEnd(64, '0')),
      store.acceptCreate(command(), randomUUID().replaceAll('-', '').padEnd(64, '0')),
      store.acceptCreate(command(), randomUUID().replaceAll('-', '').padEnd(64, '0')),
    ]);

    expect(new Set(results.map((result) => result.targetId)).size).toBe(3);
    const leases = await db.selectFrom('control.ipv4_leases').selectAll().execute();
    expect(leases).toHaveLength(3);
    expect(new Set(leases.map((lease) => lease.address)).size).toBe(3);
    expect(leases.every((lease) => lease.state === 'active')).toBe(true);
  });

  it('never leases the gateway, network, broadcast, or an excluded address', async () => {
    // SAFE-024. The seeded network is 192.0.2.0/27 with gateway .1 and .2 excluded.
    const accepted = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.acceptCreate(command(), randomUUID().replaceAll('-', '').padEnd(64, '0')),
      ),
    );
    expect(accepted).toHaveLength(5);

    const leases = await db.selectFrom('control.ipv4_leases').select('address').execute();
    const forbidden = new Set(['192.0.2.0', '192.0.2.1', '192.0.2.2', '192.0.2.31']);
    expect(leases.filter((lease) => forbidden.has(lease.address))).toEqual([]);
  });

  it('rolls the whole acceptance back when the request names an unknown catalog entry', async () => {
    await expect(
      store.acceptCreate(command({ imageId: 'does-not-exist' }), 'a'.repeat(64)),
    ).rejects.toThrowError(DomainError);

    // Nothing may survive a failed acceptance — an orphan lease would leak an address forever.
    expect(await db.selectFrom('control.instances').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('control.ipv4_leases').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('control.outbox').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('audit.entries').selectAll().execute()).toEqual([]);
  });

  it('routes the provisioning command and the audit fact to their declared topics', async () => {
    const input = command();
    await store.acceptCreate(input, hashOf(input));
    const rows = await db.selectFrom('control.outbox').select(['topic', 'schema_name']).execute();

    expect(new Set(rows.map((row) => row.topic))).toEqual(
      new Set(['provisioning.commands.v1', 'audit.events.v1']),
    );
    expect(rows.every((row) => row.schema_name.length > 0)).toBe(true);
  });
});

describe('acceptPowerAction', () => {
  /** Creates an instance and moves it to `active`, which is where power requests are accepted. */
  async function activeInstance(): Promise<{ instanceId: string; createOperationId: string }> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null })
      .where('id', '=', accepted.targetId)
      .execute();
    return { instanceId: accepted.targetId, createOperationId: accepted.operationId };
  }

  function powerCommand(instanceId: string, action: PowerInstanceCommand['action'] = 'start') {
    return {
      actor,
      projectId,
      instanceId,
      idempotencyKey: `power-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      action,
    } satisfies PowerInstanceCommand;
  }

  it('commits the operation, outbox command, and audit fact, and marks the instance busy', async () => {
    const { instanceId, createOperationId } = await activeInstance();
    const accepted = await store.acceptPowerAction(powerCommand(instanceId), 'a'.repeat(64));

    expect(accepted.replayed).toBe(false);
    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instance.active_operation_id).toBe(accepted.operationId);
    expect(instance.desired_power_state).toBe('running');

    const outbox = await db
      .selectFrom('control.outbox')
      .selectAll()
      .where('schema_name', '=', 'instance.power.requested')
      .executeTakeFirstOrThrow();
    expect(outbox.topic).toBe('provisioning.commands.v1');
    // Partitioned by instance so commands touching one VM stay ordered behind each other.
    expect(outbox.partition_key).toBe(instanceId);

    const payload = outbox.payload as unknown as { data: Record<string, unknown> };
    expect(payload.data['action']).toBe('start');
    // The markers on the VM were written by create; presenting this operation's id would make the
    // provider refuse to touch its own resource.
    expect(payload.data['createOperationId']).toBe(createOperationId);
    expect(payload.data['providerProfileId']).toBe('fake-lab');
  });

  it('refuses a second power request while one is already in flight', async () => {
    const { instanceId } = await activeInstance();
    await store.acceptPowerAction(powerCommand(instanceId), 'a'.repeat(64));

    await expect(
      store.acceptPowerAction(powerCommand(instanceId, 'stop'), 'b'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_BUSY' }));
  });

  it('replays a repeated key without accepting a second operation', async () => {
    const { instanceId } = await activeInstance();
    const input = powerCommand(instanceId);
    const first = await store.acceptPowerAction(input, 'a'.repeat(64));
    const second = await store.acceptPowerAction(input, 'a'.repeat(64));

    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);
    const operations = await db
      .selectFrom('control.operations')
      .selectAll()
      .where('action', '=', 'power_instance')
      .execute();
    expect(operations).toHaveLength(1);
  });

  it('records the desired power state the transition is aiming at', async () => {
    for (const [action, expected] of [
      ['start', 'running'],
      ['reboot', 'running'],
      ['shutdown', 'stopped'],
      ['stop', 'stopped'],
    ] as const) {
      const { instanceId } = await activeInstance();
      await store.acceptPowerAction(
        powerCommand(instanceId, action),
        randomUUID().replaceAll('-', '').padEnd(64, '0'),
      );
      const instance = await db
        .selectFrom('control.instances')
        .selectAll()
        .where('id', '=', instanceId)
        .executeTakeFirstOrThrow();
      expect(instance.desired_power_state).toBe(expected);
    }
  });

  it('refuses a power request for an instance in another project', async () => {
    const { instanceId } = await activeInstance();
    await expect(
      store.acceptPowerAction(
        { ...powerCommand(instanceId), projectId: randomUUID() },
        'a'.repeat(64),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_NOT_FOUND' }));
  });
});

describe('acceptResize', () => {
  async function activeInstance(): Promise<string> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null })
      .where('id', '=', accepted.targetId)
      .execute();
    return accepted.targetId;
  }

  function resizeCommand(instanceId: string, flavorId = 'lab-medium', diskGiB?: number) {
    return {
      actor,
      projectId,
      instanceId,
      idempotencyKey: `resize-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      flavorId,
      ...(diskGiB === undefined ? {} : { diskGiB }),
    };
  }

  it('records the new desired sizing and publishes the target on the command', async () => {
    const instanceId = await activeInstance();
    await store.acceptResize(resizeCommand(instanceId), 'a'.repeat(64));

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instance.flavor_id).toBe('lab-medium');
    expect(instance.desired_cpu_count).toBe(4);
    expect(Number(instance.desired_memory_mib)).toBe(8192);
    expect(Number(instance.desired_disk_gib)).toBe(64);

    const outbox = await db
      .selectFrom('control.outbox')
      .selectAll()
      .where('schema_name', '=', 'instance.resize.requested')
      .executeTakeFirstOrThrow();
    const payload = outbox.payload as unknown as { data: Record<string, unknown> };
    expect(payload.data['targetResources']).toEqual({ cpuCount: 4, memoryMiB: 8192, diskGiB: 64 });
  });

  it('refuses a resize that changes nothing', async () => {
    const instanceId = await activeInstance();
    await expect(
      store.acceptResize(resizeCommand(instanceId, 'lab-small'), 'a'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('never shrinks a disk the tenant has already grown', async () => {
    // SAFE-026. The flavor's minimum disk is a floor, not a shrink instruction.
    const instanceId = await activeInstance();
    await db
      .updateTable('control.instances')
      .set({ desired_disk_gib: '128' })
      .where('id', '=', instanceId)
      .execute();
    await store.acceptResize(resizeCommand(instanceId), 'a'.repeat(64));

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(Number(instance.desired_disk_gib)).toBe(128);
  });

  it('refuses an unknown flavor', async () => {
    const instanceId = await activeInstance();
    await expect(
      store.acceptResize(resizeCommand(instanceId, 'does-not-exist'), 'a'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('refuses a resize while another operation is in flight', async () => {
    const instanceId = await activeInstance();
    await store.acceptResize(resizeCommand(instanceId), 'a'.repeat(64));
    await expect(
      store.acceptResize(resizeCommand(instanceId, 'lab-small'), 'b'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_BUSY' }));
  });

  it('charges quota for the delta, not the absolute target', async () => {
    // Charging the full target would refuse a resize the project has room for, because the
    // instance's current sizing is already counted in the project total.
    const instanceId = await activeInstance();
    await db
      .updateTable('control.quotas')
      .set({ cpu_count: 4, memory_mib: '8192', disk_gib: '64' })
      .where('project_id', '=', projectId)
      .execute();

    await expect(
      store.acceptResize(resizeCommand(instanceId), 'a'.repeat(64)),
    ).resolves.toBeTruthy();
  });
});

describe('disk growth', () => {
  async function activeInstance(): Promise<string> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null })
      .where('id', '=', accepted.targetId)
      .execute();
    return accepted.targetId;
  }

  function resize(instanceId: string, flavorId: string, diskGiB?: number) {
    return {
      actor,
      projectId,
      instanceId,
      idempotencyKey: `disk-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      flavorId,
      ...(diskGiB === undefined ? {} : { diskGiB }),
    };
  }

  it('grows the disk beyond the flavor minimum when asked', async () => {
    const instanceId = await activeInstance();
    await store.acceptResize(resize(instanceId, 'lab-medium', 100), 'a'.repeat(64));

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(Number(instance.desired_disk_gib)).toBe(100);
  });

  it('grows the disk without changing the flavor', async () => {
    // The tenant-facing capability: a disk size requested independently of compute sizing.
    const instanceId = await activeInstance();
    await store.acceptResize(resize(instanceId, 'lab-small', 64), 'a'.repeat(64));

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instance.flavor_id).toBe('lab-small');
    expect(instance.desired_cpu_count).toBe(2);
    expect(Number(instance.desired_disk_gib)).toBe(64);
  });

  it('refuses an explicit shrink rather than rounding it back up', async () => {
    // The computed target would clamp this to the current size and look like a no-op. Checking the
    // tenant's own number instead means a shrink is reported as forbidden, which is what it is.
    const instanceId = await activeInstance();
    await expect(
      store.acceptResize(resize(instanceId, 'lab-small', 16), 'a'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'DISK_SHRINK_FORBIDDEN' }));
  });

  it('counts growth against project disk quota', async () => {
    const instanceId = await activeInstance();
    await db
      .updateTable('control.quotas')
      .set({ disk_gib: '40' })
      .where('project_id', '=', projectId)
      .execute();

    await expect(
      store.acceptResize(resize(instanceId, 'lab-small', 128), 'a'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }));
  });
});

describe('IPv4 lease lifecycle', () => {
  async function leasedInstance(): Promise<{ instanceId: string; address: string }> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    const lease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('instance_id', '=', accepted.targetId)
      .executeTakeFirstOrThrow();
    return { instanceId: accepted.targetId, address: lease.address };
  }

  it('quarantines an address so it cannot be handed to a new instance', async () => {
    // The retained VM may still be answering on it, so the address stays reserved.
    const { instanceId, address } = await leasedInstance();
    expect(await store.releaseIpv4Lease(instanceId, 'quarantine_until_purge')).toBe('quarantined');

    const next = await store.acceptCreate(command(), 'a'.repeat(64));
    const nextLease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('instance_id', '=', next.targetId)
      .executeTakeFirstOrThrow();
    expect(nextLease.address).not.toBe(address);
  });

  it('returns a released address to the pool', async () => {
    const { instanceId, address } = await leasedInstance();
    expect(await store.releaseIpv4Lease(instanceId, 'release_on_retain')).toBe('released');

    // The allocator scans lowest-first, so the freed address is the one the next create takes.
    const next = await store.acceptCreate(command(), 'a'.repeat(64));
    const nextLease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('instance_id', '=', next.targetId)
      .executeTakeFirstOrThrow();
    expect(nextLease.address).toBe(address);
  });

  it('is idempotent, so a redelivered command cannot double-release', async () => {
    const { instanceId } = await leasedInstance();
    expect(await store.releaseIpv4Lease(instanceId, 'release_on_retain')).toBe('released');
    expect(await store.releaseIpv4Lease(instanceId, 'release_on_retain')).toBe('released');
  });

  it('does not report a no-op quarantine as a fresh transition', async () => {
    const { instanceId } = await leasedInstance();
    expect(await store.releaseIpv4Lease(instanceId, 'quarantine_until_purge')).toBe('quarantined');
    expect(await store.releaseIpv4Lease(instanceId, 'quarantine_until_purge')).toBe('quarantined');
  });

  it('refuses to move a released lease back into quarantine', async () => {
    // A redelivered retention command must not undo a purge that has already freed the address.
    const { instanceId } = await leasedInstance();
    await store.releaseIpv4Lease(instanceId, 'release_on_retain');
    expect(await store.releaseIpv4Lease(instanceId, 'quarantine_until_purge')).toBe('released');
  });

  it('promotes a quarantined lease to released when purge asks', async () => {
    // The progression is one-way and this is the forward step: retention quarantined the address,
    // purge frees it. Without this, a purged instance's address would stay reserved forever.
    const { instanceId, address } = await leasedInstance();
    await store.releaseIpv4Lease(instanceId, 'quarantine_until_purge');
    expect(await store.releaseIpv4Lease(instanceId, 'release_on_retain')).toBe('released');

    const next = await store.acceptCreate(command(), 'a'.repeat(64));
    const nextLease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('instance_id', '=', next.targetId)
      .executeTakeFirstOrThrow();
    expect(nextLease.address).toBe(address);
  });

  it('reports null for an instance that never held a lease', async () => {
    expect(await store.releaseIpv4Lease(randomUUID(), 'release_on_retain')).toBeNull();
  });

  it('serves the seeded retention policy', async () => {
    const policy = await store.getRetentionPolicy();
    expect(policy.retentionHours).toBe(168);
    // The conservative half of the choice: an address is not reused while the old VM still exists.
    expect(policy.leaseReleaseMode).toBe('quarantine_until_purge');
    expect(policy.version).toBe(1);
  });
});

describe('snapshots', () => {
  async function activeInstance(): Promise<string> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null })
      .where('id', '=', accepted.targetId)
      .execute();
    return accepted.targetId;
  }

  /** Clears the busy marker so a second snapshot operation can be accepted in one test. */
  async function releaseInstance(instanceId: string): Promise<void> {
    await db
      .updateTable('control.instances')
      .set({ active_operation_id: null })
      .where('id', '=', instanceId)
      .execute();
  }

  function snapshotCommand(instanceId: string, name = 'nightly') {
    return {
      actor,
      projectId,
      instanceId,
      idempotencyKey: `snap-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      name,
    };
  }

  it('writes the snapshot, operation, outbox command, and projection in one transaction', async () => {
    const instanceId = await activeInstance();
    const accepted = await store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64));

    const snapshot = await db
      .selectFrom('control.snapshots')
      .selectAll()
      .where('id', '=', accepted.targetId)
      .executeTakeFirstOrThrow();
    expect(snapshot.state).toBe('creating');
    expect(snapshot.name).toBe('nightly');

    // Seeded eagerly so a client polling straight after its 202 sees the snapshot.
    const projected = await db
      .selectFrom('projection.snapshots')
      .selectAll()
      .where('snapshot_id', '=', accepted.targetId)
      .executeTakeFirstOrThrow();
    expect(projected.instance_id).toBe(instanceId);

    const outbox = await db
      .selectFrom('control.outbox')
      .selectAll()
      .where('schema_name', '=', 'snapshot.create.requested')
      .executeTakeFirstOrThrow();
    expect(outbox.partition_key).toBe(instanceId);
  });

  it('refuses a duplicate snapshot name on the same instance', async () => {
    // Proxmox refuses it too; catching it here avoids discovering the conflict after a provider
    // call has already been made.
    const instanceId = await activeInstance();
    await store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64));
    await releaseInstance(instanceId);
    await expect(
      store.acceptSnapshotCreate(snapshotCommand(instanceId), 'b'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('counts snapshots against project quota', async () => {
    const instanceId = await activeInstance();
    await db
      .updateTable('control.quotas')
      .set({ snapshots: 0 })
      .where('project_id', '=', projectId)
      .execute();
    await expect(
      store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }));
  });

  it('reports snapshot usage on the quota read', async () => {
    const instanceId = await activeInstance();
    await store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64));
    const quota = await store.getQuota(projectId);
    // Previously hardcoded to zero, which made the quota read unable to explain a refusal.
    expect(quota?.usage.snapshots).toBe(1);
  });

  it('refuses a rollback of a snapshot belonging to another instance', async () => {
    const first = await activeInstance();
    const accepted = await store.acceptSnapshotCreate(snapshotCommand(first), 'a'.repeat(64));
    await db
      .updateTable('control.snapshots')
      .set({ state: 'available' })
      .where('id', '=', accepted.targetId)
      .execute();
    const second = await activeInstance();

    await expect(
      store.acceptSnapshotAction(
        'rollback_snapshot',
        {
          actor,
          projectId,
          instanceId: second,
          snapshotId: accepted.targetId,
          idempotencyKey: `roll-${randomUUID()}`,
          correlationId: randomUUID(),
          traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
        },
        'b'.repeat(64),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'SNAPSHOT_OWNERSHIP_MISMATCH' }));
  });

  it('refuses an action on a snapshot that is not available yet', async () => {
    const instanceId = await activeInstance();
    const accepted = await store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64));
    await releaseInstance(instanceId);

    await expect(
      store.acceptSnapshotAction(
        'delete_snapshot',
        {
          actor,
          projectId,
          instanceId,
          snapshotId: accepted.targetId,
          idempotencyKey: `del-${randomUUID()}`,
          correlationId: randomUUID(),
          traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
        },
        'b'.repeat(64),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INSTANCE_BUSY' }));
  });

  it('moves a snapshot to deleting and publishes its provider reference', async () => {
    const instanceId = await activeInstance();
    const accepted = await store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64));
    await db
      .updateTable('control.snapshots')
      .set({ state: 'available' })
      .where('id', '=', accepted.targetId)
      .execute();
    await releaseInstance(instanceId);

    await store.acceptSnapshotAction(
      'delete_snapshot',
      {
        actor,
        projectId,
        instanceId,
        snapshotId: accepted.targetId,
        idempotencyKey: `del-${randomUUID()}`,
        correlationId: randomUUID(),
        traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      },
      'b'.repeat(64),
    );

    const snapshot = await db
      .selectFrom('control.snapshots')
      .selectAll()
      .where('id', '=', accepted.targetId)
      .executeTakeFirstOrThrow();
    expect(snapshot.state).toBe('deleting');

    const outbox = await db
      .selectFrom('control.outbox')
      .selectAll()
      .where('schema_name', '=', 'snapshot.delete.requested')
      .executeTakeFirstOrThrow();
    const payload = outbox.payload as unknown as { data: Record<string, unknown> };
    // The orchestrator cannot read `control.snapshots`, so the reference travels on the command.
    expect(payload.data['providerSnapshotReference']).toBe('nightly');
  });

  it('lists an instance snapshots from the projection', async () => {
    const instanceId = await activeInstance();
    await store.acceptSnapshotCreate(snapshotCommand(instanceId), 'a'.repeat(64));
    const page = await store.listSnapshots(projectId, instanceId, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.name).toBe('nightly');
  });
});

describe('acceptRetention', () => {
  async function activeInstance(): Promise<string> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null })
      .where('id', '=', accepted.targetId)
      .execute();
    return accepted.targetId;
  }

  function retain(instanceId: string) {
    return {
      actor,
      projectId,
      instanceId,
      idempotencyKey: `retain-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
    };
  }

  it('moves the instance to deleting and records a retention deadline', async () => {
    const instanceId = await activeInstance();
    await store.acceptRetention(retain(instanceId), 'a'.repeat(64));

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    // `deleting` for the duration; the workflow's terminal event moves it to `retained`.
    expect(instance.lifecycle_state).toBe('deleting');
    expect(instance.retention_deadline).not.toBeNull();
    // Not purgeable until the deadline passes.
    expect(instance.purge_eligible).toBe(false);
  });

  it('quarantines the address at acceptance under the default policy', async () => {
    // The tenant loses access immediately, so an address left `active` could be handed to a new
    // instance while the old VM is still answering on it.
    const instanceId = await activeInstance();
    await store.acceptRetention(retain(instanceId), 'a'.repeat(64));

    const lease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(lease.state).toBe('quarantined');
  });

  it('releases the address instead when the policy says so', async () => {
    await db
      .updateTable('control.retention_policy')
      .set({ lease_release_mode: 'release_on_retain' })
      .execute();
    const instanceId = await activeInstance();
    await store.acceptRetention(retain(instanceId), 'a'.repeat(64));

    const lease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(lease.state).toBe('released');
    // No manual restore: the shared reset returns the policy to its seeded value.
  });

  it('publishes the deadline and release mode in force at acceptance', async () => {
    const instanceId = await activeInstance();
    await store.acceptRetention(retain(instanceId), 'a'.repeat(64));

    const outbox = await db
      .selectFrom('control.outbox')
      .selectAll()
      .where('schema_name', '=', 'instance.retention.requested')
      .executeTakeFirstOrThrow();
    const payload = outbox.payload as unknown as { data: Record<string, unknown> };
    expect(payload.data['leaseReleaseMode']).toBe('quarantine_until_purge');
    expect(typeof payload.data['retentionDeadline']).toBe('string');
  });

  it('refuses a second retention while one is in flight', async () => {
    const instanceId = await activeInstance();
    await store.acceptRetention(retain(instanceId), 'a'.repeat(64));
    await expect(store.acceptRetention(retain(instanceId), 'b'.repeat(64))).rejects.toThrowError(
      expect.objectContaining({ code: 'INSTANCE_BUSY' }),
    );
  });

  it('replays a repeated key without accepting a second operation', async () => {
    const instanceId = await activeInstance();
    const input = retain(instanceId);
    const first = await store.acceptRetention(input, 'a'.repeat(64));
    const second = await store.acceptRetention(input, 'a'.repeat(64));
    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);
  });
});

describe('acceptPurge', () => {
  const administrator = {
    subject: 'admin-1',
    roles: ['platform_administrator'],
    projects: [] as readonly string[],
  };

  /** Creates an instance and drives it to `retained` with an expired deadline. */
  async function retainedInstance(deadline = new Date(Date.now() - 60_000)): Promise<string> {
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({
        lifecycle_state: 'retained',
        active_operation_id: null,
        retention_deadline: deadline,
      })
      .where('id', '=', accepted.targetId)
      .execute();
    return accepted.targetId;
  }

  function purge(instanceId: string, confirmInstanceId = instanceId) {
    return {
      actor: administrator,
      instanceId,
      idempotencyKey: `purge-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      reason: 'Retention expired and the tenant confirmed disposal in ticket OPS-9001.',
      confirmInstanceId,
    };
  }

  it('accepts a purge of a retained instance past its deadline', async () => {
    const instanceId = await retainedInstance();
    const accepted = await store.acceptPurge(purge(instanceId), 'a'.repeat(64));

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instance.lifecycle_state).toBe('purge_pending');
    expect(instance.active_operation_id).toBe(accepted.operationId);
    // Administrators are not project members, so the status URL is the admin route.
    expect(accepted.statusUrl).toContain('/v1/admin/operations/');
  });

  it('refuses when the confirmation does not match the instance', async () => {
    // The most likely way this operation destroys the wrong machine is a mis-pasted identifier.
    const instanceId = await retainedInstance();
    await expect(
      store.acceptPurge(purge(instanceId, randomUUID()), 'a'.repeat(64)),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('refuses to purge an instance that is still active', async () => {
    // Purging straight from `active` would let one request destroy a VM a tenant is still using.
    const input = command();
    const accepted = await store.acceptCreate(input, hashOf(input));
    await db
      .updateTable('control.instances')
      .set({ lifecycle_state: 'active', active_operation_id: null })
      .where('id', '=', accepted.targetId)
      .execute();

    await expect(store.acceptPurge(purge(accepted.targetId), 'a'.repeat(64))).rejects.toThrowError(
      expect.objectContaining({ code: 'INSTANCE_BUSY' }),
    );
  });

  it('refuses while the retention period has not expired', async () => {
    // Retention exists so someone can change their mind; purging early removes that window.
    const instanceId = await retainedInstance(new Date(Date.now() + 3_600_000));
    await expect(store.acceptPurge(purge(instanceId), 'a'.repeat(64))).rejects.toThrowError(
      expect.objectContaining({ code: 'INSTANCE_BUSY' }),
    );
  });

  it('publishes an authorization reference rather than the administrator reason', async () => {
    // The justification stays in the audit trail; free text an administrator typed never crosses
    // the broker.
    const instanceId = await retainedInstance();
    await store.acceptPurge(purge(instanceId), 'a'.repeat(64));

    const outbox = await db
      .selectFrom('control.outbox')
      .selectAll()
      .where('schema_name', '=', 'instance.purge.requested')
      .executeTakeFirstOrThrow();
    const serialised = JSON.stringify(outbox.payload);
    expect(serialised).not.toContain('OPS-9001');
    const payload = outbox.payload as unknown as { data: Record<string, unknown> };
    expect(payload.data['reasonReference']).toBe(payload.data['purgeAuthorizationId']);
  });

  it('records the purge as an administrator-attributed audit fact', async () => {
    const instanceId = await retainedInstance();
    await store.acceptPurge(purge(instanceId), 'a'.repeat(64));
    const entry = await db
      .selectFrom('audit.entries')
      .selectAll()
      .where('action', '=', 'purge_instance')
      .executeTakeFirstOrThrow();
    expect(entry.actor_role).toBe('platform_administrator');
    expect(entry.target_id).toBe(instanceId);
  });

  it('replays a repeated key without accepting a second purge', async () => {
    const instanceId = await retainedInstance();
    const input = purge(instanceId);
    const first = await store.acceptPurge(input, 'a'.repeat(64));
    const second = await store.acceptPurge(input, 'a'.repeat(64));
    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);
  });
});

/**
 * The live test server's catalog rows, seeded additively by `db/seeds/0002_proxmox_testsrv.sql`.
 *
 * WHY this is tested here rather than only by the configuration cross-check: the cross-check
 * proves the rows agree with the `PROXMOX_*` environment, which is a different claim from the
 * rows being *mutually* consistent enough for acceptance to succeed. `loadAcceptanceContext`
 * resolves the provider profile through the image and refuses unless
 * `profile.network_id = network.id`, so a self-inconsistent trio is rejected with a message that
 * blames the catalog generally. These cases prove the trio actually accepts a create, and that
 * the allocator hands out an address clear of the 110 measured as already live on that bridge.
 */
describe('the live test server catalog', () => {
  const testsrvProjectId = '00000000-0000-4000-8000-0000000000a1';

  const testsrvActor: Actor = {
    subject: 'integration-actor',
    roles: ['tenant_developer'],
    projects: [testsrvProjectId],
  };

  function testsrvCommand(overrides: Partial<CreateInstanceCommand> = {}): CreateInstanceCommand {
    return {
      actor: testsrvActor,
      projectId: testsrvProjectId,
      idempotencyKey: `key-${randomUUID()}`,
      correlationId: randomUUID(),
      traceparent: `00-${randomUUID().replaceAll('-', '')}-0123456789abcdef-01`,
      imageId: 'ubuntu-noble-2404',
      flavorId: 'lab-small',
      networkId: 'testsrv-vmbr1',
      hostname: `tf-${randomUUID().slice(0, 8)}`,
      sshPublicKeys: [],
      ...overrides,
    };
  }

  it('accepts a create and allocates clear of the addresses already live on the bridge', async () => {
    const input = testsrvCommand();
    const accepted = await store.acceptCreate(input, hashOf(input));

    expect(accepted.operationId).toBeTruthy();

    const lease = await db
      .selectFrom('control.ipv4_leases')
      .selectAll()
      .where('network_id', '=', 'testsrv-vmbr1')
      .where('state', '=', 'active')
      .executeTakeFirstOrThrow();

    // The allocator returns the lowest free address. .1 is the gateway and is always excluded,
    // so the first instance must land on .2 — a long way below the occupied 192.168.7.x region.
    expect(lease.address).toBe('192.168.4.2');

    const instance = await db
      .selectFrom('control.instances')
      .selectAll()
      .where('id', '=', accepted.targetId)
      .executeTakeFirstOrThrow();

    expect(instance.provider_profile_id).toBe('proxmox-testsrv');
    // lab-small must equal template 110 exactly, or assertResources refuses every create.
    // These are bigint columns, so pg hands them back as strings.
    expect(Number(instance.desired_disk_gib)).toBe(32);
    expect(Number(instance.desired_cpu_count)).toBe(2);
    expect(Number(instance.desired_memory_mib)).toBe(4096);
  });

  it('never allocates an address that the survey measured as already live', async () => {
    const network = await db
      .selectFrom('control.networks')
      .selectAll()
      .where('id', '=', 'testsrv-vmbr1')
      .executeTakeFirstOrThrow();

    const exclusions = new Set(network.exclusions as readonly string[]);
    expect(exclusions.size).toBeGreaterThan(0);

    // The project quota deliberately caps this at three instances (SAFE-030), so exhaust it and
    // assert every address handed out avoided the exclusion list.
    const handed: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const input = testsrvCommand();
      await store.acceptCreate(input, hashOf(input));
    }
    const leases = await db
      .selectFrom('control.ipv4_leases')
      .select(['address'])
      .where('network_id', '=', 'testsrv-vmbr1')
      .where('state', '=', 'active')
      .execute();
    for (const lease of leases) handed.push(String(lease.address));

    expect(handed).toHaveLength(3);
    for (const address of handed) expect(exclusions.has(address)).toBe(false);
    expect(handed).not.toContain('192.168.4.1');
  });

  it('enforces the tight live-hardware quota', async () => {
    for (let index = 0; index < 3; index += 1) {
      const input = testsrvCommand();
      await store.acceptCreate(input, hashOf(input));
    }
    // The fourth must be refused. On real hardware the quota is the cap that keeps a runaway loop
    // from consuming the reserved VMID interval.
    const beyond = testsrvCommand();
    await expect(store.acceptCreate(beyond, hashOf(beyond))).rejects.toThrowError(DomainError);
  });

  it('has a restore entry for every seeded project quota', async () => {
    // `resetIntegrationState` restores quotas per project, because one project's cap is
    // deliberately tighter than another's. A seeded project missing from that map would have its
    // quota left wherever a previous test moved it — and for the live-hardware project that means
    // a safety cap silently widened. Asserting the map against the database is what keeps the two
    // in step as seeds are added.
    const quotas = await db.selectFrom('control.quotas').select(['project_id']).execute();
    const seeded = quotas.map((row) => String(row.project_id)).sort();

    expect(seeded).toEqual(
      ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1'].sort(),
    );
  });

  it('refuses an image and network that do not share a provider profile', async () => {
    // The fake catalog's network with the real server's image. Acceptance must reject the
    // combination rather than resolve a profile the adapter will not accept.
    const crossed = testsrvCommand({ networkId: 'lab-primary' });
    await expect(store.acceptCreate(crossed, hashOf(crossed))).rejects.toThrowError(DomainError);
  });
});
