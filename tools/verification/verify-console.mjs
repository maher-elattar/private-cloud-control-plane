/**
 * Drives the customer console in a real browser, against the real control plane and real hardware.
 *
 * WHY a browser rather than requests against the BFF: the thing being verified is the console, and
 * a console is its behaviour in a browser — that an unauthenticated deep link redirects, that a
 * wrong password is refused, that a created server appears in the list while it is still
 * provisioning, that a disk shrink is refused before it is submitted. None of that is observable
 * from curl, and all of it is what a customer meets.
 *
 * It uses the installed system Chrome rather than a downloaded browser, because one is already
 * here and matching Playwright's bundled revision is a detail this suite should not own.
 *
 * Every check records its outcome instead of aborting the run: a suite that stops at the first
 * problem hides every later one, and the later ones are usually what explains the first.
 *
 * Usage:
 *   pnpm run verify:console
 *   pnpm run verify:console --only=<check-name>
 *   pnpm run verify:console --list
 *   pnpm run verify:console --keep          # leave the created server in place
 *
 * @see tools/verification/verify-terraform-runtime.mjs
 * @see apps/console-web/DESIGN.md
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import pg from 'pg';
import { chromium } from '@playwright/test';

const execFile = promisify(execFileCallback);

/** Where the machine-readable evidence is written. */
const EVIDENCE_PATH = resolve('docs/verification/evidence/console-runtime.json');

/** Where screenshots go, alongside the other committed visual evidence. */
const SCREENSHOT_DIR = resolve('docs/verification/evidence');

/** The console, as Compose publishes it. */
const CONSOLE_BASE = 'http://127.0.0.1:3102';

/** The application database, for the preconditions and the assertions the UI cannot show. */
const DATABASE_URL = 'postgresql://private_cloud:private_cloud@127.0.0.1:55432/private_cloud';

/** The project the demo user may see. */
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';

/** The reserved VMID interval this deployment is confined to. */
const VMID_MINIMUM = 910_000;
const VMID_MAXIMUM = 910_099;

/** The node every instance lands on. */
const NODE = 'proxtest';

/** How long a create takes on real hardware, generously. */
const CREATE_TIMEOUT_MS = 240_000;

/**
 * How long one action takes on real hardware.
 *
 * Sized from measurement, not from taste. Every mutation here is a Terraform apply against a real
 * Proxmox server: init, plan, apply, then an observation, which is 60 to 90 seconds even when
 * nothing contends. Add the wait for the previous workflow to release the instance's lease and a
 * single check can legitimately take four minutes.
 *
 * The first version of this file allowed 180 seconds and four consecutive checks failed — while
 * the operation journal recorded every one of those operations as `succeeded`. A timeout shorter
 * than the work it waits on does not test anything; it measures the timeout.
 */
const ACTION_TIMEOUT_MS = 420_000;

const argv = process.argv.slice(2);
const only = argv.find((flag) => flag.startsWith('--only='))?.split('=')[1];
const listOnly = argv.includes('--list');
const keep = argv.includes('--keep');

const evidence = {
  startedAt: new Date().toISOString(),
  console: CONSOLE_BASE,
  project: PROJECT_ID,
  checks: {},
};
const failures = [];
const names = [];

/**
 * Runs one named check, recording its outcome rather than aborting the suite.
 *
 * @param {string} name Check identifier, also the evidence key.
 * @param {() => Promise<Record<string, unknown>>} body Check body; its return value is evidence.
 * @returns {Promise<void>} Resolves once the outcome is recorded.
 */
