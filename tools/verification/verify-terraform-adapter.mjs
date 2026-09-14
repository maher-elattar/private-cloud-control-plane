/**
 * Drives the Terraform adapter against the real Proxmox server, layer by layer.
 *
 * PATTERN — record every outcome, do not fail fast. Taken from `tools/kubernetes/verify-phase6.mjs`
 * for the same reason: a run that stops at the first problem hides every later one, and the later
 * ones are usually what explains the first.
 *
 * This verifies the **provider half** of the create path: the adapter, the runner, the plan gate,
 * the inventory, Terraform, and the server. It does not go through HTTP, Kafka or the
 * orchestrator; that is the next layer and needs a provider container carrying the Terraform
 * binary. Verifying the half that can be verified now is how the live checkpoint stays short.
 *
 * **It creates a real VM** inside the reserved interval and destroys it at the end. Every
 * destructive step is this tool's own lab instance, never anything else on the server.
 *
 * Usage:
 *   DATABASE_URL=... node tools/verification/verify-terraform-adapter.mjs
 *   DATABASE_URL=... node tools/verification/verify-terraform-adapter.mjs --keep
 *
 * Evidence: docs/verification/evidence/terraform-adapter.json
 *
 * @see terraform-provisioning-checkpoints.md
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

import {
  ProxmoxDirectClient,
  TerraformProxmoxProvider,
  TerraformRunner,
} from '../../packages/provider-adapters/dist/index.js';
import {
  createPostgresDatabase,
  PostgresTerraformInventoryStore,
} from '../../packages/postgres-adapter/dist/index.js';
// The generated enums carry string values, not ordinals. Comparing against a number silently
// fails every time, which is exactly what the first run of this tool did.
import {
  ProviderResultState,
  ProviderTaskState,
} from '../../packages/contracts/dist/generated/proto/privatecloud/provider/v1/provider.pb.js';

/** Where the machine-readable record is written. */
const EVIDENCE_PATH = resolve('docs/verification/evidence/terraform-adapter.json');

/** The gitignored credentials file. */
const CREDENTIALS_PATH = resolve('terraformProxServerTestCredntails.txt');

/** The catalog identifiers seeded by `db/seeds/0002_proxmox_testsrv.sql`. */
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const PROFILE_ID = 'proxmox-testsrv';
const IMAGE_ID = 'ubuntu-noble-2404';
const NETWORK_ID = 'testsrv-vmbr1';

/** Server facts from the survey. */
const NODE = 'proxtest';
const STORAGE = 'local';
const BRIDGE = 'vmbr1';
const TEMPLATE_VMID = 110;
const NETWORK_MTU = 1400;

/** How long to wait for an apply to settle before calling the outcome unknown. */
const APPLY_TIMEOUT_MS = 240_000;

const flags = process.argv.slice(2);
const keep = flags.includes('--keep');

const evidence = {
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: {},
};
const failures = [];

/** Runs one named check, recording its outcome rather than aborting the suite. */
async function check(name, body) {
  const startedAt = Date.now();
  process.stdout.write(`▶ ${name}\n`);
  try {
    const detail = (await body()) ?? {};
    // The verdict is written *after* the detail, so a check that returns a field called `status`
    // cannot overwrite its own result. One did — it reported the run's status, which is `running`
    // at that point — and the summary rendered a passing check as failed while still counting it
    // as passed. A reporter that can disagree with itself is worse than a terse one.
    evidence.checks[name] = { ...detail, status: 'passed', durationMs: Date.now() - startedAt };
    process.stdout.write(`  ✓ ${name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`);
    return detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.checks[name] = {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: message,
    };
    failures.push(`${name}: ${message}`);
    process.stdout.write(`  ✗ ${name}: ${message}\n`);
    return undefined;
  }
}

/** Asserts, with a message that says what was expected and what was found. */
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --- Credentials and configuration ---

