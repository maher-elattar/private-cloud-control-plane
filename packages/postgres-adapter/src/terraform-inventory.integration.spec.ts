/**
 * Integration coverage for the Terraform run record and state inventory.
 *
 * WHY these run against a container rather than a stub: every guarantee under test is a property
 * of the database. A `UNIQUE` refusing a second workspace for one instance, a `CHECK` refusing a
 * terminal run with no finish time, a foreign key refusing a workspace for an instance that does
 * not exist, and two sessions contending for the same advisory lock are all invisible to a fake.
 *
 * Scope note: this covers what the *schema* guarantees. Fencing-token enforcement is a store
 * behaviour — no constraint can express "reject a write whose token is older than the current
 * lease" — and is covered where that store is written, not here. Claiming it at this layer would
 * be asserting a guarantee the schema does not make.
 *
 * @see db/migrations/0008_terraform_inventory.sql
 * @see deploy/local/compose.test.yaml
 */
import { randomUUID } from 'node:crypto';
import { sql, type Insertable } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDatabase, type PostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const projectId = '00000000-0000-4000-8000-000000000001';

/** Inserts the minimum instance row a workspace can reference. */
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

/** A run row as it is inserted. Typed, so a column rename breaks the fixture rather than a test. */
type RunInsert = Insertable<PostgresDatabase['terraform.runs']>;

/**
 * The database clock, for `finished_at`.
 *
 * `runs_finished_after_started` compares it against a `started_at` the column default supplied,
 * so a `new Date()` from this process is being measured against a different clock — and under any
 * skew a legitimately finished run is rejected. Writers use `now()`, and so do these tests.
 */
const serverNow = () => sql<Date>`now()`;

