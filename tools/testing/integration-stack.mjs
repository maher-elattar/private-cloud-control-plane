/**
 * Lifecycle for the ephemeral integration stack in `deploy/local/compose.test.yaml`.
 *
 * PATTERN — test fixture as infrastructure. Integration suites here talk to a real PostgreSQL
 * rather than a stub, because the code they cover is almost entirely SQL: advisory locks,
 * `FOR UPDATE ... SKIP LOCKED`, row-value keyset predicates, and unique constraints. A fake would
 * assert that the query text is unchanged, not that the query is correct, which is the only
 * question worth asking of `packages/postgres-adapter`.
 *
 * @see deploy/local/compose.test.yaml
 * @see phase-5-completion-checkpoints.md
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = new URL('../../', import.meta.url).pathname;
const composeFile = 'deploy/local/compose.test.yaml';
const execOptions = { cwd: root, maxBuffer: 16 * 1024 * 1024 };

/** Connection string for the ephemeral test database, also exported to suites as `DATABASE_URL`. */
export const TEST_DATABASE_URL =
  'postgresql://private_cloud_test:private_cloud_test@127.0.0.1:55433/private_cloud_test';

/**
 * Set `KEEP_TEST_STACK=1` to leave the stack running after a suite.
 *
 * Useful when a failure needs the database inspected by hand; the next run reuses the container
 * and reapplies migrations, which are idempotent.
 */
const keepRunning = process.env.KEEP_TEST_STACK === '1';

async function compose(args) {
  return (await execFile('docker', ['compose', '-f', composeFile, ...args], execOptions)).stdout;
}

/**
 * Starts PostgreSQL, waits for its health check, and applies every migration and the seed.
 *
 * WHY it destroys the stack first: the containers use tmpfs, but a container left running by an
 * interrupted previous run still holds its rows. Starting from a known-empty database is the
 * difference between a test that fails honestly and one that passes on inherited state.
 *
 * @returns The connection string suites should use.
 */
export async function startIntegrationStack() {
  await compose(['down', '--remove-orphans', '--timeout', '5']).catch(() => undefined);
  await compose(['up', '-d', '--wait', 'postgres']);
  const environment = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  await execFile('node', ['tools/db/migrate.mjs'], { ...execOptions, env: environment });
  await execFile('node', ['tools/db/seed.mjs'], { ...execOptions, env: environment });
  return TEST_DATABASE_URL;
}

/** Tears the stack down unless `KEEP_TEST_STACK=1` asked for it to survive. */
export async function stopIntegrationStack() {
  if (keepRunning) return;
  await compose(['down', '--remove-orphans', '--timeout', '5']);
}

/** Vitest `globalSetup` entry point: start on load, stop on teardown. */
export default async function setup() {
  const url = await startIntegrationStack();
  process.env.DATABASE_URL = url;
  return async () => {
    await stopIntegrationStack();
  };
}
