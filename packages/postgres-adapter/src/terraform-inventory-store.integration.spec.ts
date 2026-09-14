/**
 * Integration coverage for the Terraform inventory store.
 *
 * This is where the fencing-token guarantee the schema cannot express is actually tested. No
 * `CHECK` can say "refuse a write whose token is older than the current lease" — it is a
 * comparison against another table's row, and it is the difference between one worker owning an
 * instance and two workers each believing they created it.
 *
 * @see packages/postgres-adapter/src/terraform-inventory-store.ts
 * @see db/migrations/0008_terraform_inventory.sql
 */
import { randomUUID } from 'node:crypto';
import { DomainError } from '@private-cloud/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';
import { PostgresTerraformInventoryStore } from './terraform-inventory-store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const store = new PostgresTerraformInventoryStore(db);
const projectId = '00000000-0000-4000-8000-000000000001';

/** Inserts an instance and returns its id. */
async function seedInstance(): Promise<string> {
  const instanceId = randomUUID();
  await db
    .insertInto('control.instances')
    .values({
      id: instanceId,
      project_id: projectId,
      image_id: 'ubuntu-24-04-cloud',
      flavor_id: 'lab-small',
      network_id: 'lab-primary',
      provider_profile_id: 'fake-lab',
      hostname: `host-${instanceId.slice(0, 8)}`,
      ssh_public_keys: JSON.stringify([]),
      desired_cpu_count: 2,
      desired_memory_mib: '4096',
      desired_disk_gib: '32',
      desired_power_state: 'running',
      lifecycle_state: 'pending',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return instanceId;
}

/** Grants the instance lease to `owner` at `token`, as the workflow store would. */
async function lease(instanceId: string, token: number, owner = 'worker-a'): Promise<void> {
  await db
    .insertInto('workflow.instance_leases')
    .values({
      instance_id: instanceId,
      owner_id: owner,
      fencing_token: String(token),
      leased_until: new Date(Date.now() + 60_000),
      updated_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.column('instance_id').doUpdateSet({
        owner_id: owner,
        fencing_token: String(token),
        leased_until: new Date(Date.now() + 60_000),
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** A begin-run input for an instance. */
function runFor(instanceId: string, token: number, overrides: Record<string, unknown> = {}) {
  return {
    runId: randomUUID(),
    instanceId,
    operationId: randomUUID(),
    workspaceName: `instance-${instanceId}`,
    command: 'apply' as const,
    fencingToken: token,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.deleteFrom('terraform.workspaces').execute();
  await db.deleteFrom('terraform.runs').execute();
  await resetIntegrationState(db);
});

afterAll(async () => {
  await db.deleteFrom('terraform.workspaces').execute();
  await db.deleteFrom('terraform.runs').execute();
  await db.destroy();
});

describe('the fencing token', () => {
  it('accepts a run from the worker that holds the lease', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 7);
    const run = runFor(instanceId, 7);

    await store.beginRun(run);

    const recorded = await store.readRun(run.runId);
    expect(recorded?.status).toBe('running');
    // SAFE-014: the reference the workflow polls exists, and it exists before any process did.
    expect(recorded?.startedAt).toBeInstanceOf(Date);
  });

  it('refuses a run from a worker whose lease has been taken', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 7, 'worker-a');
    // Another worker claimed the instance; the token advanced.
    await lease(instanceId, 8, 'worker-b');

    // This is the failure that matters. Without the check, the old worker would record a run —
    // and then an apply — for an instance it no longer owns, while the new worker does the same.
    await expect(store.beginRun(runFor(instanceId, 7))).rejects.toThrowError(DomainError);
  });

  it('records nothing at all when it refuses', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 8);
    const run = runFor(instanceId, 7);

    await expect(store.beginRun(run)).rejects.toThrowError(DomainError);
    // The insert and the check share one transaction, so a refusal leaves no partial row behind
    // for `getTask` to find and report on.
    expect(await store.readRun(run.runId)).toBeNull();
  });

  it('allows a run for an instance whose lease has already been released', async () => {
    // Not an error: a workflow that completed hands the instance back, and a refresh recorded
    // afterwards is legitimate. What must be refused is a token that disagrees with a lease that
    // exists, because that means someone else holds it now.
    const instanceId = await seedInstance();
    const run = runFor(instanceId, 1);

    await store.beginRun(run);

    expect((await store.readRun(run.runId))?.status).toBe('running');
  });

  it('refuses a completion from a worker whose lease has moved', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 7);
    const run = runFor(instanceId, 7);
    await store.beginRun(run);

    await expect(
      store.completeRun({ runId: run.runId, fencingToken: 8, status: 'succeeded', exitCode: 0 }),
    ).rejects.toThrowError(DomainError);

    // And the run is still running, so the worker that does hold the lease can still finish it.
    expect((await store.readRun(run.runId))?.status).toBe('running');
  });
});