/** A running run row, which is the only shape a fresh invocation may take. */
function runningRun(instanceId: string, overrides: Partial<RunInsert> = {}): RunInsert {
  return {
    run_id: randomUUID(),
    instance_id: instanceId,
    operation_id: randomUUID(),
    workspace_name: `instance-${instanceId}`,
    command: 'apply',
    fencing_token: '1',
    status: 'running',
    // `started_at` is left to the column default, which is the honest value: the row is written
    // before the process starts, so the database's `now()` is when the run began.
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

describe('terraform.runs', () => {
  it('records an invocation before it starts, then its outcome', async () => {
    const instanceId = await seedInstance();
    const run = runningRun(instanceId);

    // SAFE-014: the reference the workflow will poll exists before the process does.
    await db.insertInto('terraform.runs').values(run).execute();

    const pending = await db
      .selectFrom('terraform.runs')
      .selectAll()
      .where('run_id', '=', run.run_id)
      .executeTakeFirstOrThrow();
    expect(pending.status).toBe('running');
    expect(pending.finished_at).toBeNull();

    await db
      .updateTable('terraform.runs')
      .set({
        status: 'succeeded',
        exit_code: 0,
        gate_decision: 'allowed',
        plan_actions: JSON.stringify({ create: 1, update: 0, delete: 0, replace: 0 }),
        finished_at: serverNow(),
      })
      .where('run_id', '=', run.run_id)
      .execute();

    const settled = await db
      .selectFrom('terraform.runs')
      .selectAll()
      .where('run_id', '=', run.run_id)
      .executeTakeFirstOrThrow();
    expect(settled.status).toBe('succeeded');
    expect(settled.plan_actions).toEqual({ create: 1, update: 0, delete: 0, replace: 0 });
  });

  it('refuses a terminal run with no finish time', async () => {
    const instanceId = await seedInstance();
    await expect(
      db
        .insertInto('terraform.runs')
        .values(runningRun(instanceId, { status: 'succeeded' }))
        .execute(),
    ).rejects.toThrow(/runs_terminal_has_finished/);
  });

  it('refuses a running run that claims to have finished', async () => {
    const instanceId = await seedInstance();
    // An hour ahead, so the ordering constraint cannot be what fires and the assertion is
    // unambiguous about which rule rejected the row.
    const later = new Date(Date.now() + 3_600_000);
    await expect(
      db
        .insertInto('terraform.runs')
        .values(runningRun(instanceId, { finished_at: later }))
        .execute(),
    ).rejects.toThrow(/runs_terminal_has_finished/);
  });

  it('refuses a command outside the five Terraform invocations', async () => {
    const instanceId = await seedInstance();
    await expect(
      db
        .insertInto('terraform.runs')
        .values(runningRun(instanceId, { command: 'taint' }))
        .execute(),
    ).rejects.toThrow(/runs_command/);
  });

  it('refuses a gate decision outside allowed and refused_destructive', async () => {
    const instanceId = await seedInstance();
    await expect(
      db
        .insertInto('terraform.runs')
        .values(runningRun(instanceId, { gate_decision: 'maybe' }))
        .execute(),
    ).rejects.toThrow(/runs_gate_decision/);
  });

  it('records a refused destructive plan as an outcome, not an error', async () => {
    // The designed abort: the gate refused, nothing was applied, and the row says which rule did
    // it. A retry into the same refusal would be pointless, so the workflow goes to manual review.
    const instanceId = await seedInstance();
    const run = runningRun(instanceId, { command: 'plan' });
    await db.insertInto('terraform.runs').values(run).execute();
    await db
      .updateTable('terraform.runs')
      .set({
        status: 'failed',
        gate_decision: 'refused_destructive',
        gate_rule: 'replace_because_tainted',
        plan_actions: JSON.stringify({ create: 1, update: 0, delete: 1, replace: 1 }),
        finished_at: serverNow(),
      })
      .where('run_id', '=', run.run_id)
      .execute();

    const refused = await db
      .selectFrom('terraform.runs')
      .selectAll()
      .where('run_id', '=', run.run_id)
      .executeTakeFirstOrThrow();
    expect(refused.gate_decision).toBe('refused_destructive');
    expect(refused.gate_rule).toBe('replace_because_tainted');
  });
});

describe('terraform.workspaces', () => {
  it('allows one workspace per instance and one instance per workspace name', async () => {
    const instanceId = await seedInstance();
    const workspaceName = `instance-${instanceId}`;
    await db
      .insertInto('terraform.workspaces')
      .values({ instance_id: instanceId, workspace_name: workspaceName })
      .execute();

    // A second workspace for the same instance is refused by the primary key.
    await expect(
      db
        .insertInto('terraform.workspaces')
        .values({ instance_id: instanceId, workspace_name: `${workspaceName}-again` })
        .execute(),
    ).rejects.toThrow(/workspaces_pkey/);

    // And the same workspace name for a different instance is refused by the unique index. That
    // matters because the `pg` backend's advisory lock is keyed on the state row, so two
    // instances sharing a name would share a lock and serialise against each other.
    const second = await seedInstance();
    await expect(
      db
        .insertInto('terraform.workspaces')
        .values({ instance_id: second, workspace_name: workspaceName })
        .execute(),
    ).rejects.toThrow(/workspaces_workspace_name_key/);
  });

  it('refuses a workspace for an instance that does not exist', async () => {
    const absent = randomUUID();
    await expect(
      db
        .insertInto('terraform.workspaces')
        .values({ instance_id: absent, workspace_name: `instance-${absent}` })
        .execute(),
    ).rejects.toThrow(/workspaces_instance_id_fkey/);
  });

  it('starts at drift_state unknown and refuses an unrecognised classification', async () => {
    const instanceId = await seedInstance();
    await db
      .insertInto('terraform.workspaces')
      .values({ instance_id: instanceId, workspace_name: `instance-${instanceId}` })
      .execute();

    const fresh = await db
      .selectFrom('terraform.workspaces')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    // Never `in_sync` by default. A workspace nothing has observed is unknown, not healthy.
    expect(fresh.drift_state).toBe('unknown');

    await expect(
      db
        .updateTable('terraform.workspaces')
        .set({ drift_state: 'probably_fine' })
        .where('instance_id', '=', instanceId)
        .execute(),
    ).rejects.toThrow(/workspaces_drift_state/);
  });

  it('refuses a drift summary that is not an object', async () => {
    const instanceId = await seedInstance();
    await db
      .insertInto('terraform.workspaces')
      .values({ instance_id: instanceId, workspace_name: `instance-${instanceId}` })
      .execute();

    await expect(
      db
        .updateTable('terraform.workspaces')
        .set({ drift_summary: JSON.stringify(['cpu.cores']) })
        .where('instance_id', '=', instanceId)
        .execute(),
    ).rejects.toThrow(/workspaces_drift_summary/);
  });

  it('links the last run and records the state serial read back from it', async () => {
    const instanceId = await seedInstance();
    const run = runningRun(instanceId);
    await db.insertInto('terraform.runs').values(run).execute();
    await db
      .updateTable('terraform.runs')
      .set({ status: 'succeeded', exit_code: 0, finished_at: serverNow() })
      .where('run_id', '=', run.run_id)
      .execute();

    await db
      .insertInto('terraform.workspaces')
      .values({
        instance_id: instanceId,
        workspace_name: run.workspace_name,
        last_run_id: run.run_id,
        state_serial: '4',
        state_lineage: randomUUID(),
        drift_state: 'in_sync',
        last_applied_at: new Date(),
      })
      .execute();

    const joined = await db
      .selectFrom('terraform.workspaces')
      .innerJoin('terraform.runs', 'terraform.runs.run_id', 'terraform.workspaces.last_run_id')
      .select(['terraform.workspaces.state_serial', 'terraform.runs.command'])
      .where('terraform.workspaces.instance_id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(Number(joined.state_serial)).toBe(4);
    expect(joined.command).toBe('apply');
  });
});

describe('the state backend boundary', () => {
  it('creates the backend schema without creating its table', async () => {
    // The `pg` backend creates `states` itself on first use. Creating the *schema* here is what
    // allows the grants to exist before that happens.
    const schemas = await sql<{
      schema_name: string;
    }>`SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'terraform_remote_state'`.execute(
      db,
    );
    expect(schemas.rows).toHaveLength(1);

    const tables = await sql<{
      table_name: string;
    }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'terraform_remote_state'`.execute(
      db,
    );
    expect(tables.rows).toHaveLength(0);
  });

  it('grants the application read-only access to whatever the runner creates there', async () => {
    // Terraform state holds the cloud-init password and any SSH key material — it is a secret
    // store that happens to be JSON. The application may read enough to report inventory and
    // nothing more, and that is a grant rather than an intention.
    const defaults = await sql<{
      privileges: string;
    }>`
      SELECT array_to_string(defaclacl, ',') AS privileges
      FROM pg_default_acl
      JOIN pg_namespace ON pg_namespace.oid = pg_default_acl.defaclnamespace
      WHERE pg_namespace.nspname = 'terraform_remote_state' AND defaclobjtype = 'r'
    `.execute(db);

    expect(defaults.rows).toHaveLength(1);
    const privileges = defaults.rows[0]?.privileges ?? '';
    // `r` is SELECT. The assertion that matters is the absence of `w` (UPDATE), `a` (INSERT) and
    // `d` (DELETE) for the application role.
    expect(privileges).toMatch(/control_plane_application=r\//);
    expect(privileges).not.toMatch(/control_plane_application=r?[wad]/);
  });

  it('grants no DELETE on the inventory to anyone', async () => {
    // A run record is evidence, and a workspace row outliving its instance is a finding rather
    // than garbage: it means state exists for something the control plane believes is gone.
    const grants = await sql<{
      grantee: string;
      privilege_type: string;
      table_name: string;
    }>`
      SELECT grantee, privilege_type, table_name
      FROM information_schema.role_table_grants
      WHERE table_schema = 'terraform' AND privilege_type = 'DELETE'
        AND grantee IN ('control_plane_application', 'terraform_runner')
    `.execute(db);

    expect(grants.rows).toEqual([]);
  });
});

describe('workspace locking', () => {
  it('hands one workspace to one session at a time', async () => {
    // This is the property that makes Terraform's concurrency model compatible with the control
    // plane's: the `pg` backend takes an advisory lock keyed on the state row, so one workspace
    // per instance means that lock has the same granularity as the SAFE-010 per-instance lease.
    // Modelled here with the same primitive on a workspace-derived key.
    const first = createPostgresDatabase(databaseUrl);
    const second = createPostgresDatabase(databaseUrl);
    const key = sql`hashtextextended('instance-lock-probe', 0)`;
    try {
      const held = await first.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(${key})`.execute(tx);
        // A second session must not be able to take it while the first transaction is open.
        const attempt = await sql<{
          acquired: boolean;
        }>`SELECT pg_try_advisory_xact_lock(${key}) AS acquired`.execute(second);
        return attempt.rows[0]?.acquired;
      });
      expect(held).toBe(false);

      // And once the transaction ends, the lock is free — which is why the `pg` backend has no
      // force-unlock: a killed runner releases its lock by dying.
      const afterwards = await sql<{
        acquired: boolean;
      }>`SELECT pg_try_advisory_lock(${key}) AS acquired`.execute(second);
      expect(afterwards.rows[0]?.acquired).toBe(true);
      await sql`SELECT pg_advisory_unlock(${key})`.execute(second);
    } finally {
      await first.destroy();
      await second.destroy();
    }
  });
});