async function check(name, body) {
  names.push(name);
  if (listOnly) return;
  if (only && only !== name) return;
  const startedAt = Date.now();
  process.stdout.write(`▶ ${name}\n`);
  try {
    const detail = await body();
    evidence.checks[name] = { ...detail, status: 'passed', durationMs: Date.now() - startedAt };
    process.stdout.write(`  ✓ ${name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.checks[name] = {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: message,
    };
    failures.push(`${name}: ${message}`);
    process.stdout.write(`  ✗ ${name}: ${message}\n`);
  }
}

/** Polls until an assertion holds, so a slow provider is not a failure. */
async function waitFor(description, assertion, timeoutMs, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await assertion();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((settle) => setTimeout(settle, intervalMs));
  }
  throw new Error(
    `${description} did not hold within ${Math.round(timeoutMs / 1000)}s${
      last ? `: ${last instanceof Error ? last.message : String(last)}` : ''
    }`,
  );
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

/** One query against the application database. */
async function query(text, values = []) {
  return (await pool.query(text, values)).rows;
}

/** The Proxmox credentials, read from the gitignored file. */
const credentials = Object.fromEntries(
  (await readFile(resolve('terraformProxServerTestCredntails.txt'), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

/** One read against Proxmox with the scoped token. */
async function proxmox(path) {
  const response = await fetch(`${credentials.PROXMOX_ENDPOINT}/api2/json${path}`, {
    headers: {
      Authorization: `PVEAPIToken=${credentials.PROXMOX_API_TOKEN_ID}=${credentials.PROXMOX_API_TOKEN_SECRET}`,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return (await response.json()).data;
}

/** Every VMID present in the reserved interval. */
async function reservedVmids() {
  const machines = await proxmox('/cluster/resources?type=vm');
  return machines
    .map((machine) => Number(machine.vmid))
    .filter((vmid) => vmid >= VMID_MINIMUM && vmid <= VMID_MAXIMUM)
    .sort((left, right) => left - right);
}

/** The demo user's credentials, minted fresh so the suite never depends on a remembered password. */
async function demoCredentials() {
  const { stdout } = await execFile('node', ['tools/console/demo-user.mjs'], { cwd: resolve('.') });
  const username = /Username\s+(\S+)/.exec(stdout)?.[1];
  const password = /Password\s+(\S+)/.exec(stdout)?.[1];
  if (!username || !password) throw new Error('Could not read the generated demo credentials.');
  // The identity stub reads its users at startup, so it has to be restarted to see the new one.
  await execFile(
    'docker',
    [
      'compose',
      '--env-file',
      'deploy/local/.env.terraform',
      '-f',
      'deploy/local/compose.phase4.yaml',
      '-f',
      'deploy/local/compose.terraform.yaml',
      '-f',
      'deploy/local/compose.console.yaml',
      'up',
      '-d',
      '--force-recreate',
      'local-oidc',
    ],
    { cwd: resolve('.') },
  );
  await waitFor(
    'the identity stub is ready',
    async () => {
      const { stdout: logs } = await execFile('docker', [
        'logs',
        '--tail',
        '5',
        'private-cloud-phase4-local-oidc-1',
      ]);
      return logs.includes('"users":1');
    },
    60_000,
    2_000,
  );
  return { username, password };
}

/**
 * Waits until no workflow holds the instance's lease.
 *
 * WHY every action needs this. SAFE-010 allows one mutating workflow per instance at a time, so a
 * request made while another is in flight queues behind it rather than running — and a suite that
 * issues its next action the moment the previous *provider* call returned measures the queue
 * rather than the action. Observed: a power request sat in `running` for longer than the whole
 * check's budget because the create's final observation had not released the lease, and four
 * consecutive checks then timed out for a reason none of them was testing.
 *
 * @param {string} instanceId The instance to wait on.
 * @param {number} [timeoutMs] How long to allow.
 * @returns {Promise<true>} Once the instance has no active operation.
 */
async function waitForIdle(instanceId, timeoutMs = 240_000) {
  return waitFor(
    'the instance has no operation in flight',
    async () => {
      const [row] = await query(
        `SELECT active_operation_id, lifecycle_state FROM control.instances WHERE id = $1`,
        [instanceId],
      );
      if (!row) throw new Error('the instance row is gone');
      if (row.active_operation_id) {
        throw new Error(`operation ${row.active_operation_id} is still running`);
      }
      return true;
    },
    timeoutMs,
    4_000,
  );
}

const fixture = { hostname: `console-${Date.now().toString(36)}` };

let browser;
let page;
/** Everything the page logged and every response body it received, for the redaction scan. */
const consoleLines = [];
const responseBodies = [];

// ---------------------------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------------------------

await check('console-is-healthy', async () => {
  const live = await fetch(`${CONSOLE_BASE}/health/live`);
  const ready = await fetch(`${CONSOLE_BASE}/health/ready`);
  assert.equal(live.status, 200, `liveness answered ${live.status}`);
  assert.equal(ready.status, 200, `readiness answered ${ready.status}`);
  return { liveness: live.status, readiness: ready.status };
});

await check('project-is-clear-for-a-run', async () => {
  // The quota is three instances and three addresses, so leftovers from an earlier run exhaust it
  // and the next create is refused at admission before it can test anything.
  //
  // The guard is the **empty reserved interval**, not the row: every instance in this project can
  // only ever have had a VM inside it, so if the interval is empty then no address is in use and
  // no row is the last record of a live machine. This refuses to touch anything otherwise.
  // An interrupted run can leave a VM behind, and the guard below would then refuse for the rest
  // of the day. Anything in the interval carrying this control plane's ownership marker is removed
  // first — by VMID, after reading the marker, which is the same proof the purge path requires.
  for (const vmid of await reservedVmids()) {
    const config = await proxmox(`/nodes/${NODE}/qemu/${vmid}/config`);
    const marker = String(config.description ?? '');
    if (!marker.startsWith('private-cloud-control:')) continue;
    const owned = JSON.parse(marker.slice('private-cloud-control:'.length).split('\n')[0]);
    if (owned.projectId !== PROJECT_ID) continue;
    const headers = {
      Authorization: `PVEAPIToken=${credentials.PROXMOX_API_TOKEN_ID}=${credentials.PROXMOX_API_TOKEN_SECRET}`,
    };
    await fetch(
      `${credentials.PROXMOX_ENDPOINT}/api2/json/nodes/${NODE}/qemu/${vmid}/status/stop`,
      { method: 'POST', headers, signal: AbortSignal.timeout(30_000) },
    ).catch(() => undefined);
    await new Promise((settle) => setTimeout(settle, 12_000));
    await fetch(`${credentials.PROXMOX_ENDPOINT}/api2/json/nodes/${NODE}/qemu/${vmid}?purge=1`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(40_000),
    }).catch(() => undefined);
    await new Promise((settle) => setTimeout(settle, 8_000));
  }

  const present = await reservedVmids();
  assert.deepEqual(present, [], `refusing to clear rows while VMs exist: ${present.join(', ')}`);

  const stale = await query(
    `SELECT id, lifecycle_state FROM control.instances WHERE project_id = $1`,
    [PROJECT_ID],
  );
  for (const row of stale) {
    // The lease rows go first: `ipv4_leases_instance_id_fkey` refuses to let an instance be
    // deleted while one references it, and releasing a lease is not deleting it.
    await query(`DELETE FROM control.ipv4_leases WHERE instance_id = $1`, [row.id]);
    await query(`DELETE FROM control.snapshots WHERE instance_id = $1`, [row.id]);
    await query(`DELETE FROM terraform.workspaces WHERE instance_id = $1`, [row.id]);
    await query(`DELETE FROM control.instances WHERE id = $1`, [row.id]);
  }
  const remaining = await query(
    `SELECT count(*)::int AS total FROM control.instances WHERE project_id = $1`,
    [PROJECT_ID],
  );
  assert.equal(remaining[0].total, 0, 'instances remain after clearing');
  return { cleared: stale.length, states: stale.map((row) => row.lifecycle_state) };
});

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------

// The side-effecting setup is skipped under `--list`, which names the checks and changes nothing.
// Without this it rotated the demo password and restarted the identity stub as a side effect of
// asking what the checks are — and `--list` has to run after every `check()` call has registered
// its name, so an early exit is not available.
const account = listOnly ? { username: '', password: '' } : await demoCredentials();

let context;
if (!listOnly) {
  browser = await chromium
    .launch({ channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }));
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('response', async (response) => {
    // Only the console's own responses, and only text: an image body is not worth scanning and
    // a failed body read must not fail the run.
    if (!response.url().startsWith(CONSOLE_BASE)) return;
    const type = response.headers()['content-type'] ?? '';
    if (!type.includes('json') && !type.includes('text')) return;
    responseBodies.push(await response.text().catch(() => ''));
  });
}

await check('an-unauthenticated-deep-link-redirects-to-sign-in', async () => {
  // The case that produces this in practice is a link shared with someone whose session expired.
  await page.goto(`${CONSOLE_BASE}/servers/some-id/networking`);
  await page.waitForURL(/\/login$/, { timeout: 15_000 });
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10_000 });
  return { landedOn: new URL(page.url()).pathname };
});

await check('a-wrong-password-is-refused', async () => {
  await page.goto(`${CONSOLE_BASE}/login`);
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Sign-in failed').waitFor({ timeout: 15_000 });
  // Still on the sign-in page, and no session was established.
  assert.match(page.url(), /\/login$/, `navigated to ${page.url()}`);
  const session = await fetch(`${CONSOLE_BASE}/auth/session`);
  assert.equal(session.status, 401, `session answered ${session.status}`);
  return { message: await page.getByText('Sign-in failed').textContent() };
});

await check('signing-in-lands-on-the-servers-list', async () => {
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/servers$/, { timeout: 30_000 });
  // The shell shows the real project name, read from `getProject` — not a hardcoded string.
  await page.getByText('testsrv-lab').waitFor({ timeout: 15_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/console-servers-list.png` });
  return { landedOn: new URL(page.url()).pathname, project: 'testsrv-lab' };
});

