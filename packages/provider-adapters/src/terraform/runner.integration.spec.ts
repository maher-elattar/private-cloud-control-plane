/**
 * Integration coverage for what happens to a Terraform state lock when the runner dies.
 *
 * WHY this cannot be a unit test: the property is that a **killed process releases its lock**, and
 * a stub cannot lose a lock it never took. The `pg` backend's lock is a PostgreSQL session advisory
 * lock, so its release is a property of the connection dying — which needs a real connection, a
 * real `terraform` binary, and a real kill.
 *
 * WHY it matters: the design chose the `pg` backend partly because this is true of it. A backend
 * whose locks outlive their holder needs `force-unlock` as an operational routine, and an operator
 * reaching for `force-unlock` cannot tell "the worker died" from "another apply is still running"
 * — so the recovery procedure for a crash would be indistinguishable from the procedure that
 * corrupts state by running two applies at once. Here there is nothing to unlock.
 *
 * The module under test is deliberately provider-free: `terraform_data` is built into Terraform
 * and `local-exec` needs no plugin, so this suite exercises the backend and the lock without
 * touching a hypervisor, and runs with no network access beyond the database.
 *
 * @see packages/provider-adapters/src/terraform/runner.ts
 * @see docs/runbooks/terraform-run-recovery.md
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

/** The binary under test. The suite skips rather than fails when Terraform is not installed. */
const BINARY = process.env.TERRAFORM_BINARY ?? 'terraform';

/** Long enough to kill the apply while it is still holding the lock, short enough to wait for. */
const APPLY_SECONDS = 25;

/** How long to allow the recovery plan. Generous: it must succeed, not merely succeed quickly. */
const RECOVERY_TIMEOUT_MS = 90_000;

/**
 * The backend connection string.
 *
 * A separate schema from the application's, because Terraform's own tables are state — see the
 * inventory migration's grants. `sslmode=disable` is the container's configuration, not a
 * production choice.
 */
const connectionString = `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}sslmode=disable`;

/** Counts session advisory locks, which is what the `pg` backend takes. */
async function advisoryLockCount(): Promise<number> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory'",
    );
    return rows[0]?.held ?? 0;
  } finally {
    await pool.end();
  }
}

/** Waits for a condition, polling. Returns whether it became true within the budget. */
async function eventually(
  predicate: () => Promise<boolean>,
  budgetMs: number,
  stepMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

const terraformAvailable = spawnSync(BINARY, ['version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!terraformAvailable)('a killed runner and its state lock', () => {
  let directory: string;
  const workspace = `lock-probe-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'terraform-lock-probe-'));
    // A provider-free module whose apply takes measurable time. `terraform_data` is built in, and
    // the provisioner is what makes the apply slow enough to interrupt on purpose.
    await writeFile(
      join(directory, 'main.tf'),
      [
        'terraform {',
        '  backend "pg" {}',
        '}',
        'resource "terraform_data" "slow" {',
        '  provisioner "local-exec" {',
        `    command = "sleep ${APPLY_SECONDS}"`,
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const init = spawnSync(
      BINARY,
      [
        'init',
        '-input=false',
        '-no-color',
        `-backend-config=conn_str=${connectionString}`,
        `-backend-config=schema_name=terraform_lock_probe_${workspace.replaceAll('-', '_')}`,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    expect(init.status, `init failed: ${init.stderr}`).toBe(0);
  }, 120_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });

  it('releases the lock when the process holding it is killed, and needs no force-unlock', async () => {
    const before = await advisoryLockCount();

    // `setsid` so the apply is its own process group: a kill aimed at it cannot reach the test
    // runner. This is the same shape as the production failure — the process holding the lock
    // disappears without running any cleanup — and SIGKILL is used precisely because it gives
    // Terraform no chance to unlock politely. A SIGTERM test would prove only that the graceful
    // path works, which is not the path a crashed worker takes.
    const apply = spawn('setsid', [BINARY, 'apply', '-input=false', '-no-color', '-auto-approve'], {
      cwd: directory,
      stdio: 'ignore',
      detached: true,
    });

    const took = await eventually(async () => (await advisoryLockCount()) > before, 60_000);
    expect(took, 'the apply never took a state lock, so this test proved nothing').toBe(true);

    apply.kill('SIGKILL');
    // The apply itself is a child of `setsid`, so kill the group it leads.
    if (apply.pid) {
      try {
        process.kill(-apply.pid, 'SIGKILL');
      } catch {
        // Already gone, which is the outcome this line was trying to cause.
      }
    }

    const released = await eventually(async () => (await advisoryLockCount()) <= before, 60_000);
    expect(released, 'the lock outlived the process that held it').toBe(true);
  });

  it('leaves the workspace immediately usable, with no recovery step in between', async () => {
    // The recovery assertion. A plan that acquires the lock and exits 0 is the proof that nothing
    // is stuck: no `force-unlock`, no manual state surgery, no waiting out a lease. The short
    // `-lock-timeout` is deliberate — a stale lock would make this time out rather than pass.
    const plan = spawnSync(BINARY, ['plan', '-input=false', '-no-color', '-lock-timeout=10s'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: RECOVERY_TIMEOUT_MS,
    });

    expect(plan.status, `plan failed: ${plan.stderr}`).toBe(0);
    expect(plan.stderr ?? '').not.toContain('Error acquiring the state lock');
    expect(`${plan.stdout}${plan.stderr}`).not.toContain('force-unlock');
  });
});