const credentialLines = (await readFile(CREDENTIALS_PATH, 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
const credentials = Object.fromEntries(
  credentialLines
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

const endpoint = credentials.PROXMOX_ENDPOINT?.replace(/\/$/, '');
const tokenId = credentials.PROXMOX_API_TOKEN_ID;
const tokenSecret = credentials.PROXMOX_API_TOKEN_SECRET;
if (!endpoint || !tokenId || !tokenSecret) {
  throw new Error(`${CREDENTIALS_PATH} must carry an endpoint and an API token.`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

/**
 * The state backend's connection string, which is deliberately not `DATABASE_URL`.
 *
 * Terraform's `pg` backend uses lib/pq and defaults TLS **on**; node-postgres defaults it off.
 * The same string therefore works for the application and fails for Terraform with
 * `pq: SSL is not enabled on the server`. `TERRAFORM_STATE_CONN_STR` exists for exactly this,
 * and the local test database speaks plaintext.
 */
const stateConnectionString =
  process.env.TERRAFORM_STATE_CONN_STR ??
  `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}sslmode=disable`;

// bpg reads these. Set here rather than passed, because a connection string or token on a
// command line lands in shell history and the process table.
process.env.PROXMOX_VE_ENDPOINT = endpoint;
process.env.PROXMOX_VE_API_TOKEN = `${tokenId}=${tokenSecret}`;
process.env.PROXMOX_VE_INSECURE = 'false';

const workingRoot = await mkdtemp(join(tmpdir(), 'tf-adapter-verify-'));
const instanceId = randomUUID();
const operationId = randomUUID();

const runner = new TerraformRunner({
  binary: process.env.TERRAFORM_BINARY ?? 'terraform',
  modulePath: resolve('deploy/terraform/modules/instance'),
  purgeModulePath: resolve('deploy/terraform/modules/instance-purge'),
  workingRoot,
  backendConnectionString: stateConnectionString,
  timeoutMs: APPLY_TIMEOUT_MS,
});

const db = createPostgresDatabase(databaseUrl);
const runs = new PostgresTerraformInventoryStore(db);

const directClient = new ProxmoxDirectClient({
  endpoint,
  apiTokenId: tokenId,
  apiTokenSecret: tokenSecret,
  node: NODE,
  resourceIdMinimum: 910_000,
  resourceIdMaximum: 910_099,
});

const provider = new TerraformProxmoxProvider(
  {
    providerProfileId: PROFILE_ID,
    projectId: PROJECT_ID,
    node: NODE,
    templateVmid: TEMPLATE_VMID,
    imageId: IMAGE_ID,
    storage: STORAGE,
    diskInterface: 'scsi0',
    bridge: BRIDGE,
    networkMtu: NETWORK_MTU,
    networkId: NETWORK_ID,
    ipv4Cidr: '192.168.4.0/22',
    ipv4Gateway: '192.168.4.1',
    dnsDomain: 'lab.invalid',
    cloudInitUsername: 'ubuntu',
    cloudInitPassword: credentials.PROXMOX_ROOT_PASSWORD ?? 'lab-placeholder-password',
    resourceIdMinimum: 910_000,
    resourceIdMaximum: 910_099,
    environment: 'lab',
    managedBy: 'private-cloud-control-plane',
  },
  runner,
  runs,
  directClient,
);

const ownership = {
  managedBy: 'private-cloud-control-plane',
  environment: 'lab',
  projectId: PROJECT_ID,
  instanceId,
  createOperationId: operationId,
};

const context = {
  requestId: `${operationId}:create`,
  operationId,
  correlationId: randomUUID(),
  projectId: PROJECT_ID,
  instanceId,
  providerProfileId: PROFILE_ID,
  attempt: 1,
};

/**
 * One read-only Proxmox API call with the scoped token, retried on transport failure.
 *
 * WHY retry: these are assertions *about* the server, not operations on it, and a dropped packet
 * is not a finding. A run once failed its very first precondition on `fetch failed`, which said
 * nothing about the system under test and invalidated an otherwise complete result. HTTP status
 * codes are **not** retried — a 403 or a 500 is an answer.
 */
async function proxmox(path, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/api2/json${path}`, {
        headers: { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return (await response.json()).data;
    } catch (error) {
      lastError = error;
      const transport = error instanceof Error && !/returned \d{3}/.test(error.message);
      if (!transport || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw lastError;
}

/** The instance row the inventory's foreign key requires. */
async function seedInstanceRow() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(
      `INSERT INTO control.instances (
         id, project_id, image_id, flavor_id, network_id, provider_profile_id, hostname,
         ssh_public_keys, desired_cpu_count, desired_memory_mib, desired_disk_gib,
         desired_power_state, lifecycle_state, created_at, updated_at
       ) VALUES ($1,$2,$3,'lab-small',$4,$5,$6,'[]',2,4096,32,'running','pending',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [instanceId, PROJECT_ID, IMAGE_ID, NETWORK_ID, PROFILE_ID, `tfv-${instanceId.slice(0, 8)}`],
    );
  } finally {
    await pool.end();
  }
}

/** Removes the rows this run created, so a re-run starts clean. */
async function cleanupRows() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query('DELETE FROM terraform.workspaces WHERE instance_id = $1', [instanceId]);
    await pool.query('DELETE FROM terraform.runs WHERE instance_id = $1', [instanceId]);
    await pool.query('DELETE FROM control.instances WHERE id = $1', [instanceId]);
  } finally {
    await pool.end();
  }
}

let createdVmId;

try {
  process.stdout.write(`verifying the Terraform adapter against ${endpoint}\n`);
  process.stdout.write(`instance ${instanceId}\n\n`);

  await check('reserved-range-is-clear', async () => {
    // SAFE-030's operation cap, enforced before anything is created: a run that found leftovers
    // would be adding to them rather than testing a clean path.
    const vms = await proxmox(`/nodes/${NODE}/qemu`);
    const reserved = vms.filter((vm) => vm.vmid >= 910_000 && vm.vmid <= 910_099);
    expect(
      reserved.length === 0,
      `the reserved interval already holds ${reserved.length} VM(s): ${reserved
        .map((vm) => vm.vmid)
        .join(', ')}`,
    );
    return { totalVms: vms.length, reserved: reserved.length };
  });

  await check('database-is-migrated', async () => {
    await seedInstanceRow();
    return { instanceRow: 'seeded' };
  });

  await check('validate-profile', async () => {
    const response = await provider.validateProfile({
      profile: { providerProfileId: PROFILE_ID },
    });
    const named = (response.checks ?? []).map((entry) => `${entry.name}=${entry.state}`);
    expect(response.valid === true, `validateProfile reported invalid: ${named.join(' ')}`);
    return { checks: named };
  });

  const submitted = await check('submit-create', async () => {
    const response = await provider.submitCreateInstance({
      context,
      imageId: IMAGE_ID,
      flavorId: 'lab-small',
      hostname: `tfv-${instanceId.slice(0, 8)}`,
      resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
      network: {
        networkId: NETWORK_ID,
        ipv4Address: '192.168.4.3',
        ipv4PrefixLength: 22,
        ipv4Gateway: '192.168.4.1',
        dnsServers: ['1.1.1.1'],
      },
      sshPublicKeys: [],
      ownershipMarkers: ownership,
    });

    const result = response.result;
    expect(
      result?.state === ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      `expected ACCEPTED, got ${result?.state}`,
    );
    expect(Boolean(result?.providerTaskReference), 'no task reference was returned');
    createdVmId = Number(result?.providerResourceId);
    expect(
      createdVmId >= 910_000 && createdVmId <= 910_099,
      `VMID ${createdVmId} is outside the reserved interval`,
    );
    return { taskReference: result?.providerTaskReference, vmId: createdVmId };
  });

  await check('run-row-exists-before-the-apply-settles', async () => {
    // SAFE-014: the reference the workflow polls is durable, and it was durable before the caller
    // was answered — which is what makes a worker restart survivable.
    const run = await runs.readRun(submitted.taskReference);
    expect(run !== null, 'the run row is absent');
    expect(run.instanceId === instanceId, 'the run names a different instance');
    return { runStatus: run.status, runCommand: run.command };
  });

  const settled = await check('poll-task-to-completion', async () => {
    const deadline = Date.now() + APPLY_TIMEOUT_MS;
    let state;
    let polls = 0;
    while (Date.now() < deadline) {
      polls += 1;
      const response = await provider.getTask({
        context,
        providerTaskReference: submitted.taskReference,
      });
      state = response.state;
      if (state !== ProviderTaskState.PROVIDER_TASK_STATE_RUNNING) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    const run = await runs.readRun(submitted.taskReference);
    expect(
      state === ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED,
      `the task settled at ${state} after ${polls} polls; run status ${run?.status}, gate ${run?.gateDecision}, diagnostics ${JSON.stringify(run?.diagnostics)?.slice(0, 300)}`,
    );
    return { polls, runStatus: run?.status, planActions: run?.planActions };
  });

  await check('gate-allowed-a-create-and-nothing-else', async () => {
    const run = await runs.readRun(submitted.taskReference);
    expect(run.gateDecision === 'allowed', `gate decision was ${run.gateDecision}`);
    const actions = run.planActions ?? {};
    expect(actions.create === 1, `expected create=1, got ${JSON.stringify(actions)}`);
    expect((actions.delete ?? 0) === 0, `a delete was planned: ${JSON.stringify(actions)}`);
    return { planActions: actions };
  });

  await check('proxmox-holds-the-expected-vm', async () => {
    const config = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    expect(Number(config.cores) === 2, `cores=${config.cores}`);
    expect(Number(config.memory) === 4096, `memory=${config.memory}`);
    expect(String(config.net0).includes(`bridge=${BRIDGE}`), `net0=${config.net0}`);
    // The MTU the direct adapter preserves by accident and a network_device block must set.
    expect(String(config.net0).includes('mtu=1400'), `net0 lost the MTU: ${config.net0}`);
    expect(String(config.ipconfig0).includes('ip=192.168.4.3/22'), `ipconfig0=${config.ipconfig0}`);
    expect(String(config.ipconfig0).includes('gw=192.168.4.1'), `ipconfig0=${config.ipconfig0}`);
    expect(String(config.nameserver) === '1.1.1.1', `nameserver=${config.nameserver}`);
    expect(String(config.scsi0).includes('size=32G'), `scsi0=${config.scsi0}`);
    return {
      cores: config.cores,
      memory: config.memory,
      net0: config.net0,
      ipconfig0: config.ipconfig0,
      scsi0: config.scsi0,
    };
  });

  await check('ownership-marker-round-tripped', async () => {
    const config = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    const description = String(config.description ?? '');
    expect(
      description.startsWith('private-cloud-control:'),
      `the description does not carry a marker: ${description.slice(0, 80)}`,
    );
    const parsed = JSON.parse(description.slice('private-cloud-control:'.length).split('\n')[0]);
    expect(parsed.instanceId === instanceId, 'the marker names a different instance');
    expect(parsed.createOperationId === operationId, 'the marker names a different operation');
    return { markerFields: Object.keys(parsed).sort() };
  });

  await check('observe-reports-what-exists', async () => {
    const response = await provider.observeInstance({
      context,
      expectedOwnershipMarkers: ownership,
    });
    const observation = response.observation;
    expect(observation?.exists === true, 'observation reports the instance absent');
    expect(
      Number(observation?.providerResourceId) === createdVmId,
      `observation reports VMID ${observation?.providerResourceId}`,
    );
    expect(observation?.ownership?.match === true, 'observation could not prove ownership');
    return {
      powerState: observation?.powerState,
      ownershipMatch: observation?.ownership?.match,
    };
  });

  await check('configuration-has-converged', async () => {
    // The convergence assertion: a second plan must be empty. Verified from a *fresh* create,
    // which is the only way it proves anything — an incrementally repaired workspace proves only
    // that config and server agree, not that the config can build a correct VM from nothing.
    const response = await provider.applyInstanceConfiguration({
      context: { ...context, requestId: `${operationId}:configure` },
      providerResourceId: String(createdVmId),
      hostname: `tfv-${instanceId.slice(0, 8)}`,
      resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
      network: {
        networkId: NETWORK_ID,
        ipv4Address: '192.168.4.3',
        ipv4PrefixLength: 22,
        ipv4Gateway: '192.168.4.1',
        dnsServers: ['1.1.1.1'],
      },
      ownershipMarkers: ownership,
    });
    expect(
      response.result?.state === ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
      `convergence reported ${response.result?.state}: ${response.result?.failure?.code ?? ''}`,
    );
    return { state: response.result?.state };
  });

  await check('workspace-inventory-recorded', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const { rows } = await pool.query(
        'SELECT workspace_name, drift_state, last_applied_at, state_serial FROM terraform.workspaces WHERE instance_id = $1',
        [instanceId],
      );
      expect(rows.length === 1, `expected one workspace row, found ${rows.length}`);
      expect(rows[0].drift_state === 'in_sync', `drift_state=${rows[0].drift_state}`);
      expect(rows[0].last_applied_at !== null, 'last_applied_at is null after a successful apply');
      return {
        workspace: rows[0].workspace_name,
        driftState: rows[0].drift_state,
      };
    } finally {
      await pool.end();
    }
  });

  /** Polls whatever reference a mutation returned until it settles. */
  async function pollUntilSettled(reference, label) {
    const deadline = Date.now() + APPLY_TIMEOUT_MS;
    let state;
    let polls = 0;
    while (Date.now() < deadline) {
      polls += 1;
      const response = await provider.getTask({ context, providerTaskReference: reference });
      state = response.state;
      if (state !== ProviderTaskState.PROVIDER_TASK_STATE_RUNNING) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    expect(
      state === ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED,
      `${label} settled at ${state} after ${polls} polls`,
    );
    return polls;
  }

  const powerMutation = () => ({
    context: { ...context, requestId: `${operationId}:power`, attempt: 1 },
    providerResourceId: String(createdVmId),
    expectedOwnershipMarkers: ownership,
  });

  await check('power-off-and-on-through-terraform', async () => {
    const off = await provider.shutdownInstance(powerMutation());
    expect(
      off.result?.state === ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      `shutdown returned ${off.result?.state}`,
    );
    const offPolls = await pollUntilSettled(off.result.providerTaskReference, 'shutdown');

    const stopped = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/status/current`);
    expect(stopped.status === 'stopped', `after shutdown the VM is ${stopped.status}`);

    const on = await provider.startInstance(powerMutation());
    const onPolls = await pollUntilSettled(on.result.providerTaskReference, 'start');
    const running = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/status/current`);
    expect(running.status === 'running', `after start the VM is ${running.status}`);

    return { offPolls, onPolls };
  });

  await check('start-again-is-a-no-op', async () => {
    // A duplicate delivery must not produce a second run row for work nobody did.
    const again = await provider.startInstance(powerMutation());
    expect(
      again.result?.state === ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
      `a redundant start returned ${again.result?.state} instead of SUCCEEDED`,
    );
    expect(
      again.result?.providerTaskReference === undefined,
      'a redundant start produced a task reference, which means it applied something',
    );
    return { state: again.result?.state };
  });

  await check('reboot-through-the-direct-client', async () => {
    const rebooted = await provider.rebootInstance(powerMutation());
    const reference = rebooted.result?.providerTaskReference;
    // A direct-client reference is a Proxmox UPID and must be distinguishable from a run id.
    expect(String(reference).startsWith('upid:'), `reference was ${reference}`);
    const polls = await pollUntilSettled(reference, 'reboot');
    return { polls, reference: 'upid:<redacted>' };
  });

  await check('resize-grows-and-refuses-a-shrink', async () => {
    const shrink = await provider.resizeInstance({
      request: powerMutation(),
      targetResources: { cpuCount: 2, memoryMib: '4096', diskGib: '16' },
    });
    expect(
      shrink.result?.failure?.code === 'DISK_SHRINK_FORBIDDEN',
      `a shrink returned ${shrink.result?.failure?.code ?? shrink.result?.state}`,
    );

    const grow = await provider.resizeInstance({
      request: powerMutation(),
      targetResources: { cpuCount: 4, memoryMib: '8192', diskGib: '40' },
    });
    expect(
      grow.result?.state === ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      `a grow returned ${grow.result?.state}`,
    );
    await pollUntilSettled(grow.result.providerTaskReference, 'resize');

    const config = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    expect(Number(config.cores) === 4, `cores=${config.cores}`);
    expect(Number(config.memory) === 8192, `memory=${config.memory}`);
    expect(String(config.scsi0).includes('size=40G'), `scsi0=${config.scsi0}`);
    return { cores: config.cores, memory: config.memory, scsi0: config.scsi0 };
  });

  await check('snapshot-support-matches-the-storage', async () => {
    // Not a skip. The storage genuinely cannot snapshot this disk, and what must be verified is
    // that asking produces a *classified refusal* rather than a hang, a partial snapshot, or a
    // corrupted workspace.
    //
    // Proxmox snapshots a disk only where the storage supports it, and directory storage supports
    // snapshots only for qcow2. Template 110's disk is raw, and bpg does not convert format on a
    // clone — measured, see the module comment — so every clone of it is raw too. Making
    // snapshots work here needs a qcow2 template, which is an operator action.
    const config = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    const raw =
      String(config.scsi0).includes('format=raw') || String(config.scsi0).includes('.raw');

    if (!raw) {
      // A qcow2 template was supplied, so the capability should actually work.
      const name = 'verify-snapshot';
      const created = await provider.createSnapshot({ request: powerMutation(), name });
      await pollUntilSettled(created.result.providerTaskReference, 'createSnapshot');
      const listed = await provider.listSnapshots({
        context,
        providerResourceId: String(createdVmId),
        expectedOwnershipMarkers: ownership,
      });
      expect(
        (listed.snapshots ?? []).some((entry) => entry.name === name),
        'the snapshot is absent from the listing',
      );
      const deleted = await provider.deleteSnapshot({
        request: { request: powerMutation(), providerSnapshotReference: name },
      });
      await pollUntilSettled(deleted.result.providerTaskReference, 'deleteSnapshot');
      return { storageSupportsSnapshots: true, exercised: 'create, list, delete' };
    }

    // The listing must still work: it is a read, and an empty list is the correct answer.
    const listed = await provider.listSnapshots({
      context,
      providerResourceId: String(createdVmId),
      expectedOwnershipMarkers: ownership,
    });
    expect(Array.isArray(listed.snapshots), 'listSnapshots did not return a list');
    expect(
      !(listed.snapshots ?? []).some((entry) => entry.name === 'current'),
      'the synthetic current entry was returned',
    );

    // And the attempt must be refused in a way a workflow can act on, with the workspace intact.
    let classified = false;
    try {
      const created = await provider.createSnapshot({
        request: powerMutation(),
        name: 'verify-snapshot',
      });
      const reference = created.result?.providerTaskReference;
      if (reference) {
        const response = await provider.getTask({ context, providerTaskReference: reference });
        classified = response.state === ProviderTaskState.PROVIDER_TASK_STATE_FAILED;
      } else {
        classified = Boolean(created.result?.failure?.code);
      }
    } catch (error) {
      // A transport-level refusal is also a classified outcome.
      classified = /Proxmox/.test(String(error));
    }
    expect(classified, 'a snapshot attempt on unsupported storage was not classified as a failure');

    const after = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    expect(Boolean(after), 'the VM did not survive the refused snapshot attempt');

    return {
      storageSupportsSnapshots: false,
      limitation: 'directory storage snapshots qcow2 only; template 110 is raw',
    };
  });

  await check('direct-mutations-triggered-a-refresh', async () => {
    // Terraform did not make the reboot, so state is stale the moment it returns. Design §6.4
    // requires a refresh after every direct mutation, and this is where that rule is observed
    // rather than asserted.
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const { rows } = await pool.query(
        'SELECT drift_state, last_refreshed_at FROM terraform.workspaces WHERE instance_id = $1',
        [instanceId],
      );
      expect(rows.length === 1, `expected one workspace row, found ${rows.length}`);
      expect(
        rows[0].last_refreshed_at !== null,
        'no refresh was recorded after the direct mutations',
      );
      return { driftState: rows[0].drift_state };
    } finally {
      await pool.end();
    }
  });

  await check('retention-detaches-without-destroying', async () => {
    const retained = await provider.markInstanceRetained({
      request: powerMutation(),
      retentionDeadline: '2026-12-31T00:00:00.000Z',
    });
    expect(
      retained.result?.state === ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      `retention returned ${retained.result?.state}`,
    );
    await pollUntilSettled(retained.result.providerTaskReference, 'markInstanceRetained');

    const config = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    // SAFE-028: the resource is retained, not destroyed, and it will not come back on a host
    // restart.
    expect(String(config.onboot ?? '0') === '0', `onboot=${config.onboot}`);
    // And the marker survives, because a purge has to prove live ownership afterwards.
    const description = String(config.description ?? '');
    expect(
      description.startsWith('private-cloud-control:'),
      'retention destroyed the ownership marker',
    );
    expect(
      description.includes('retained-until=2026-12-31'),
      `the retention trailer is absent: ${description.slice(0, 120)}`,
    );
    return { onboot: config.onboot ?? '0', trailer: 'present' };
  });

  await check('purge-refuses-without-an-authorization-id', async () => {
    // SAFE-006's first half. Asserted live, because a purge that skipped it would be the single
    // most damaging defect this system could have.
    let refused = false;
    try {
      await provider.purgeInstance({
        request: powerMutation(),
        retentionDeadline: '2026-12-31T00:00:00.000Z',
      });
    } catch (error) {
      refused = /purgeAuthorizationId is required/.test(String(error));
    }
    expect(refused, 'a purge without an authorization id was not refused');

    const stillThere = await proxmox(`/nodes/${NODE}/qemu/${createdVmId}/config`);
    expect(Boolean(stillThere), 'the VM disappeared during a refused purge');
    return { refused: true };
  });

  await check('purge-destroys-when-authorized', async () => {
    const purged = await provider.purgeInstance({
      request: powerMutation(),
      purgeAuthorizationId: randomUUID(),
      retentionDeadline: '2026-12-31T00:00:00.000Z',
    });
    expect(
      purged.result?.state === ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      `purge returned ${purged.result?.state}: ${purged.result?.failure?.code ?? ''}`,
    );
    await pollUntilSettled(purged.result.providerTaskReference, 'purgeInstance');

    const vms = await proxmox(`/nodes/${NODE}/qemu`);
    const remaining = vms.filter((vm) => vm.vmid >= 910_000 && vm.vmid <= 910_099);
    expect(remaining.length === 0, `${remaining.length} VM(s) remain after the purge`);
    // The purge already destroyed it, so the teardown has nothing to do.
    createdVmId = undefined;
    return { destroyed: true };
  });

  await check('diagnostics-carry-no-secret', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const { rows } = await pool.query(
        'SELECT diagnostics FROM terraform.runs WHERE instance_id = $1',
        [instanceId],
      );
      const rendered = JSON.stringify(rows);
      for (const secret of [tokenSecret, credentials.PROXMOX_ROOT_PASSWORD].filter(Boolean)) {
        expect(!rendered.includes(secret), 'a secret reached terraform.runs.diagnostics');
      }
      // The backend connection string carries a password too.
      expect(
        !rendered.includes(stateConnectionString),
        'the state connection string reached diagnostics',
      );
      return { runRows: rows.length };
    } finally {
      await pool.end();
    }
  });

  evidence.status = failures.length === 0 ? 'passed' : 'failed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error instanceof Error ? error.stack : String(error);
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  // --- Teardown ---
  //
  // The VM this run created is destroyed. That is not a compensation path in the forbidden sense:
  // it is a verification fixture, destroyed by the tool that made it, by VMID, after the
  // assertions have run. Nothing else on the server is touched, and `--keep` leaves it for
  // inspection.
  if (createdVmId && !keep) {
    await check('teardown', async () => {
      const workspace = `instance-${instanceId}`;
      const directory = await runner.prepare(
        workspace,
        {
          node_name: NODE,
          template_vm_id: TEMPLATE_VMID,
          vm_id: createdVmId,
          hostname: `tfv-${instanceId.slice(0, 8)}`,
          ownership_marker: `private-cloud-control:${JSON.stringify(ownership)}`,
          tags: ['private-cloud-control-plane', 'lab'],
          datastore_id: STORAGE,
          disk_interface: 'scsi0',
          disk_gib: 32,
          cpu_cores: 2,
          memory_mib: 4096,
          bridge: BRIDGE,
          network_mtu: NETWORK_MTU,
          ipv4_address: '192.168.4.3',
          ipv4_prefix_length: 22,
          ipv4_gateway: '192.168.4.1',
          dns_servers: ['1.1.1.1'],
          dns_domain: 'lab.invalid',
          cloud_init_username: 'ubuntu',
          cloud_init_password: credentials.PROXMOX_ROOT_PASSWORD ?? 'lab-placeholder-password',
          ssh_public_keys: [],
          started: true,
          on_boot: false,
        },
        true,
      );
      await runner.init(directory, workspace);
      const { gate } = await runner.plan(directory, {
        destroy: true,
        allowDestroyOf: 'proxmox_virtual_environment_vm.instance',
      });
      expect(gate.decision === 'allowed', `the destroy plan was refused: ${gate.summary}`);
      const applied = await runner.apply(directory, gate);
      expect(applied.exitCode === 0, `destroy exited ${applied.exitCode}`);

      const vms = await proxmox(`/nodes/${NODE}/qemu`);
      const remaining = vms.filter((vm) => vm.vmid >= 910_000 && vm.vmid <= 910_099);
      expect(remaining.length === 0, `${remaining.length} VM(s) remain in the reserved interval`);
      return { destroyed: createdVmId, totalVms: vms.length };
    });
    // The teardown check discards its own directory; nothing else to clean here.
    await cleanupRows().catch(() => undefined);
  } else if (createdVmId) {
    process.stdout.write(`\n--keep: VM ${createdVmId} left on the server for inspection.\n`);
  }

  await db.destroy().catch(() => undefined);
  await rm(workingRoot, { recursive: true, force: true }).catch(() => undefined);

  evidence.finishedAt = new Date().toISOString();
  evidence.failures = failures;
  evidence.status = failures.length === 0 ? 'passed' : 'failed';
  evidence.instanceId = instanceId;
  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, undefined, 2)}\n`);
}

const names = Object.keys(evidence.checks);
process.stdout.write(`\n${'-'.repeat(84)}\n`);
for (const name of names) {
  const outcome = evidence.checks[name];
  process.stdout.write(
    `${outcome.status === 'passed' ? '✓' : '✗'} ${name.padEnd(44)} ${((outcome.durationMs ?? 0) / 1000).toFixed(1)}s\n`,
  );
}
process.stdout.write(`${'-'.repeat(84)}\n`);
process.stdout.write(
  `${names.length - failures.length}/${names.length} checks passed. Evidence: ${EVIDENCE_PATH}\n`,
);
for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
if (failures.length > 0) process.exitCode = 1;