await check('the-browser-never-holds-an-access-token', async () => {
  // The property the whole BFF design exists for. The session cookie must be httpOnly, so it is
  // absent from `document.cookie`, and nothing token-shaped may sit in either web storage.
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === 'console_session');
  assert.ok(session, 'no session cookie was set');
  assert.equal(session.httpOnly, true, 'the session cookie is not httpOnly');
  assert.equal(session.sameSite, 'Strict', `sameSite is ${session.sameSite}`);

  const exposed = await page.evaluate(() => ({
    documentCookie: document.cookie,
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  assert.ok(
    !exposed.documentCookie.includes('console_session'),
    'the session cookie is readable from document.cookie',
  );
  // A JWT is three base64url segments separated by dots. Nothing of that shape may be in storage.
  const jwt = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;
  for (const [where, value] of Object.entries(exposed)) {
    assert.ok(!jwt.test(value), `something token-shaped is in ${where}`);
  }
  return {
    httpOnly: true,
    sameSite: session.sameSite,
    documentCookieEmpty: exposed.documentCookie === '',
    localStorageEmpty: exposed.local === '{}',
  };
});

await check('the-wizard-shows-the-real-catalog', async () => {
  // The catalog used to be ten flavours and six datacentres belonging to another company. What
  // must appear now is what the API serves: this deployment's two flavours and its one network.
  await page.goto(`${CONSOLE_BASE}/servers/create`);
  await page.getByRole('heading', { name: 'Create a server' }).waitFor({ timeout: 20_000 });
  // The image has to be chosen explicitly. The catalog carries two provider profiles and the
  // console cannot know which one the running provider serves, so it does not guess — it shows
  // each image's profile and lists only that profile's networks. Selecting the wrong one here
  // would produce a create the provider refuses as not allowlisted.
  await page.getByRole('button', { name: /Ubuntu Noble/ }).click();

  const body = await page.locator('body').innerText();
  for (const expected of ['Lab Small', 'Lab Medium', 'Test server vmbr1', 'proxmox-testsrv']) {
    // Case-insensitive, because the profile label is rendered with `text-transform: uppercase`
    // and `innerText` returns the transformed text rather than the source.
    assert.ok(
      new RegExp(expected.replaceAll('-', '\\-'), 'i').test(body),
      `the wizard does not show ${expected}`,
    );
  }
  // And the other profile's network must not be offered alongside it.
  assert.ok(!body.includes('Lab primary'), 'the wizard offers a network from another profile');
  for (const absent of ['CPX12', 'Falkenstein', 'Helsinki', 'Nuremberg']) {
    assert.ok(!body.includes(absent), `the wizard still shows ${absent}`);
  }
  await page.screenshot({ path: `${SCREENSHOT_DIR}/console-create-wizard.png`, fullPage: true });
  return { flavors: ['Lab Small', 'Lab Medium'], network: 'Test server vmbr1' };
});

await check('the-wizard-caps-the-count-at-the-remaining-quota', async () => {
  // The real limit is three. Offering ten would mean the fourth create is refused with
  // QUOTA_EXCEEDED after three had already been accepted.
  const [quota] = await query(
    `SELECT q.instances AS limit_instances,
            (SELECT count(*) FROM control.instances i
              WHERE i.project_id = q.project_id
                AND i.lifecycle_state NOT IN ('purged', 'retained'))::int AS used
       FROM control.quotas q WHERE q.project_id = $1`,
    [PROJECT_ID],
  );
  const headroom = Math.max(0, quota.limit_instances - quota.used);
  const more = page.getByRole('button', { name: 'More servers' });

  // Pressed while it is enabled rather than a fixed number of times: the cap is the *remaining*
  // quota, so how many presses are available depends on what the project already holds.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await more.isDisabled()) break;
    await more.click();
  }
  const count = await page.getByRole('status').textContent();
  const reached = Number(/\d+/.exec(count ?? '0')?.[0] ?? 0);
  assert.equal(
    reached,
    Math.max(1, Math.min(10, headroom)),
    `the stepper reached ${reached} with ${headroom} of quota remaining`,
  );
  return { quotaLimit: quota.limit_instances, used: quota.used, cappedAt: reached };
});

await check('a-create-is-accepted-and-appears-as-provisioning', async () => {
  // The wizard was left on the right image by the catalog check; re-assert it rather than assume,
  // because a reload between checks would return to the default.
  await page.getByRole('button', { name: /Ubuntu Noble/ }).click();

  // And the smallest flavour explicitly. It is the one whose disk matches the clone template,
  // which is what makes the snapshot checks below possible — a create that grows the disk beyond
  // the template's produces a VM Proxmox answers `snapshot feature is not available` for.
  await page.getByRole('row', { name: /Lab Small/ }).click();

  // Back to one, whatever the cap allowed above.
  const fewer = page.getByRole('button', { name: 'Fewer servers' });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const label = await page.getByRole('status').textContent();
    if (Number(/\d+/.exec(label ?? '1')?.[0] ?? 1) <= 1) break;
    await fewer.click();
  }
  const hostname = page.getByLabel('Hostname');
  await hostname.fill(fixture.hostname);
  await page.getByRole('button', { name: /Create/ }).click();

  await page.waitForURL(/\/servers$/, { timeout: 60_000 });
  // The row appears immediately, in a provisioning state — which is what the control plane
  // actually does: it commits intent and converges afterwards.
  await page.getByRole('link', { name: fixture.hostname }).waitFor({ timeout: 30_000 });

  const [row] = await query(
    `SELECT id, lifecycle_state FROM control.instances WHERE project_id = $1 AND hostname = $2`,
    [PROJECT_ID, fixture.hostname],
  );
  assert.ok(row, 'no instance row was committed');
  fixture.instanceId = row.id;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/console-provisioning.png` });
  return { instanceId: row.id, lifecycleState: row.lifecycle_state };
});

await check('the-create-converges-and-a-real-vm-exists', async () => {
  const vmid = await waitFor(
    'a VM appears in the reserved interval',
    async () => {
      const present = await reservedVmids();
      return present.length === 1 ? present[0] : false;
    },
    CREATE_TIMEOUT_MS,
  );
  fixture.vmid = vmid;

  await waitFor(
    'the instance reaches active',
    async () => {
      const [row] = await query(`SELECT lifecycle_state FROM control.instances WHERE id = $1`, [
        fixture.instanceId,
      ]);
      return row?.lifecycle_state === 'active';
    },
    CREATE_TIMEOUT_MS,
  );

  // Ownership, proven from the VM's own description rather than inferred from its VMID.
  const config = await proxmox(`/nodes/${NODE}/qemu/${vmid}/config`);
  const marker = String(config.description ?? '');
  assert.ok(marker.startsWith('private-cloud-control:'), 'the VM carries no ownership marker');
  const parsed = JSON.parse(marker.slice('private-cloud-control:'.length).split('\n')[0]);
  assert.equal(parsed.instanceId, fixture.instanceId, 'the marker names a different instance');
  assert.equal(parsed.projectId, PROJECT_ID, 'the marker names a different project');
  return { vmid, hostname: config.name, markerInstanceId: parsed.instanceId };
});

await check('the-list-shows-the-address-the-server-was-leased', async () => {
  await page.goto(`${CONSOLE_BASE}/servers`);
  const [lease] = await query(
    `SELECT address FROM control.ipv4_leases WHERE instance_id = $1 AND state = 'active'`,
    [fixture.instanceId],
  );
  assert.ok(lease, 'no active lease was recorded');
  fixture.address = lease.address;
  // Read from the page, not from the database: the point is that the console shows it.
  await page.getByText(lease.address).first().waitFor({ timeout: 30_000 });
  return { address: lease.address };
});

await check('power-off-and-on-through-the-console', async () => {
  await waitForIdle(fixture.instanceId);
  await page.goto(`${CONSOLE_BASE}/servers/${fixture.instanceId}/power`);
  // The tab offers `Shut down` only while the server is running, and the observed power state
  // arrives from a reconciliation rather than instantly after the create.
  const shutDown = page.getByRole('button', { name: 'Shut down' });
  await waitFor(
    'the power tab offers a shutdown',
    async () => {
      await page.reload();
      // Wait for the panel itself, not just the navigation: reading immediately after `reload`
      // asks the question before React has rendered an answer.
      await page.getByRole('heading', { name: 'POWER' }).waitFor({ timeout: 20_000 });
      return (await shutDown.count()) > 0;
    },
    180_000,
    5_000,
  );
  await shutDown.click();
  await waitForIdle(fixture.instanceId);
  await waitFor(
    'the VM stops',
    async () =>
      (await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/status/current`)).status === 'stopped',
    ACTION_TIMEOUT_MS,
  );

  // The console's power state comes from the *observed* state, which a workflow writes when it
  // finishes observing — so the button flips a moment after the VM does, not with it.
  const powerOn = page.getByRole('button', { name: 'Power on' });
  await waitFor(
    'the power tab offers a start',
    async () => {
      await page.reload();
      await page.getByRole('heading', { name: 'POWER' }).waitFor({ timeout: 20_000 });
      return (await powerOn.count()) > 0;
    },
    180_000,
    5_000,
  );
  await powerOn.click();
  await waitForIdle(fixture.instanceId);
  await waitFor(
    'the VM runs again',
    async () =>
      (await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/status/current`)).status === 'running',
    ACTION_TIMEOUT_MS,
  );
  return { stopped: true, restarted: true };
});

await check('a-disk-shrink-is-refused-before-it-is-submitted', async () => {
  // SAFE-026 holds at three layers: the form, the API, and bpg. This asserts the first, because
  // the other two have already been proven and the point of the form guard is that a user never
  // waits for a refusal that was predictable.
  await waitForIdle(fixture.instanceId);
  await page.goto(`${CONSOLE_BASE}/servers/${fixture.instanceId}/rescale`);
  await page.getByRole('heading', { name: 'RESCALE' }).waitFor({ timeout: 20_000 });
  const select = page.getByLabel('New server type');
  await select.waitFor({ timeout: 20_000 });
  const options = await select.locator('option').allTextContents();
  // `lab-small` is 32 GB and `lab-medium` is 64, so from medium a return to small would shrink.
  return { offered: options.filter(Boolean).length, note: 'shrink guard asserted after the grow' };
});

await check('a-rescale-to-the-larger-flavour-succeeds', async () => {
  await waitForIdle(fixture.instanceId);
  await page.goto(`${CONSOLE_BASE}/servers/${fixture.instanceId}/rescale`);
  // Re-resolved on each attempt: the instance list refetches while a workflow is in flight, and
  // a handle taken before a re-render points at a detached node — which surfaces as a
  // `selectOption` timeout rather than as the staleness it is.
  await waitFor(
    'the rescale form offers the larger flavour',
    async () => {
      const select = page.getByLabel('New server type');
      await select.waitFor({ timeout: 10_000 });
      const offered = await select
        .locator('option')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('value')));
      if (!offered.includes('lab-medium')) {
        throw new Error(`it offers ${offered.filter(Boolean).join(', ') || 'nothing'}`);
      }
      // By value: `selectOption`'s `label` takes a string, and the visible label carries the
      // whole sizing summary.
      await select.selectOption('lab-medium');
      return true;
    },
    60_000,
    4_000,
  );
  await page.getByRole('button', { name: 'Rescale', exact: true }).click();
  // Scoped to the dialog, so the confirmation cannot match the page's own button behind it.
  await page
    .getByRole('dialog', { name: 'Rescale server' })
    .getByRole('button', { name: 'Rescale' })
    .click();

  await waitFor(
    'the VM reports the larger sizing',
    async () => {
      const config = await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/config`);
      return Number(config.cores) === 4 && Number(config.memory) === 8192;
    },
    ACTION_TIMEOUT_MS,
  );

  // Now the shrink guard has something to refuse: the server is medium, so small is smaller.
  await waitForIdle(fixture.instanceId);
  await page.goto(`${CONSOLE_BASE}/servers/${fixture.instanceId}/rescale`);
  const back = page.getByLabel('New server type');
  await back.waitFor({ timeout: 20_000 });
  await back.selectOption('lab-small');
  await page.getByText('That type has a smaller disk.').waitFor({ timeout: 15_000 });
  const disabled = await page
    .getByRole('button', { name: 'Rescale', exact: true })
    .first()
    .isDisabled();
  assert.equal(disabled, true, 'the form offered a shrink');
  return { grewTo: 'lab-medium', shrinkRefusedInTheForm: true };
});

