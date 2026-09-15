/**
 * Drives **one create request through the whole system**, against real hardware, with the
 * Terraform-backed provider.
 *
 * PATTERN — record every outcome, do not fail fast. Same reason as
 * `tools/verification/verify-terraform-adapter.mjs` and `tools/kubernetes/verify-phase6.mjs`: a
 * run that stops at the first problem hides every later one, and the later ones usually explain
 * the first.
 *
 * Where `verify-terraform-adapter.mjs` exercises the provider half in-process, this tool starts at
 * the REST boundary and asserts every layer the request actually crosses — accept, the
 * transactional commit, the outbox, the Kafka command record, the orchestrator's leased claim, the
 * provider over gRPC, the Terraform run and its plan gate, the VM on the server, and the read
 * projection. Nothing here reaches into a layer's internals to make the next one work.
 *
 * **It creates a real VM** inside the reserved interval and removes it at the end through the
 * control plane's own retention and purge path, never by destroying anything directly.
 *
 * Requires the stack from `deploy/local/compose.terraform.yaml`:
 *
 *   pnpm run terraform:compose-env
 *   docker compose --env-file deploy/local/.env.terraform \
 *     -f deploy/local/compose.phase4.yaml -f deploy/local/compose.terraform.yaml up -d --build
 *   pnpm run verify:terraform-runtime
 *
 * Evidence: docs/verification/evidence/terraform-runtime.json
 *
 * @see terraform-provisioning-checkpoints.md
 * @see docs/architecture/terraform-call-map.md
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

const execFile = promisify(execFileCallback);
const root = new URL('../../', import.meta.url).pathname;

/** Where the machine-readable record is written. */
const EVIDENCE_PATH = resolve('docs/verification/evidence/terraform-runtime.json');

/** The gitignored credentials file, for the read-only Proxmox assertions. */
const CREDENTIALS_PATH = resolve('terraformProxServerTestCredntails.txt');

/** The compose stack this tool asserts against. */
const COMPOSE_PROJECT = 'private-cloud-phase4';
const COMPOSE_FILES = ['deploy/local/compose.phase4.yaml', 'deploy/local/compose.terraform.yaml'];

const DATABASE_URL = 'postgresql://private_cloud:private_cloud@127.0.0.1:55432/private_cloud';
const API_BASE = 'http://127.0.0.1:3100';
const OIDC_BASE = 'http://127.0.0.1:18080';

/** The catalog identifiers seeded by `db/seeds/0002_proxmox_testsrv.sql`. */
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const IMAGE_ID = 'ubuntu-noble-2404';
const FLAVOR_ID = 'lab-small';
const NETWORK_ID = 'testsrv-vmbr1';

/** The command topic the outbox publishes to. */
const COMMAND_TOPIC = 'provisioning.commands.v1';

/**
 * How long a create may take before the outcome is called unknown.
 *
 * A clone plus cloud-init on this server measures around 35 seconds, and the workflow adds the
 * orchestrator's claim and its checkpoints on top. Five minutes is generous on purpose: a timeout
 * that fires early would report a working system as broken.
 */
const CREATE_TIMEOUT_MS = 300_000;

/** How long retention and purge may take. Purge waits for a real destroy. */
const LIFECYCLE_TIMEOUT_MS = 240_000;

const keep = process.argv.includes('--keep');
const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const evidence = {
  startedAt: new Date().toISOString(),
  status: 'running',
  runId,
  stack: COMPOSE_FILES,
  checks: {},
};
const failures = [];

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