describe('run completion', () => {
  it('records the outcome, the gate decision and the plan actions', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 1);
    const run = runFor(instanceId, 1);
    await store.beginRun(run);

    await store.completeRun({
      runId: run.runId,
      fencingToken: 1,
      status: 'succeeded',
      exitCode: 0,
      gateDecision: 'allowed',
      planActions: { create: 1, update: 0, delete: 0, replace: 0 },
    });

    const finished = await store.readRun(run.runId);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.exitCode).toBe(0);
    expect(finished?.gateDecision).toBe('allowed');
    expect(finished?.planActions).toEqual({ create: 1, update: 0, delete: 0, replace: 0 });
    expect(finished?.finishedAt).toBeInstanceOf(Date);
  });

  it('uses the database clock, so the ordering constraint cannot be tripped by skew', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 1);
    const run = runFor(instanceId, 1);
    await store.beginRun(run);

    // `runs_finished_after_started` compares `finished_at` against a `started_at` the column
    // default supplied. If the store used a `Date` from this process, any skew between the
    // application and the database would reject a legitimately finished run.
    await store.completeRun({ runId: run.runId, fencingToken: 1, status: 'succeeded' });

    const finished = await store.readRun(run.runId);
    const finishedAt = finished?.finishedAt;
    const startedAt = finished?.startedAt;
    expect(finishedAt).toBeInstanceOf(Date);
    expect(startedAt).toBeInstanceOf(Date);
    expect(finishedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(startedAt?.getTime() ?? 0);
  });

  it('refuses a second completion, so the first outcome stands', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 1);
    const run = runFor(instanceId, 1);
    await store.beginRun(run);
    await store.completeRun({ runId: run.runId, fencingToken: 1, status: 'failed', exitCode: 1 });

    // The first outcome is the one that actually happened. A retry that overwrote it would lose
    // the failure a subsequent investigation depends on.
    await expect(
      store.completeRun({ runId: run.runId, fencingToken: 1, status: 'succeeded', exitCode: 0 }),
    ).rejects.toThrowError(DomainError);

    expect((await store.readRun(run.runId))?.status).toBe('failed');
  });

  it('records a refused destructive plan with the rule that refused it', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 1);
    const run = runFor(instanceId, 1, { command: 'plan' as const });
    await store.beginRun(run);

    await store.completeRun({
      runId: run.runId,
      fencingToken: 1,
      status: 'failed',
      gateDecision: 'refused_destructive',
      gateRule: 'replace_because_tainted',
      planActions: { create: 1, delete: 1, replace: 1 },
    });

    const refused = await store.readRun(run.runId);
    expect(refused?.gateDecision).toBe('refused_destructive');
    // The rule is what tells an operator this one is clearable by untaint rather than a conflict.
    expect(refused?.gateRule).toBe('replace_because_tainted');
  });

  it('stores redacted diagnostics as given, and nothing more', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 1);
    const run = runFor(instanceId, 1);
    await store.beginRun(run);

    await store.completeRun({
      runId: run.runId,
      fencingToken: 1,
      status: 'failed',
      exitCode: 1,
      diagnostics: [
        { severity: 'error', summary: 'Cannot shrink disk', detail: 'it is not supported!' },
      ],
    });

    const failed = await store.readRun(run.runId);
    expect(failed?.diagnostics).toHaveLength(1);
    // The store does not redact; redaction happens before the write, because a value that
    // reaches a column has already escaped.
    expect(JSON.stringify(failed?.diagnostics)).toContain('Cannot shrink disk');
  });

  it('reports null for a reference that names nothing', async () => {
    expect(await store.readRun(randomUUID())).toBeNull();
  });
});

describe('the workspace record', () => {
  it('creates on first apply and updates on later runs', async () => {
    const instanceId = await seedInstance();
    await lease(instanceId, 1);
    const run = runFor(instanceId, 1);
    await store.beginRun(run);
    await store.completeRun({ runId: run.runId, fencingToken: 1, status: 'succeeded' });

    await store.recordWorkspace({
      instanceId,
      workspaceName: run.workspaceName,
      providerVersion: '0.113.1',
      stateSerial: 3,
      stateLineage: randomUUID(),
      lastRunId: run.runId,
      applied: true,
      driftState: 'in_sync',
    });

    const created = await db
      .selectFrom('terraform.workspaces')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(Number(created.state_serial)).toBe(3);
    expect(created.drift_state).toBe('in_sync');
    expect(created.last_applied_at).not.toBeNull();
    expect(created.last_refreshed_at).toBeNull();

    // A later refresh updates rather than conflicting.
    await store.recordWorkspace({
      instanceId,
      workspaceName: run.workspaceName,
      stateSerial: 4,
      refreshed: true,
      driftState: 'drifted',
      driftSummary: { 'proxmox_virtual_environment_vm.instance': ['cpu.cores'] },
    });

    const updated = await db
      .selectFrom('terraform.workspaces')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(Number(updated.state_serial)).toBe(4);
    expect(updated.drift_state).toBe('drifted');
    expect(updated.last_refreshed_at).not.toBeNull();
    // The earlier apply timestamp survives a refresh that did not apply anything.
    expect(updated.last_applied_at).not.toBeNull();
  });

  it('never renames a workspace on conflict', async () => {
    // The name derives from the instance id, so a different name means the caller is confused
    // about which instance this is — and silently renaming a workspace orphans its state.
    const instanceId = await seedInstance();
    await store.recordWorkspace({ instanceId, workspaceName: `instance-${instanceId}` });
    await store.recordWorkspace({ instanceId, workspaceName: 'something-else-entirely' });

    const row = await db
      .selectFrom('terraform.workspaces')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(row.workspace_name).toBe(`instance-${instanceId}`);
  });

  it('records a drift summary of attribute names', async () => {
    const instanceId = await seedInstance();
    await store.recordWorkspace({
      instanceId,
      workspaceName: `instance-${instanceId}`,
      driftState: 'drifted',
      driftSummary: {
        'proxmox_virtual_environment_vm.instance': ['cpu.cores', 'memory.dedicated'],
      },
    });

    const row = await db
      .selectFrom('terraform.workspaces')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    const summary = JSON.stringify(row.drift_summary);
    expect(summary).toContain('cpu.cores');
    // Names, never values. A summary carrying "4" would be reporting the drifted value itself,
    // and for an attribute like the cloud-init password that is a credential in a read model.
    expect(summary).not.toMatch(/\b\d+\b/);
  });
});