await check('the-snapshot-lifecycle-works-through-the-console', async () => {
  // Possible at all because the clone template is qcow2: Proxmox refuses to snapshot a raw disk.
  await waitForIdle(fixture.instanceId);
  await page.goto(`${CONSOLE_BASE}/servers/${fixture.instanceId}/snapshots`);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  // Scoped by the dialog's accessible name, because the page behind it also has a `Name` field
  // and a `Create` button.
  const dialog = page.getByRole('dialog', { name: 'Take snapshot' });
  await dialog.waitFor({ timeout: 20_000 });
  const name = await dialog.getByLabel('Name').first().inputValue();
  await dialog.getByRole('button', { name: /Create/ }).click();
  await waitForIdle(fixture.instanceId);

  await waitFor(
    'the snapshot exists on the server',
    async () => {
      const snapshots = await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/snapshot`);
      return snapshots.some((entry) => entry.name === name);
    },
    ACTION_TIMEOUT_MS,
  );

  await page.reload();
  await page.getByRole('button', { name: 'Roll back' }).first().waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Roll back' }).first().click();
  await page
    .getByRole('dialog', { name: 'Roll back to snapshot' })
    .getByRole('button', { name: 'Roll back' })
    .click();
  await waitFor(
    'the rollback settles',
    async () => {
      const [row] = await query(
        `SELECT state FROM control.snapshots WHERE instance_id = $1 AND name = $2`,
        [fixture.instanceId, name],
      );
      return row?.state === 'available';
    },
    ACTION_TIMEOUT_MS,
  );

  await page.reload();
  await page
    .getByLabel(/Actions for/)
    .first()
    .click();
  await waitFor(
    'the snapshot is gone from the server',
    async () => {
      const snapshots = await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/snapshot`);
      return !snapshots.some((entry) => entry.name === name);
    },
    ACTION_TIMEOUT_MS,
  );
  return { name, exercised: 'create, rollback, delete' };
});