/** Runs one named check, recording its outcome rather than aborting the suite. */
async function check(name, body) {
  const startedAt = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const detail = (await body()) ?? {};
    // The verdict is written *after* the detail. A check that returned its own `status` field
    // would otherwise overwrite its verdict, and a reporter that can contradict its own summary
    // is worse than a terse one.
    evidence.checks[name] = { ...detail, status: 'passed', durationMs: Date.now() - startedAt };
    process.stdout.write(`  ✓ ${name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.checks[name] = {
      status: 'failed',
      error: message,
      durationMs: Date.now() - startedAt,
    };
    failures.push(name);
    process.stdout.write(`  ✗ ${name}: ${message}\n`);
    return false;
  }
}

/** Polls until `assertion` returns something truthy, or the deadline passes. */
async function waitFor(description, assertion, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await assertion();
      if (value !== false && value !== undefined && value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((settle) => setTimeout(settle, intervalMs));
  }
  throw new Error(
    `${description} did not hold within ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function query(text, values = []) {
  return (await pool.query(text, values)).rows;
}

/**
 * The generated environment file the overlay interpolates.
 *
 * Parsed rather than sourced. Sourcing it through a shell is not merely unnecessary: an API token
 * containing `$` expands, and the value silently arrives truncated or mangled. This one does.
 */
const ENVIRONMENT_FILE = resolve('deploy/local/.env.terraform');
const overlayEnvironment = Object.fromEntries(
  (
    await readFile(ENVIRONMENT_FILE, 'utf8').catch(() => {
      throw new Error(`${ENVIRONMENT_FILE} is missing. Run pnpm run terraform:compose-env.`);
    })
  )
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

function compose(args) {
  return execFile(
    'docker',
    [
      'compose',
      '-p',
      COMPOSE_PROJECT,
      // Without this every compose call fails interpolation, because the overlay deliberately
      // has no defaults for a real endpoint or a real secret.
      '--env-file',
      ENVIRONMENT_FILE,
      ...COMPOSE_FILES.flatMap((file) => ['-f', file]),
      ...args,
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  ).then((result) => result.stdout.trim());
}

async function jsonRequest(url, options = {}, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method ?? 'GET'} ${url} returned ${response.status}: ${text}`,
  );
  return text ? JSON.parse(text) : null;
}

/** A bearer token from the local OIDC issuer, scoped to the lab project. */
async function bearer(role = 'tenant_developer') {
  const url = new URL(`${OIDC_BASE}/token`);
  url.searchParams.set('roles', role);
  url.searchParams.set('subject', `terraform-${role}`);
  url.searchParams.set('projects', role === 'platform_administrator' ? '' : PROJECT_ID);
  return (await jsonRequest(url)).access_token;
}

const credentials = Object.fromEntries(
  (await readFile(CREDENTIALS_PATH, 'utf8'))
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);

/**
 * One read-only Proxmox API call, retried on transport failure.
 *
 * WHY retry: these are assertions *about* the server, not operations on it, and a dropped packet
 * is not a finding. HTTP status codes are **not** retried — a 403 or a 500 is an answer.
 */
async function proxmox(path, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${credentials.PROXMOX_ENDPOINT}/api2/json${path}`, {
        headers: {
          Authorization: `PVEAPIToken=${credentials.PROXMOX_API_TOKEN_ID}=${credentials.PROXMOX_API_TOKEN_SECRET}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return (await response.json()).data;
    } catch (error) {
      lastError = error;
      const transport = error instanceof Error && !/returned \d{3}/.test(error.message);
      if (!transport || attempt === attempts) throw error;
      await new Promise((settle) => setTimeout(settle, 2_000 * attempt));
    }
  }
  throw lastError;
}

/** Reads the VMIDs currently present inside the reserved interval. */
async function reservedVmids() {
  const [minimum, maximum] = (
    await query(
      'SELECT resource_id_minimum, resource_id_maximum FROM control.provider_profiles WHERE id = $1',
      ['proxmox-testsrv'],
    )
  ).map((row) => [Number(row.resource_id_minimum), Number(row.resource_id_maximum)])[0];
  const machines = await proxmox('/cluster/resources?type=vm');
  return machines
    .map((machine) => Number(machine.vmid))
    .filter((vmid) => vmid >= minimum && vmid <= maximum)
    .sort((left, right) => left - right);
}

/** Consumes a topic from the beginning with a run-unique group, so no service's offsets move. */
async function readRecords(topic, predicate, { minimum = 1, timeoutMs = 45_000 } = {}) {
  const requireFromMessaging = createRequire(`${root}packages/messaging/package.json`);
  const { Kafka, logLevel } = requireFromMessaging('kafkajs');
  const kafka = new Kafka({
    clientId: `terraform-reader-${runId}`,
    brokers: ['127.0.0.1:9092'],
    logLevel: logLevel.NOTHING,
  });
  const consumer = kafka.consumer({ groupId: `terraform-reader-${runId}-${randomUUID()}` });
  const matches = [];
  await consumer.connect();
  try {
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message, partition }) => {
        const headers = Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([key, value]) => [key, value?.toString()]),
        );
        const record = {
          headers,
          partition,
          key: message.key?.toString(),
          value: message.value?.toString(),
        };
        if (predicate(record)) matches.push(record);
      },
    });
    const deadline = Date.now() + timeoutMs;
    while (matches.length < minimum && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 250));
    }
  } finally {
    await consumer.disconnect();
  }
  assert(
    matches.length >= minimum,
    `expected at least ${minimum} record(s) on ${topic}; saw ${matches.length}`,
  );
  return matches;
}

const terminalStates = new Set(['failed', 'manual_review', 'succeeded']);

/**
 * Reads one operation.
 *
 * WHY there are two routes: a platform administrator holds **no project scope** — that is the
 * point of the role — so the tenant route refuses them with `PROJECT_ACCESS_DENIED`. The admin
 * route is not a convenience: it also returns the restricted-operational fields, including the
 * provider task reference, which never appear on a tenant route.
 */
async function operation(operationId, authorization, { administrative = false } = {}) {
  const url = administrative
    ? `${API_BASE}/v1/admin/operations/${operationId}`
    : `${API_BASE}/v1/projects/${PROJECT_ID}/operations/${operationId}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${authorization}` } });
  if (response.status === 404) return null;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

/** Waits for an operation to reach a terminal state, and asserts which one. */
async function waitForOperation(operationId, authorization, expected, timeoutMs, options = {}) {
  const current = await waitFor(
    `operation ${operationId} terminal`,
    async () => {
      const value = await operation(operationId, authorization, options);
      return value && terminalStates.has(value.state) ? value : false;
    },
    timeoutMs,
  );
  assert.equal(
    current.state,
    expected,
    `operation ${operationId} ended ${current.state}: ${JSON.stringify(current)}`,
  );
  return current;
}

/** The fixture this run creates, filled in as the layers are asserted. */
/** Tempo's query API, as published by `compose.phase4.yaml`. */
const TEMPO_BASE = 'http://127.0.0.1:3200';

/**
 * The services whose spans must share the create request's trace.
 *
 * One per process the request actually passes through. `reconciler` is deliberately absent: it
 * runs on its own schedule and is not part of this request's causal chain, so requiring it would
 * make the check flaky for a reason unrelated to propagation.
 */
const REQUIRED_TRACE_SERVICES = ['control-api', 'provisioning-orchestrator', 'proxmox-provider'];

/** How long to allow for spans to be exported, batched and indexed. */
const TRACE_BUDGET_MS = 120_000;

const fixture = {
  hostname: `tf-rt-${runId}`.slice(0, 63),
  idempotencyKey: `terraform-runtime-${runId}`,
  correlationId: randomUUID(),
  // The verifier chooses the trace id and sends it as a `traceparent`, so proving one trace spans
  // every layer is a lookup rather than a search. Searching for "the trace that looks like ours"
  // would pass on any trace with the right span names, including one from an earlier run.
  traceId: randomUUID().replaceAll('-', ''),
  parentSpanId: randomUUID().replaceAll('-', '').slice(0, 16),
  // A structurally complete key, because admission now refuses one that only looks like a key —
  // and rightly: Proxmox answers a malformed key with an HTTP 500, which classifies as retryable.
  // A public key is not a secret; this one is a fixture whose comment makes it traceable to this
  // run, and it is used to prove the key never reaches a log, a span, a metric or a readback.
  sshPublicKey:
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKqQZyPkFmRLBCLiLwCHnUoCQkUxLZ8sKOUVCR+7bgBR ' +
    `terraform-runtime-${runId}@restricted`,
};

process.stdout.write(`Terraform runtime verification ${runId}\n`);

// ---------------------------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------------------------

await check('stack-is-healthy', async () => {
  const services = [
    'control-api',
    'provisioning-orchestrator',
    'proxmox-provider',
    'kafka',
    'debezium-connect',
  ];
  const health = {};
  for (const service of services) {
    const id = await compose(['ps', '-q', service]);
    assert(id, `${service} is not running`);
    health[service] = (
      await execFile('docker', ['inspect', '--format', '{{.State.Health.Status}}', id])
    ).stdout.trim();
  }
  for (const [service, state] of Object.entries(health)) {
    assert.equal(state, 'healthy', `${service} is ${state}`);
  }
  return health;
});

await check('provider-is-the-terraform-adapter', async () => {
  // Read from the running container rather than from the compose file: what matters is what the
  // process was started with, not what the file currently says.
  const id = await compose(['ps', '-q', 'proxmox-provider']);
  const raw = (
    await execFile('docker', ['inspect', '--format', '{{json .Config.Env}}', id])
  ).stdout.trim();
  const environment = Object.fromEntries(
    JSON.parse(raw).map((entry) => [
      entry.slice(0, entry.indexOf('=')),
      entry.slice(entry.indexOf('=') + 1),
    ]),
  );
  assert.equal(environment.PROVIDER_ADAPTER, 'terraform');
  assert.equal(environment.PROXMOX_PROVIDER_PROFILE_ID, 'proxmox-testsrv');
  const version = await compose(['exec', '-T', 'proxmox-provider', 'terraform', 'version']);
  assert.match(version, /^Terraform v\d+\.\d+\.\d+/);
  return {
    adapter: environment.PROVIDER_ADAPTER,
    profile: environment.PROXMOX_PROVIDER_PROFILE_ID,
    node: environment.PROXMOX_NODE,
    terraform: version.split('\n')[0],
    // The plugin directory is what makes the container's Terraform unable to reach a registry.
    pluginDirectory: environment.TERRAFORM_PLUGIN_DIR,
  };
});

await check('reserved-range-is-clear', async () => {
  const present = await reservedVmids();
  assert.deepEqual(present, [], `reserved interval already holds ${present.join(', ')}`);
  const visible = await proxmox('/cluster/resources?type=vm');
  // Named for what it is. The scoped token holds per-VMID grants, so this is what *this token*
  // can see — the reserved interval plus the clone template — and not the server's population.
  // Recording it as a total would have been a quietly false claim about a shared machine.
  return {
    reservedVmidsPresent: present.length,
    virtualMachinesVisibleToThisToken: visible.length,
  };
});

await check('failed-fixtures-from-earlier-runs-cleared', async () => {
  // A failed create still holds an instance row, an IPv4 lease and a slice of the project's
  // quota — correctly, because the quota counts committed intent rather than built hardware. The
  // lab quota is deliberately three instances (SAFE-030), so three failed runs exhaust it and the
  // next run is refused at acceptance with `QUOTA_EXCEEDED` before it can test anything.
  //
  // **The guard is the reserved interval, not the row.** This deletes only instances that are
  // terminally failed, in the lab project, and have no Terraform workspace — and only after the
  // preceding check proved that no VM exists in the interval at all. If a VM were there, a row
  // might be the only record tying this system to it, and deleting the row would orphan it. A
  // cleanup that cannot prove that is a cleanup that can lose a machine.
  const present = await reservedVmids();
  assert.deepEqual(present, [], 'refusing to clear rows while VMs exist in the reserved interval');

  // Addresses first, and this is the subtler half. A quarantined lease counts as taken on
  // purpose — it is held back after a failed release because a VM might still be using it — so
  // three finished runs exhaust an IPv4 quota of three even when every instance row is terminal.
  // The empty interval is what makes releasing them sound: every instance in this project can
  // only ever have had a VM inside it, so if the interval is empty, no address is in use.
  const released = await query(
    `UPDATE control.ipv4_leases SET state = 'released', updated_at = now()
      WHERE project_id = $1 AND state <> 'released'
        AND instance_id IN (
          SELECT id FROM control.instances
            WHERE project_id = $1 AND lifecycle_state IN ('failed', 'manual_review', 'purged'))
      RETURNING address`,
    [PROJECT_ID],
  );

  // Then the rows that hold an instance slot. `purged` rows are deliberately left alone: they are
  // the record that an instance was destroyed, and the quota already excludes them.
  //
  // This deliberately does **not** skip instances that have a Terraform workspace row. An earlier
  // version did, reasoning that a workspace meant Terraform still tracked the instance — but a
  // workspace row records that Terraform *once* tracked it, and every failed run leaves one. With
  // the interval proven empty the row describes state for a VM that no longer exists, so it is
  // removed with the instance rather than used as a reason to keep it.
  const stale = await query(
    `SELECT i.id, i.hostname FROM control.instances i
      WHERE i.project_id = $1
        AND i.lifecycle_state IN ('failed', 'manual_review')`,
    [PROJECT_ID],
  );
  for (const instance of stale) {
    // Order matters: every child row first, then the instance. Nothing here cascades, on purpose.
    // The workspace row first: it is the foreign key into `control.instances`. The state document
    // itself lives in `terraform_remote_state`, which this role may only read — an orphaned state
    // row for a destroyed VM is inert, and reaching into the backend's own storage to tidy it
    // would be reaching past the boundary the migration drew on purpose.
    await query('DELETE FROM terraform.workspaces WHERE instance_id = $1', [instance.id]);
    await query('DELETE FROM terraform.runs WHERE instance_id = $1', [instance.id]);
    await query('DELETE FROM control.ipv4_leases WHERE instance_id = $1', [instance.id]);
    await query('DELETE FROM control.snapshots WHERE instance_id = $1', [instance.id]);
    await query('DELETE FROM control.manual_reviews WHERE instance_id = $1', [instance.id]);
    await query('DELETE FROM workflow.workflows WHERE instance_id = $1', [instance.id]);
    // The idempotency record points at the operation, so it goes first. Keeping it would also
    // make the next run's fresh key look like a replay of an operation that no longer exists.
    await query(
      `DELETE FROM control.idempotency_records
        WHERE operation_id IN (SELECT id FROM control.operations WHERE target_id = $1)`,
      [instance.id],
    );
    await query('DELETE FROM control.operations WHERE target_id = $1', [instance.id]);
    await query('DELETE FROM control.instances WHERE id = $1', [instance.id]);
  }

  // Headroom is what the run actually needs, so assert it rather than assuming the delete was
  // enough: a quota consumed by *live* instances is a real condition an operator must resolve.
  const [quota] = await query(
    'SELECT instances, ipv4_addresses FROM control.quotas WHERE project_id = $1',
    [PROJECT_ID],
  );
  const [{ used }] = await query(
    `SELECT count(*)::int AS used FROM control.instances
      WHERE project_id = $1 AND lifecycle_state <> 'purged'`,
    [PROJECT_ID],
  );
  assert(
    used < Number(quota.instances),
    `the lab project has no quota headroom: ${used} of ${quota.instances} instances are live`,
  );
  // The address quota is a separate limit from the instance quota, and exhausting either refuses
  // the create. Assert both rather than inferring one from the other.
  const [{ heldAddresses }] = await query(
    `SELECT count(*)::int AS "heldAddresses" FROM control.ipv4_leases
      WHERE project_id = $1 AND state IN ('active', 'quarantined')`,
    [PROJECT_ID],
  );
  assert(
    heldAddresses < Number(quota.ipv4_addresses),
    `the lab project has no address headroom: ${heldAddresses} of ${quota.ipv4_addresses} held`,
  );
  return {
    clearedInstances: stale.map((instance) => instance.hostname),
    releasedAddresses: released.map((lease) => lease.address),
    quotaInstances: Number(quota.instances),
    instancesLive: used,
    quotaAddresses: Number(quota.ipv4_addresses),
    addressesHeld: heldAddresses,
  };
});

await check('catalog-and-provider-configuration-agree', async () => {
  // The same settings the provider container was started with, against the same database, so a
  // disagreement is caught here rather than minutes into a workflow as an opaque protocol error.
  await execFile('node', ['tools/proxmox/check-config.mjs'], {
    cwd: root,
    env: { ...process.env, ...overlayEnvironment, DATABASE_URL },
    maxBuffer: 8 * 1024 * 1024,
  });
  return { comparisons: 'pnpm run proxmox:check-config passed against the compose database' };
});

// ---------------------------------------------------------------------------------------------
// The request, layer by layer
// ---------------------------------------------------------------------------------------------

const developer = await bearer();
const administrator = await bearer('platform_administrator');

await check('rest-accepts-the-create', async () => {
  const response = await jsonRequest(
    `${API_BASE}/v1/projects/${PROJECT_ID}/instances`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${developer}`,
        'content-type': 'application/json',
        'idempotency-key': fixture.idempotencyKey,
        'x-correlation-id': fixture.correlationId,
        // Sampled (`-01`), because an unsampled parent means the whole trace is dropped and the
        // assertion below would fail for a reason that has nothing to do with propagation.
        traceparent: `00-${fixture.traceId}-${fixture.parentSpanId}-01`,
      },
      body: JSON.stringify({
        imageId: IMAGE_ID,
        flavorId: FLAVOR_ID,
        networkId: NETWORK_ID,
        hostname: fixture.hostname,
        sshPublicKeys: [fixture.sshPublicKey],
      }),
    },
    202,
  );
  assert(response.operationId, 'no operationId');
  assert(response.targetId, 'no targetId');
  assert(response.statusUrl, 'no statusUrl');
  fixture.operationId = response.operationId;
  fixture.instanceId = response.targetId;
  return { ...response };
});

await check('the-same-key-replays', async () => {
  const replay = await jsonRequest(
    `${API_BASE}/v1/projects/${PROJECT_ID}/instances`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${developer}`,
        'content-type': 'application/json',
        'idempotency-key': fixture.idempotencyKey,
        'x-correlation-id': randomUUID(),
      },
      body: JSON.stringify({
        imageId: IMAGE_ID,
        flavorId: FLAVOR_ID,
        networkId: NETWORK_ID,
        hostname: fixture.hostname,
        sshPublicKeys: [fixture.sshPublicKey],
      }),
    },
    202,
  );
  assert.equal(replay.operationId, fixture.operationId, 'replay produced a second operation');
  assert.equal(replay.targetId, fixture.instanceId, 'replay produced a second instance');
  const [{ count }] = await query(
    'SELECT count(*)::int AS count FROM control.instances WHERE project_id = $1 AND hostname = $2',
    [PROJECT_ID, fixture.hostname],
  );
  assert.equal(count, 1, `replay created ${count} instances`);
  return { replayed: replay.replayed ?? true, instancesWithThisHostname: count };
});

await check('one-transaction-committed-instance-operation-lease-and-audit', async () => {
  const [instance] = await query('SELECT * FROM control.instances WHERE id = $1', [
    fixture.instanceId,
  ]);
  assert(instance, 'no instance row');
  const [operationRow] = await query('SELECT * FROM control.operations WHERE id = $1', [
    fixture.operationId,
  ]);
  assert(operationRow, 'no operation row');
  const [lease] = await query(
    "SELECT * FROM control.ipv4_leases WHERE instance_id = $1 AND state = 'active'",
    [fixture.instanceId],
  );
  assert(lease, 'no active IPv4 lease');
  const audits = await query(
    'SELECT action, outcome, actor_role FROM audit.entries WHERE target_id = $1 ORDER BY occurred_at',
    [fixture.instanceId],
  );
  assert(audits.length >= 1, 'no audit entry');

  // The rows must carry the same commit timestamp. The point of the design is that intent is
  // durable as one unit, and a lease committed separately is a lease that can outlive its
  // instance.
  assert.equal(
    instance.created_at.getTime(),
    lease.created_at.getTime(),
    'the instance and its lease were committed at different times',
  );
  assert.equal(lease.network_id, NETWORK_ID);
  assert.equal(lease.gateway, '192.168.4.1');
  return {
    lifecycleState: instance.lifecycle_state,
    operationState: operationRow.state,
    address: lease.address,
    prefixLength: lease.prefix_length,
    networkId: lease.network_id,
    auditEntries: audits.map((entry) => `${entry.action}:${entry.outcome}`),
  };
});

await check('outbox-published-one-command', async () => {
  const rows = await query(
    'SELECT event_id, topic, partition_key FROM control.outbox WHERE aggregate_id = $1 ORDER BY created_at',
    [fixture.instanceId],
  );
  assert(rows.length >= 1, 'no outbox row');
  const command = rows.find((row) => row.topic === COMMAND_TOPIC);
  assert(command, `no row on ${COMMAND_TOPIC}; saw ${rows.map((row) => row.topic).join(', ')}`);
  assert.equal(command.partition_key, fixture.instanceId, 'partition key is not the instance id');
  fixture.commandEventId = command.event_id;
  return { rows: rows.length, topic: command.topic, partitionKey: command.partition_key };
});

await check('kafka-carried-the-command', async () => {
  const records = await readRecords(COMMAND_TOPIC, (record) =>
    record.value?.includes(fixture.instanceId),
  );
  const record = records[0];
  assert.equal(record.key, fixture.instanceId, 'record key is not the instance id');
  const payload = JSON.parse(record.value);
  // The command carries the SSH *public* key on purpose: it is intent, and the provider cannot
  // configure the instance without it. What must never ride along is a credential — the API
  // token or the cloud-init password, neither of which the control plane even knows.
  assert(
    !record.value.includes(credentials.PROXMOX_API_TOKEN_SECRET),
    'the command record carried the API token',
  );
  assert(
    !record.value.includes(credentials.PROXMOX_ROOT_PASSWORD),
    'the command record carried the cloud-init password',
  );
  return {
    records: records.length,
    key: record.key,
    partition: record.partition,
    headers: Object.keys(record.headers).sort(),
    payloadKeys: Object.keys(payload).sort(),
  };
});

await check('orchestrator-claimed-with-a-lease-and-a-fencing-token', async () => {
  const workflow = await waitFor(
    'workflow claimed',
    async () => {
      const [row] = await query('SELECT * FROM workflow.workflows WHERE instance_id = $1', [
        fixture.instanceId,
      ]);
      return row && row.fencing_token != null ? row : false;
    },
    120_000,
  );
  assert(Number(workflow.fencing_token) >= 1, 'fencing token is not positive');
  const [lease] = await query('SELECT * FROM workflow.instance_leases WHERE instance_id = $1', [
    fixture.instanceId,
  ]);
  assert(lease, 'the workflow was claimed without an instance lease');
  assert(lease.owner_id, 'the lease records no owner');
  // The lease and the workflow must agree on the token. A workflow holding a token the lease does
  // not is a workflow that could still act after being fenced out.
  assert.equal(
    Number(lease.fencing_token),
    Number(workflow.fencing_token),
    'the lease and the workflow disagree on the fencing token',
  );

  // The receipt is keyed by the event, which is what makes a redelivery recognisable as one.
  const receipts = await query(
    'SELECT consumer_name, source_topic FROM workflow.command_receipts WHERE event_id = $1',
    [fixture.commandEventId],
  );
  assert(receipts.length >= 1, 'no command receipt — the command was not recorded as consumed');
  assert.equal(receipts[0].source_topic, COMMAND_TOPIC);
  return {
    leaseOwner: lease.owner_id,
    fencingToken: Number(workflow.fencing_token),
    stage: workflow.stage,
    status: workflow.status,
    commandReceipts: receipts.map((receipt) => receipt.consumer_name),
  };
});

await check('task-reference-was-persisted-before-polling', async () => {
  // SAFE-014. The provider's task reference must be durable before anything waits on it, or a
  // worker restart cannot tell "submitted" from "never submitted" and may submit again.
  const workflow = await waitFor(
    'provider task reference recorded',
    async () => {
      const [row] = await query(
        'SELECT provider_task_reference, stage FROM workflow.workflows WHERE instance_id = $1',
        [fixture.instanceId],
      );
      return row?.provider_task_reference ? row : false;
    },
    CREATE_TIMEOUT_MS,
  );
  const runs = await query(
    'SELECT run_id, command, status, started_at FROM terraform.runs WHERE instance_id = $1 ORDER BY started_at',
    [fixture.instanceId],
  );
  assert(runs.length >= 1, 'no terraform run row');
  // The reference the workflow persisted must be a run this system can actually find again.
  const referenced = runs.find((run) => run.run_id === workflow.provider_task_reference);
  assert(
    referenced,
    `the persisted reference ${workflow.provider_task_reference} matches no run row`,
  );
  return {
    reference: workflow.provider_task_reference,
    runs: runs.length,
    firstCommand: runs[0].command,
  };
});

await check('operation-reaches-succeeded', async () => {
  const current = await waitForOperation(
    fixture.operationId,
    developer,
    'succeeded',
    CREATE_TIMEOUT_MS,
  );
  return { state: current.state, stage: current.stage ?? null };
});

await check('every-terraform-run-was-gated', async () => {
  const runs = await query(
    `SELECT command, status, gate_decision, gate_rule, plan_actions, exit_code
       FROM terraform.runs WHERE instance_id = $1 ORDER BY started_at`,
    [fixture.instanceId],
  );
  assert(runs.length >= 1, 'no runs');
  for (const run of runs) {
    assert.notEqual(
      run.gate_decision,
      'refused_destructive',
      `a run was refused: ${run.gate_rule}`,
    );
    const actions = run.plan_actions ?? {};
    assert.equal(
      Number(actions.delete ?? 0),
      0,
      `a plan contained a delete: ${JSON.stringify(actions)}`,
    );
  }
  const apply = runs.find((run) => run.command === 'apply');
  assert(apply, 'no apply run');
  assert.equal(apply.status, 'succeeded', `apply ended ${apply.status}`);
  assert.equal(
    Number((apply.plan_actions ?? {}).create ?? 0),
    1,
    'the apply did not plan one create',
  );
  return {
    runs: runs.map((run) => ({
      command: run.command,
      status: run.status,
      gate: run.gate_decision,
      actions: run.plan_actions,
    })),
  };
});

await check('proxmox-holds-the-expected-vm', async () => {
  const present = await reservedVmids();
  assert.equal(
    present.length,
    1,
    `expected one VM in the reserved interval, saw ${present.length}`,
  );
  const [vmid] = present;
  fixture.vmid = vmid;
  const node = (await proxmox('/cluster/resources?type=vm')).find(
    (machine) => Number(machine.vmid) === vmid,
  ).node;
  fixture.node = node;
  const config = await proxmox(`/nodes/${node}/qemu/${vmid}/config`);
  const [flavor] = await query(
    'SELECT cpu_count, memory_mib, minimum_disk_gib FROM control.flavors WHERE id = $1',
    [FLAVOR_ID],
  );
  assert.equal(Number(config.cores), Number(flavor.cpu_count), 'cores do not match the flavour');
  assert.equal(
    Number(config.memory),
    Number(flavor.memory_mib),
    'memory does not match the flavour',
  );
  assert.match(config.net0 ?? '', /bridge=vmbr1/, 'not on the expected bridge');
  assert.match(config.net0 ?? '', /mtu=1400/, 'MTU was not declared');
  assert.match(config.scsi0 ?? '', new RegExp(`size=${flavor.minimum_disk_gib}G`), 'disk size');

  // The address the control plane leased must be the address cloud-init was told to use. This is
  // the one assertion that spans the whole system: a lease that does not reach the guest is a
  // lease that means nothing.
  const [lease] = await query(
    "SELECT address FROM control.ipv4_leases WHERE instance_id = $1 AND state = 'active'",
    [fixture.instanceId],
  );
  assert(
    (config.ipconfig0 ?? '').includes(`ip=${lease.address}/`),
    `ipconfig0 is ${config.ipconfig0}, which does not carry the leased ${lease.address}`,
  );
  assert.match(config.ipconfig0 ?? '', /gw=192\.168\.4\.1/, 'gateway');
  assert.equal(config.nameserver, '1.1.1.1', 'nameserver');
  return {
    vmid,
    node,
    cores: config.cores,
    memoryMib: config.memory,
    net0: config.net0,
    ipconfig0: config.ipconfig0,
    nameserver: config.nameserver,
    leasedAddress: lease.address,
  };
});

await check('ownership-marker-identifies-this-instance', async () => {
  const config = await proxmox(`/nodes/${fixture.node}/qemu/${fixture.vmid}/config`);
  const description = config.description ?? '';
  const first = description.split('\n')[0];
  assert(
    first.startsWith('private-cloud-control:'),
    `the marker is not the first line: ${description.slice(0, 120)}`,
  );
  const markers = JSON.parse(first.slice('private-cloud-control:'.length));
  assert.equal(markers.instanceId, fixture.instanceId, 'the marker names a different instance');
  assert.equal(markers.projectId, PROJECT_ID);
  assert(markers.managedBy, 'no managedBy');
  // The description is operator-visible text on somebody else's server. It must carry identity,
  // never a secret.
  assert(!description.includes(fixture.sshPublicKey), 'the description carried the SSH key');
  return {
    managedBy: markers.managedBy,
    environment: markers.environment ?? null,
    markerKeys: Object.keys(markers).sort(),
  };
});

await check('projection-reads-back-what-was-built', async () => {
  const instance = await waitFor(
    'projection reports active',
    async () => {
      const value = await jsonRequest(
        `${API_BASE}/v1/projects/${PROJECT_ID}/instances/${fixture.instanceId}`,
        { headers: { authorization: `Bearer ${developer}` } },
      );
      return value?.lifecycleState === 'active' ? value : false;
    },
    120_000,
  );
  assert.equal(instance.id, fixture.instanceId);
  assert.equal(instance.desired.hostname, fixture.hostname);
  assert.equal(instance.desired.powerState, 'running');

  // The observation is the part that matters: it is the system reporting what it *saw*, not what
  // it intended. `markerMatch` is the claim that the VM it observed is the one it created.
  assert.equal(instance.observed.exists, true, 'the readback reports the instance absent');
  assert.equal(instance.observed.markerMatch, true, 'ownership was not proven by observation');
  assert.equal(instance.observed.powerState, 'running');
  assert.equal(Number(instance.observed.cpuCount), 2);
  assert.equal(Number(instance.observed.diskGiB), 32);
  assert.equal(instance.drift, 'none', `drift reported as ${instance.drift}`);

  const [lease] = await query(
    "SELECT address FROM control.ipv4_leases WHERE instance_id = $1 AND state = 'active'",
    [fixture.instanceId],
  );
  assert.equal(instance.ipv4Lease.address, lease.address);

  // There is deliberately **no provider resource id here**. The VMID is restricted-operational,
  // it is not part of the tenant read model, and asserting it on this route would be asking the
  // system to leak an internal identifier. The next check reads it where it belongs.
  assert(
    !('providerResourceId' in instance),
    'the tenant readback exposed the provider resource id',
  );
  const body = JSON.stringify(instance);
  assert(!body.includes(fixture.sshPublicKey), 'the readback carried the SSH key');
  assert(
    !body.includes(credentials.PROXMOX_ROOT_PASSWORD),
    'the readback carried the cloud-init password',
  );
  return {
    lifecycleState: instance.lifecycleState,
    hostname: instance.desired.hostname,
    observed: instance.observed,
    drift: instance.drift,
    ipv4Address: instance.ipv4Lease.address,
  };
});

await check('the-administrative-route-carries-the-provider-resource', async () => {
  // The restricted-operational view, and the only place the VMID is exposed. This is what closes
  // the loop: the id the administrator can see must be the VM the server actually holds.
  const operationView = await operation(fixture.operationId, administrator, {
    administrative: true,
  });
  assert(operationView, 'the administrative route could not find the create operation');
  assert.equal(
    String(operationView.providerResourceId ?? ''),
    String(fixture.vmid),
    `the administrative view reports ${operationView.providerResourceId}, the server holds ${fixture.vmid}`,
  );
  assert(
    operationView.providerTaskReference,
    'no provider task reference on the administrative view',
  );
  return {
    providerResourceId: operationView.providerResourceId,
    providerTaskReference: operationView.providerTaskReference,
  };
});

await check('inventory-records-the-workspace-in-sync', async () => {
  const [workspace] = await query(
    'SELECT workspace_name, drift_state, state_serial, last_applied_at FROM terraform.workspaces WHERE instance_id = $1',
    [fixture.instanceId],
  );
  assert(workspace, 'no workspace row');
  assert.equal(workspace.workspace_name, `instance-${fixture.instanceId}`);
  assert.equal(workspace.drift_state, 'in_sync');
  assert(workspace.last_applied_at, 'no apply timestamp');
  assert(Number(workspace.state_serial) >= 1, 'state serial was not recorded');
  return {
    workspace: workspace.workspace_name,
    driftState: workspace.drift_state,
    stateSerial: Number(workspace.state_serial),
  };
});

// ---------------------------------------------------------------------------------------------
// Removal, through the control plane's own path
// ---------------------------------------------------------------------------------------------

if (!keep) {
  await check('retention-detaches-through-the-api', async () => {
    const response = await jsonRequest(
      `${API_BASE}/v1/projects/${PROJECT_ID}/instances/${fixture.instanceId}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${developer}`,
          'idempotency-key': `${fixture.idempotencyKey}-delete`,
          'x-correlation-id': randomUUID(),
        },
      },
      202,
    );
    await waitForOperation(response.operationId, developer, 'succeeded', LIFECYCLE_TIMEOUT_MS);
    // A soft delete must leave the VM and its disk in place: SAFE-028. The row is marked, the
    // hardware is not touched.
    const present = await reservedVmids();
    assert.deepEqual(present, [fixture.vmid], 'the soft delete removed the VM');
    const config = await proxmox(`/nodes/${fixture.node}/qemu/${fixture.vmid}/config`);
    assert.match(config.description ?? '', /retained-until=/, 'no retention trailer');
    // The marker must still be the first line and still parse. This is the bug that made purge
    // unreachable before T-5: an appended trailer that broke the marker meant live ownership
    // could never be proven again, and SAFE-006 refuses a purge without it.
    const first = (config.description ?? '').split('\n')[0];
    const markers = JSON.parse(first.slice('private-cloud-control:'.length));
    assert.equal(markers.instanceId, fixture.instanceId);
    const [instance] = await query(
      'SELECT lifecycle_state, retention_deadline FROM control.instances WHERE id = $1',
      [fixture.instanceId],
    );
    assert.equal(instance.lifecycle_state, 'retained');
    assert(instance.retention_deadline, 'no retention deadline was stamped');
    return {
      operationId: response.operationId,
      vmStillPresent: true,
      lifecycleState: instance.lifecycle_state,
      markerStillParses: true,
      onBoot: config.onboot ?? 0,
    };
  });

  await check('retention-deadline-advanced-to-simulate-the-wait', async () => {
    // The purge guard requires the retention deadline to have passed, and the shortest window the
    // schema permits is one hour (`retention_hours >= 1`). No configuration makes a purge
    // reachable inside a single run, so the deadline the application stamped is moved into the
    // past — which is precisely what waiting would do.
    //
    // WHY this and not `purge_eligible`: that flag would switch the guard *off*. Moving the
    // deadline advances the clock and leaves every check running for real — the confirmation must
    // still match, the instance must still be retained, the deadline must still be compared, and
    // the workflow must still prove live provider ownership before it destroys anything. This is
    // recorded as a deviation in the checkpoint ledger rather than hidden.
    const [before] = await query('SELECT retention_deadline FROM control.instances WHERE id = $1', [
      fixture.instanceId,
    ]);
    assert(before.retention_deadline, 'nothing to advance: no deadline was stamped');
    await query(
      "UPDATE control.instances SET retention_deadline = now() - interval '1 minute' WHERE id = $1",
      [fixture.instanceId],
    );
    return {
      stampedDeadline: before.retention_deadline.toISOString(),
      advancedBy: 'set to one minute ago',
      guardsStillEnforced: ['confirmation matches', 'instance is retained', 'live ownership'],
    };
  });

  await check('purge-destroys-only-when-authorized', async () => {
    // The confirmation must be the instance's own id. A purge that could be authorized without
    // naming its target is a purge that can be triggered by a copied command line.
    await jsonRequest(
      `${API_BASE}/v1/admin/instances/${fixture.instanceId}/purges`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${administrator}`,
          'content-type': 'application/json',
          'idempotency-key': `${fixture.idempotencyKey}-purge-wrong`,
          'x-correlation-id': randomUUID(),
        },
        body: JSON.stringify({
          reason: 'verification: deliberately wrong confirmation',
          confirmInstanceId: randomUUID(),
        }),
      },
      // A mismatched confirmation must be refused at acceptance, before any provider call.
      // 422 rather than 400: the request is well-formed, and it is the *semantics* that fail.
      422,
    );
    const stillThere = await reservedVmids();
    assert.deepEqual(stillThere, [fixture.vmid], 'the refused purge touched the VM');

    const response = await jsonRequest(
      `${API_BASE}/v1/admin/instances/${fixture.instanceId}/purges`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${administrator}`,
          'content-type': 'application/json',
          'idempotency-key': `${fixture.idempotencyKey}-purge`,
          'x-correlation-id': randomUUID(),
        },
        body: JSON.stringify({
          reason: 'verification teardown',
          confirmInstanceId: fixture.instanceId,
        }),
      },
      202,
    );
    await waitForOperation(response.operationId, administrator, 'succeeded', LIFECYCLE_TIMEOUT_MS, {
      administrative: true,
    });
    const present = await reservedVmids();
    assert.deepEqual(present, [], `purge left ${present.join(', ')} behind`);
    // The workspace must be gone too: a state row for a destroyed VM is state that describes
    // nothing, and a later run finding it would plan a create it was never asked for.
    const workspaces = await query(
      'SELECT drift_state FROM terraform.workspaces WHERE instance_id = $1',
      [fixture.instanceId],
    );
    assert(
      workspaces.length === 0 || workspaces[0].drift_state === 'absent',
      `the workspace still reports ${workspaces[0]?.drift_state}`,
    );
    return {
      operationId: response.operationId,
      reservedVmidsPresent: 0,
      wrongConfirmationRefused: true,
      workspaceDriftState: workspaces[0]?.drift_state ?? 'row removed',
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Redaction, across every surface this run touched
// ---------------------------------------------------------------------------------------------

await check('one-trace-spans-every-layer', async () => {
  // The last row of T-9's table. Everything above proves each layer did its job; this proves an
  // operator can *see* that as one causal story rather than four disconnected ones.
  //
  // WHY it earns a check of its own: the layers are joined by three different mechanisms — an
  // HTTP header, a Kafka record's headers, and a gRPC metadata entry — and each is a separate
  // opportunity to drop the context. A trace that stops at the Kafka boundary looks perfectly
  // healthy in isolation; it is only the absence of the orchestrator's spans under the same trace
  // id that reveals the break, which is exactly what this asserts.
  const deadline = Date.now() + TRACE_BUDGET_MS;
  let trace;
  let services = new Set();
  while (Date.now() < deadline) {
    const response = await fetch(`${TEMPO_BASE}/api/traces/${fixture.traceId}`).catch(
      () => undefined,
    );
    if (response?.status === 200) {
      trace = await response.json();
      services = new Set(
        (trace.batches ?? []).map(
          (batch) =>
            (batch.resource?.attributes ?? []).find((attribute) => attribute.key === 'service.name')
              ?.value?.stringValue,
        ),
      );
      if (REQUIRED_TRACE_SERVICES.every((service) => services.has(service))) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  assert(trace !== undefined, `Tempo has no trace ${fixture.traceId}`);
  const missing = REQUIRED_TRACE_SERVICES.filter((service) => !services.has(service));
  assert.deepEqual(
    missing,
    [],
    `the trace stops before ${missing.join(', ')} — context was dropped at that boundary`,
  );

  const allSpans = (trace.batches ?? []).flatMap((batch) =>
    (batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
  assert(allSpans.length > 0, 'the trace carries no spans');
  // Every span must belong to the trace the verifier started. A span under a different trace id
  // in the same response would mean Tempo matched something else.
  const foreign = allSpans.filter((span) => span.traceId && span.traceId !== fixture.traceId);
  assert.deepEqual(foreign, [], 'the response carries spans from another trace');

  return {
    traceId: fixture.traceId,
    services: [...services].filter(Boolean).sort(),
    spanCount: allSpans.length,
  };
});

await check('no-secret-reached-any-observable-surface', async () => {
  // Two kinds of value, and they are not scanned for the same things.
  //
  // A *credential* — the API token, the cloud-init password — may appear nowhere at all. The SSH
  // *public* key is tenant intent: the command and the outbox carry it because the provider
  // cannot configure an instance without it, so those two surfaces are scanned for credentials
  // only. Everywhere else it must still be absent: a public key in a log line is a tenant
  // identifier in an operational surface, and it is the fixture that proves redaction works.
  const credentialValues = [
    credentials.PROXMOX_API_TOKEN_SECRET,
    credentials.PROXMOX_ROOT_PASSWORD,
  ].filter((secret) => secret && secret.length >= 8);
  assert(
    credentialValues.length === 2,
    'no credentials to scan for — the credentials file changed shape',
  );
  const intentBearing = new Set(['control.outbox']);

  const surfaces = {};
  // Container logs for every service that could have handled the value.
  for (const service of [
    'control-api',
    'provisioning-orchestrator',
    'proxmox-provider',
    'reconciler',
  ]) {
    surfaces[`logs:${service}`] = await compose([
      'logs',
      '--no-color',
      '--tail',
      '4000',
      service,
    ]).catch(() => '');
  }
  // Terraform diagnostics, which is where a provider error would carry a rendered variable.
  surfaces['terraform.runs.diagnostics'] = JSON.stringify(
    await query('SELECT diagnostics FROM terraform.runs WHERE instance_id = $1', [
      fixture.instanceId,
    ]),
  );
  // Events and audit, which are the durable record other systems read.
  surfaces['control.outbox'] = JSON.stringify(
    await query('SELECT payload FROM control.outbox WHERE aggregate_id = $1', [fixture.instanceId]),
  );
  surfaces['audit.entries'] = JSON.stringify(
    await query('SELECT * FROM audit.entries WHERE target_id = $1', [fixture.instanceId]),
  );

  const found = [];
  for (const [surface, contents] of Object.entries(surfaces)) {
    for (const secret of credentialValues) {
      if (contents.includes(secret)) found.push(`${surface} (credential)`);
    }
    if (!intentBearing.has(surface) && contents.includes(fixture.sshPublicKey)) {
      found.push(`${surface} (ssh public key)`);
    }
  }
  assert.deepEqual(found, [], `values appeared in: ${[...new Set(found)].join(', ')}`);
  return {
    surfacesScanned: Object.keys(surfaces),
    credentialsScannedFor: credentialValues.length,
    surfacesAllowedToCarryTheSshKey: [...intentBearing],
  };
});

// ---------------------------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------------------------

evidence.finishedAt = new Date().toISOString();
evidence.status = failures.length === 0 ? 'passed' : 'failed';
evidence.failures = failures;
// The instance and operation identifiers are recorded; the hostname and the VMID are lab values.
// Nothing derived from a credential is written here, and the file is committed.
evidence.fixture = {
  instanceId: fixture.instanceId,
  operationId: fixture.operationId,
  hostname: fixture.hostname,
  vmid: fixture.vmid ?? null,
  node: fixture.node ?? null,
};
await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

const names = Object.keys(evidence.checks);
process.stdout.write(`\n${'-'.repeat(84)}\n`);
for (const name of names) {
  const { status, durationMs } = evidence.checks[name];
  process.stdout.write(
    `${status === 'passed' ? '✓' : '✗'} ${name.padEnd(52)} ${(durationMs / 1000).toFixed(1)}s\n`,
  );
}
process.stdout.write(`${'-'.repeat(84)}\n`);
process.stdout.write(
  `${names.length - failures.length}/${names.length} checks passed. Evidence: ${EVIDENCE_PATH}\n`,
);

await pool.end();
process.exitCode = failures.length === 0 ? 0 : 1;