await check('delete-is-a-soft-delete-and-the-vm-survives', async () => {
  // SAFE-028. The console must not present this as a destroy, and the machine must still be there
  // afterwards — which is the whole distinction between a retain and a purge.
  await waitForIdle(fixture.instanceId);
  await page.goto(`${CONSOLE_BASE}/servers/${fixture.instanceId}/delete`);
  await page.getByText('DELETE', { exact: true }).waitFor({ timeout: 20_000 });
  const body = await page.locator('body').innerText();
  // The copy has to say the machine survives, because "Delete" on its own would mislead in the
  // other direction. Asserted against the words the page actually uses.
  assert.ok(
    body.includes('retained for a review period rather than destroyed'),
    'the delete page does not say the machine is retained rather than destroyed',
  );
  await page.getByRole('button', { name: 'Delete server' }).first().click();
  const confirm = page.getByRole('dialog', { name: 'Delete server' });
  await confirm.waitFor({ timeout: 20_000 });
  await confirm.getByLabel(/Type .* to confirm/).fill(fixture.hostname);
  await confirm.getByRole('button', { name: 'Delete server' }).click();

  await waitFor(
    'the instance is retained',
    async () => {
      const [row] = await query(`SELECT lifecycle_state FROM control.instances WHERE id = $1`, [
        fixture.instanceId,
      ]);
      return row?.lifecycle_state === 'retained';
    },
    ACTION_TIMEOUT_MS,
  );

  const stillThere = await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/config`);
  assert.ok(stillThere, 'the soft delete destroyed the VM');
  return { lifecycleState: 'retained', vmSurvived: true, vmid: fixture.vmid };
});

await check('no-credential-reached-the-browser', async () => {
  // The password and the token are the two values that must appear nowhere the page can see.
  const haystack = [...consoleLines, ...responseBodies].join('\n');
  const found = [];
  if (haystack.includes(account.password)) found.push('the demo password');
  if (/eyJ[A-Za-z0-9_-]{10,}\./.test(haystack)) found.push('something JWT-shaped');
  if (haystack.includes(credentials.PROXMOX_API_TOKEN_SECRET)) found.push('the Proxmox token');
  assert.deepEqual(found, [], `values reached the browser: ${found.join(', ')}`);
  return {
    consoleLinesScanned: consoleLines.length,
    responseBodiesScanned: responseBodies.length,
  };
});

// ---------------------------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------------------------

if (!listOnly && !keep && fixture.vmid) {
  await check('teardown', async () => {
    // Destroyed by VMID, after reading the ownership marker, by the tool that made it. Not a
    // compensation path: this is a verification fixture, and `--keep` leaves it for inspection.
    const remaining = await reservedVmids();
    if (!remaining.includes(fixture.vmid)) {
      return { destroyed: null, note: 'the VM was already gone' };
    }
    const config = await proxmox(`/nodes/${NODE}/qemu/${fixture.vmid}/config`);
    const marker = String(config.description ?? '');
    assert.ok(
      marker.includes(`"instanceId":"${fixture.instanceId}"`),
      'refusing to destroy a VM whose marker does not name this run',
    );
    const headers = {
      Authorization: `PVEAPIToken=${credentials.PROXMOX_API_TOKEN_ID}=${credentials.PROXMOX_API_TOKEN_SECRET}`,
    };
    await fetch(
      `${credentials.PROXMOX_ENDPOINT}/api2/json/nodes/${NODE}/qemu/${fixture.vmid}/status/stop`,
      { method: 'POST', headers, signal: AbortSignal.timeout(30_000) },
    );
    await new Promise((settle) => setTimeout(settle, 12_000));
    const destroyed = await fetch(
      `${credentials.PROXMOX_ENDPOINT}/api2/json/nodes/${NODE}/qemu/${fixture.vmid}?purge=1`,
      { method: 'DELETE', headers, signal: AbortSignal.timeout(40_000) },
    );
    assert.ok(destroyed.ok, `the destroy returned ${destroyed.status}`);
    return { destroyed: fixture.vmid };
  });
}

if (browser) await browser.close();

if (listOnly) {
  process.stdout.write(`${names.join('\n')}\n`);
  await pool.end();
} else {
  evidence.finishedAt = new Date().toISOString();
  evidence.status = failures.length === 0 ? 'passed' : 'failed';
  evidence.failures = failures;
  evidence.fixture = fixture;
  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const ran = Object.keys(evidence.checks);
  process.stdout.write(`\n${'-'.repeat(94)}\n`);
  for (const name of ran) {
    const { status, durationMs } = evidence.checks[name];
    process.stdout.write(
      `${status === 'passed' ? '✓' : '✗'} ${name.padEnd(58)} ${(durationMs / 1000).toFixed(1)}s\n`,
    );
  }
  process.stdout.write(`${'-'.repeat(94)}\n`);
  process.stdout.write(
    `${ran.length - failures.length}/${ran.length} checks passed. Evidence: ${EVIDENCE_PATH}\n`,
  );
  await pool.end();
  process.exitCode = failures.length === 0 ? 0 : 1;
}
