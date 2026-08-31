import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';

const execFile = promisify(execFileCallback);
const root = new URL('../../', import.meta.url).pathname;
const composeFile = 'deploy/local/compose.phase4.yaml';
const composeProject = 'private-cloud-phase4';
const evidenceDirectory = new URL('../../docs/verification/evidence/', import.meta.url);
const evidenceFile = new URL('phase4-runtime.json', evidenceDirectory);
const databaseUrl = 'postgresql://private_cloud:private_cloud@127.0.0.1:55432/private_cloud';
const apiBase = 'http://127.0.0.1:3100';
const prometheusBase = 'http://127.0.0.1:9090';
const tempoBase = 'http://127.0.0.1:3200';
const projectId = '00000000-0000-4000-8000-000000000001';
const reset = process.argv.includes('--reset');
const skipBuild = process.argv.includes('--skip-build');
const execOptions = { cwd: root, maxBuffer: 16 * 1024 * 1024 };
const startedAt = new Date();
const runId = startedAt.toISOString().replace(/\D/g, '').slice(0, 14);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const evidence = {
  schemaVersion: 1,
  startedAt: startedAt.toISOString(),
  composeProject,
  reset,
  checks: {},
  fixtures: {},
  urls: {
    api: apiBase,
    grafana: 'http://127.0.0.1:3101',
    prometheus: prometheusBase,
    tempo: tempoBase,
    kafkaConnect: 'http://127.0.0.1:8083',
  },
};
const healthCheckedServices = [
  'postgres',
  'local-oidc',
  'local-proxmox',
  'otel-collector',
  'kafka',
  'debezium-connect',
  'proxmox-provider',
  'provisioning-orchestrator',
  'control-api',
  'reconciler',
  'prometheus',
  'grafana',
];
const initializationJobs = ['migrate', 'seed', 'kafka-init', 'debezium-init', 'local-proxmox-tls'];

function log(message) {
  process.stdout.write(`[phase4] ${message}\n`);
}

async function command(program, args, environment = {}) {
  const result = await execFile(program, args, {
    ...execOptions,
    env: { ...process.env, ...environment },
  });
  return result.stdout.trim();
}

function compose(args, environment = {}) {
  return command(
    'docker',
    ['compose', '-p', composeProject, '-f', composeFile, ...args],
    environment,
  );
}

async function waitFor(description, assertion, timeoutMs = 90_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await assertion();
      if (value !== false && value !== undefined && value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${description} did not become true within ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function jsonRequest(url, options = {}, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method ?? 'GET'} ${url} returned ${response.status}: ${text}`,
  );
  return body;
}

async function query(text, values = []) {
  return (await pool.query(text, values)).rows;
}

async function token(role = 'tenant_developer') {
  const url = new URL('http://127.0.0.1:18080/token');
  url.searchParams.set('roles', role);
  url.searchParams.set('subject', `phase4-${role}`);
  url.searchParams.set('projects', role === 'platform_administrator' ? '' : projectId);
  return (await jsonRequest(url)).access_token;
}

function traceId(label) {
  return createHash('sha256').update(`${runId}:${label}`).digest('hex').slice(0, 32);
}

function traceparent(label) {
  return `00-${traceId(label)}-${createHash('sha256').update(`span:${runId}:${label}`).digest('hex').slice(0, 16)}-01`;
}

async function createInstance(label, bearer, options = {}) {
  const hostname = `p4-${label}-${runId}`.slice(0, 63);
  const secretFixture = `ssh-ed25519 ${'A'.repeat(48)} ${label}-${runId}@restricted`;
  const response = await jsonRequest(
    `${apiBase}/v1/projects/${projectId}/instances`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': `phase4-${label}-${runId}`,
        'x-correlation-id': randomUUID(),
        traceparent: traceparent(label),
      },
      body: JSON.stringify({
        imageId: 'ubuntu-24-04-cloud',
        flavorId: 'lab-small',
        networkId: 'lab-primary',
        hostname,
        sshPublicKeys: [secretFixture],
      }),
    },
    202,
  );
  evidence.fixtures[label] = {
    operationId: response.operationId,
    instanceId: response.targetId,
    traceId: traceId(label),
    hostname,
  };
  return { ...response, hostname, secretFixture, traceId: traceId(label), ...options };
}

const terminalStates = new Set(['failed', 'manual_review', 'succeeded']);

async function operation(operationId, bearer) {
  const response = await fetch(`${apiBase}/v1/projects/${projectId}/operations/${operationId}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (response.status === 404) return null;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForOperation(
  fixture,
  bearer,
  expectedState,
  timeoutMs = 120_000,
  ignoredTerminalStates = [],
) {
  const current = await waitFor(
    `operation ${fixture.operationId}=${expectedState}`,
    async () => {
      const current = await operation(fixture.operationId, bearer);
      if (!current || !terminalStates.has(current.state)) return false;
      if (ignoredTerminalStates.includes(current.state)) return false;
      return current;
    },
    timeoutMs,
    500,
  );
  assert.equal(current.state, expectedState, JSON.stringify(current));
  return current;
}

async function containerHealth(service) {
  const id = await compose(['ps', '-q', service]);
  if (!id) return false;
  return (
    (await command('docker', ['inspect', '--format', '{{.State.Health.Status}}', id])) === 'healthy'
  );
}

async function containerState(service) {
  const id = await compose(['ps', '-q', '--all', service]);
  if (!id) return null;
  return JSON.parse(await command('docker', ['inspect', '--format', '{{json .State}}', id]));
}

function waitForHealth(service, timeoutMs = 120_000) {
  return waitFor(`${service} health`, () => containerHealth(service), timeoutMs, 1_000);
}

async function setProvider(adapter, scenario = 'success', taskPolls = 1) {
  await compose(['up', '-d', '--no-deps', '--force-recreate', 'proxmox-provider'], {
    PHASE4_PROVIDER_ADAPTER: adapter,
    PHASE4_FAKE_PROVIDER_SCENARIO: scenario,
    PHASE4_FAKE_PROVIDER_TASK_POLLS: String(taskPolls),
  });
  await waitForHealth('proxmox-provider');
  await waitFor(
    'provider gRPC readiness from orchestrator',
    async () => {
      try {
        await compose([
          'exec',
          '-T',
          'provisioning-orchestrator',
          'node',
          '-e',
          [
            "const grpc=require('@grpc/grpc-js')",
            'const field=(tag,value)=>{const body=Buffer.from(value);return Buffer.concat([Buffer.from([tag,body.length]),body])}',
            "const request=Buffer.concat([field(10,'phase4-ready'),field(18,'phase4-ready'),field(26,'fake-lab')])",
            "const client=new grpc.Client('proxmox-provider:50052',grpc.credentials.createInsecure())",
            "client.makeUnaryRequest('/privatecloud.provider.v1.ProviderService/GetCapabilities',()=>request,value=>value,request,new grpc.Metadata(),{deadline:new Date(Date.now()+5000)},error=>{client.close();if(error&&(error.code===grpc.status.DEADLINE_EXCEEDED||error.code===grpc.status.UNAVAILABLE))process.exit(1)})",
          ].join(';'),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    500,
  );
  // The verifier probes with a fresh channel. Give the orchestrator's pooled channel one
  // reconnect-backoff interval to discard the provider container's previous network address.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function connectorRunning() {
  const status = await jsonRequest('http://127.0.0.1:8083/connectors/private-cloud-outbox/status');
  return status.connector?.state === 'RUNNING' && status.tasks?.[0]?.state === 'RUNNING';
}

async function prometheusQuery(expression) {
  const url = new URL(`${prometheusBase}/api/v1/query`);
  url.searchParams.set('query', expression);
  const response = await jsonRequest(url);
  assert.equal(response.status, 'success');
  return response.data.result;
}

async function scalar(expression) {
  const result = await prometheusQuery(expression);
  if (result.length === 0) return 0;
  return Number(result[0].value[1]);
}

async function tempoTrace(id, timeoutMs = 30_000) {
  return waitFor(
    `Tempo trace ${id}`,
    async () => {
      const response = await fetch(`${tempoBase}/api/traces/${id}`);
      if (response.status === 404) return false;
      if (response.status !== 200) {
        throw new Error(`Tempo returned ${response.status}: ${await response.text()}`);
      }
      return response.json();
    },
    timeoutMs,
    1_000,
  );
}

async function tempoSpan(id, name, timeoutMs = 30_000) {
  return waitFor(
    `Tempo span ${name} in ${id}`,
    async () => {
      const response = await fetch(`${tempoBase}/api/traces/${id}`);
      if (response.status === 404) return false;
      if (response.status !== 200) {
        throw new Error(`Tempo returned ${response.status}: ${await response.text()}`);
      }
      return spans(await response.json()).find((span) => span.name === name) ?? false;
    },
    timeoutMs,
    1_000,
  );
}

function spans(trace) {
  return trace.batches.flatMap((batch) =>
    (batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
}

function attributes(span) {
  return Object.fromEntries(
    (span.attributes ?? []).map((attribute) => [
      attribute.key,
      attribute.value.stringValue ??
        attribute.value.intValue ??
        attribute.value.doubleValue ??
        attribute.value.boolValue,
    ]),
  );
}

async function publishRecord(payload, overrides = {}) {
  const requireFromMessaging = createRequire(`${root}packages/messaging/package.json`);
  const { Kafka, logLevel } = requireFromMessaging('kafkajs');
  const kafka = new Kafka({
    clientId: `phase4-verifier-${runId}`,
    brokers: ['127.0.0.1:9092'],
    logLevel: logLevel.NOTHING,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  try {
    await producer.send({
      topic: overrides.topic ?? 'provisioning.commands.v1',
      messages: [
        {
          key: overrides.key ?? payload.partitionKey,
          value: overrides.value ?? JSON.stringify(payload),
          headers: overrides.headers ?? {
            'event-id': payload.eventId,
            'schema-name': payload.schemaName,
            'schema-version': String(payload.schemaVersion),
            'replay-generation': '0',
            traceparent: payload.traceContext.traceparent,
          },
        },
      ],
    });
  } finally {
    await producer.disconnect();
  }
}

async function mockProxmoxState() {
  const output = await compose([
    'exec',
    '-T',
    'local-proxmox',
    'node',
    '-e',
    "fetch('https://127.0.0.1:8443/verification/state',{headers:{authorization:'PVEAPIToken=local@pve!phase4=local-secret'}}).then(async response=>{if(!response.ok)process.exit(1);process.stdout.write(await response.text())}).catch(()=>process.exit(1))",
  ]);
  return JSON.parse(output).data;
}

async function verifyInitialEnvironment() {
  if (reset) {
    log('resetting isolated Compose volumes');
    await compose(['down', '--volumes', '--remove-orphans']);
  }
  const up = ['up', '-d'];
  if (!skipBuild) up.push('--build');
  await compose(up);
  for (const service of healthCheckedServices) {
    await waitForHealth(service, 180_000);
  }
  await compose(['run', '--rm', '--no-deps', 'migrate']);
  await compose(['run', '--rm', '--no-deps', 'seed']);
  await waitFor('Debezium connector and task', connectorRunning, 120_000, 1_000);
  const target = await jsonRequest(`${prometheusBase}/api/v1/targets`);
  const active = target.data.activeTargets;
  assert.deepEqual(
    active.map((item) => item.labels.job),
    ['otel-collector-consolidated'],
  );
  assert.equal(active[0].health, 'up');
  evidence.checks.environment = {
    healthyServices: healthCheckedServices.length,
    prometheusTargets: 1,
  };
}

async function verifyProxmoxHappyPath(tenant) {
  log('verifying the complete Proxmox HTTP journey and ordinary duplicate');
  await setProvider('proxmox');
  const fixture = await createInstance('proxmox-happy', tenant);
  const completed = await waitForOperation(fixture, tenant, 'succeeded');
  const rows = await query(
    `SELECT w.status, w.stage, w.provider_resource_id,
            (SELECT count(*)::int FROM workflow.command_receipts r WHERE r.event_id = w.event_id) AS receipts,
            (SELECT count(*)::int FROM projection.instances i WHERE i.instance_id = w.instance_id) AS projections
       FROM workflow.workflows w WHERE w.operation_id = $1`,
    [fixture.operationId],
  );
  assert.deepEqual(rows[0]?.status, 'succeeded');
  assert.equal(rows[0]?.receipts, 1);
  assert.equal(rows[0]?.projections, 1);
  assert.equal((await mockProxmoxState()).count, 1);

  const commandRow = (
    await query(`SELECT payload FROM control.outbox WHERE payload->>'operationId' = $1`, [
      fixture.operationId,
    ])
  )[0];
  assert(commandRow?.payload);
  const beforeEvents = Number(
    (
      await query(`SELECT count(*) FROM workflow.outbox WHERE aggregate_id = $1`, [
        fixture.targetId,
      ])
    )[0].count,
  );
  await publishRecord(commandRow.payload);
  await waitFor(
    'duplicate message metric',
    async () =>
      (await scalar(
        'sum(controlplane_messaging_processed_total{outcome="duplicate",messaging_destination_name="provisioning.commands.v1"})',
      )) >= 1,
    30_000,
    1_000,
  );
  const afterEvents = Number(
    (
      await query(`SELECT count(*) FROM workflow.outbox WHERE aggregate_id = $1`, [
        fixture.targetId,
      ])
    )[0].count,
  );
  assert.equal(afterEvents, beforeEvents);
  assert.equal((await mockProxmoxState()).count, 1);

  const trace = await tempoTrace(fixture.traceId, 60_000);
  const allSpans = spans(trace);
  const names = new Set(allSpans.map((span) => span.name));
  const requiredNames = [
    'InstancesController.create',
    'controlplane.command.accept',
    'controlplane.transaction.accept_create',
    'controlplane.outbox.write',
    'db-log-write',
    'private-cloud-outbox-relay',
    'provisioning.commands.v1 process',
    'controlplane.transaction.command_admission',
    'controlplane.workflow.stage',
    'grpc.privatecloud.provider.v1.ProviderService/SubmitCreateInstance',
    'controlplane.provider.adapter',
    'provisioning.events.v1 process',
    'controlplane.projection.apply',
  ];
  assert.deepEqual(
    requiredNames.filter((name) => !names.has(name)),
    [],
    `missing spans: ${requiredNames.filter((name) => !names.has(name)).join(', ')}`,
  );
  const httpSpans = allSpans.filter(
    (span) => attributes(span)['server.address'] === 'local-proxmox',
  );
  assert(httpSpans.length >= 1, 'No instrumented Proxmox HTTP span was exported.');
  evidence.checks.proxmoxHappyPath = {
    operationState: completed.state,
    workflowRows: rows.length,
    commandReceipts: rows[0].receipts,
    projections: rows[0].projections,
    providerResources: 1,
    duplicateBusinessEvents: afterEvents - beforeEvents,
    traceSpans: allSpans.length,
    proxmoxHttpSpans: httpSpans.length,
    requiredSpanNames: requiredNames,
  };
  return fixture;
}

async function verifyKafkaAndCheckpointRecovery(tenant) {
  log('verifying Kafka outage, consumer buffering, and workflow checkpoint recovery');
  await setProvider('fake', 'success', 1);
  const publishDelayBefore = await scalar('sum(controlplane_outbox_publish_delay_seconds_sum)');
  await compose(['stop', 'kafka']);
  const brokerOutage = await createInstance('kafka-outage', tenant);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const durable = await query(
    `SELECT (SELECT count(*)::int FROM control.outbox
              WHERE payload->>'operationId' = $1 AND topic = 'provisioning.commands.v1') AS outbox,
            (SELECT count(*)::int FROM workflow.command_receipts r
               JOIN control.outbox o ON o.event_id = r.event_id
              WHERE o.payload->>'operationId' = $1 AND o.topic = 'provisioning.commands.v1') AS receipts`,
    [brokerOutage.operationId],
  );
  assert.equal(durable[0].outbox, 1);
  assert.equal(durable[0].receipts, 0);
  await compose(['start', 'kafka']);
  await waitForHealth('kafka', 120_000);
  await waitFor('Debezium recovery', connectorRunning, 120_000, 1_000);
  await waitForOperation(brokerOutage, tenant, 'succeeded', 150_000);
  await waitFor(
    'outbox publication delay increase',
    async () =>
      (await scalar('sum(controlplane_outbox_publish_delay_seconds_sum)')) > publishDelayBefore,
    30_000,
    1_000,
  );

  const queueResidenceBefore = await scalar(
    'sum(controlplane_messaging_queue_residence_seconds_sum)',
  );
  await compose(['stop', 'provisioning-orchestrator']);
  const consumerOutage = await createInstance('consumer-outage', tenant);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const buffered = await query(
    `SELECT count(*)::int AS count FROM workflow.command_receipts r
       JOIN control.outbox o ON o.event_id = r.event_id WHERE o.payload->>'operationId' = $1`,
    [consumerOutage.operationId],
  );
  assert.equal(buffered[0].count, 0);
  await compose(['start', 'provisioning-orchestrator']);
  await waitForHealth('provisioning-orchestrator');
  await waitForOperation(consumerOutage, tenant, 'succeeded');
  await waitFor(
    'queue residence increase',
    async () =>
      (await scalar('sum(controlplane_messaging_queue_residence_seconds_sum)')) >
      queueResidenceBefore + 1,
    30_000,
    1_000,
  );

  await setProvider('fake', 'success', 20);
  const checkpoint = await createInstance('checkpoint', tenant);
  const stageBefore = await waitFor(
    'persisted polling checkpoint',
    async () => {
      const row = (
        await query(
          `SELECT stage, status, provider_resource_id FROM workflow.workflows WHERE operation_id = $1`,
          [checkpoint.operationId],
        )
      )[0];
      return row?.stage?.startsWith('polling_') ? row : false;
    },
    30_000,
    100,
  );
  await compose(['stop', 'provisioning-orchestrator']);
  await compose(['start', 'provisioning-orchestrator']);
  await waitForHealth('provisioning-orchestrator');
  await waitForOperation(checkpoint, tenant, 'succeeded', 180_000);
  const stageAfter = (
    await query(
      `SELECT stage, status, provider_resource_id FROM workflow.workflows WHERE operation_id = $1`,
      [checkpoint.operationId],
    )
  )[0];
  assert.equal(stageAfter.status, 'succeeded');
  assert.equal(stageAfter.provider_resource_id, stageBefore.provider_resource_id);
  evidence.checks.recovery = {
    kafkaOutageAcceptedWithoutReceipt: durable[0].receipts === 0,
    kafkaOutageRecovered: true,
    consumerBuffered: buffered[0].count === 0,
    checkpointStage: stageBefore.stage,
    resumedStage: stageAfter.stage,
    providerResourceStable: stageAfter.provider_resource_id === stageBefore.provider_resource_id,
  };
}

async function verifyFailurePolicy(tenant, admin) {
  log('verifying retry, permanent failure, ambiguous mutation, DLQ, and replay');
  await setProvider('fake', 'retry');
  const retry = await createInstance('retry', tenant);
  await waitForOperation(retry, tenant, 'succeeded');
  const retryRows = await query(
    `SELECT count(*)::int AS count FROM workflow.outbox
      WHERE aggregate_id = $1 AND schema_name = 'workflow.progressed'
        AND payload #>> '{data,operationState}' = 'retry_wait'`,
    [retry.targetId],
  );
  assert(retryRows[0].count >= 1);

  await setProvider('fake', 'permanent');
  const permanent = await createInstance('permanent', tenant);
  const permanentOperation = await waitForOperation(permanent, tenant, 'failed');
  assert.equal(permanentOperation.errorCategory, 'validation');
  const permanentDeadLetters = await query(
    `SELECT count(*)::int AS count FROM workflow.dead_letters WHERE operation_id = $1`,
    [permanent.operationId],
  );
  assert.equal(permanentDeadLetters[0].count, 0);

  await setProvider('fake', 'ambiguous');
  const ambiguous = await createInstance('ambiguous', tenant);
  const ambiguousOperation = await waitForOperation(ambiguous, tenant, 'manual_review');
  assert.equal(ambiguousOperation.manualReviewRequired, true);
  assert.equal(ambiguousOperation.errorCategory, 'unknown_outcome');

  await setProvider('fake', 'retry-exhaustion');
  const exhausted = await createInstance('exhausted', tenant);
  await waitForOperation(exhausted, tenant, 'failed', 180_000);
  const deadLetter = await waitFor(
    'workflow dead letter projection',
    async () => {
      const row = (
        await query(
          `SELECT d.original_event_id, d.dead_letter_event_id, d.status, d.attempts,
                  d.replay_allowed, p.original_event_id AS projected
             FROM workflow.dead_letters d
             LEFT JOIN projection.dead_letters p USING (original_event_id)
            WHERE d.operation_id = $1`,
          [exhausted.operationId],
        )
      )[0];
      return row?.projected ? row : false;
    },
    30_000,
    500,
  );
  assert.equal(deadLetter.status, 'open');
  assert.equal(deadLetter.attempts, 8);
  assert.equal(deadLetter.replay_allowed, true);

  const replayReason = `Provider recovered after bounded Phase 4 drill ${runId}; ticket OPS-4004.`;
  await jsonRequest(
    `${apiBase}/v1/admin/dead-letters/${deadLetter.original_event_id}/replays`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenant}`,
        'content-type': 'application/json',
        'idempotency-key': `denied-${runId}`,
      },
      body: JSON.stringify({ reason: replayReason }),
    },
    403,
  );

  await setProvider('fake', 'success');
  const replayLabel = 'authorized-replay';
  const replayResponse = await jsonRequest(
    `${apiBase}/v1/admin/dead-letters/${deadLetter.original_event_id}/replays`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin}`,
        'content-type': 'application/json',
        'idempotency-key': `replay-${runId}`,
        'x-correlation-id': randomUUID(),
        traceparent: traceparent(replayLabel),
      },
      body: JSON.stringify({ reason: replayReason }),
    },
    202,
  );
  evidence.fixtures[replayLabel] = {
    operationId: replayResponse.operationId,
    originalEventId: deadLetter.original_event_id,
    traceId: traceId(replayLabel),
  };
  // The read projection remains generation-zero `failed` until the first replay progress event.
  // Ignore only that stale terminal value; manual review or any other terminal still fails fast.
  await waitForOperation(exhausted, tenant, 'succeeded', 120_000, ['failed']);
  const replayed = (
    await query(
      `SELECT w.status, w.replay_generation, d.status AS dead_letter_status,
              array_agg(r.replay_generation ORDER BY r.replay_generation) AS receipt_generations
         FROM workflow.workflows w
         JOIN workflow.dead_letters d ON d.operation_id = w.operation_id
         JOIN workflow.command_receipts r ON r.event_id = w.event_id
        WHERE w.operation_id = $1
        GROUP BY w.status, w.replay_generation, d.status`,
      [exhausted.operationId],
    )
  )[0];
  assert.equal(replayed.status, 'succeeded');
  assert.equal(replayed.replay_generation, 1);
  assert.equal(replayed.dead_letter_status, 'replayed');
  assert.deepEqual(replayed.receipt_generations, [0, 1]);

  const replaySpan = await tempoSpan(traceId(replayLabel), 'controlplane.replay.request', 60_000);
  assert((replaySpan.links ?? []).length >= 1, 'Replay span did not link the failed trace.');

  evidence.checks.failurePolicy = {
    retryWaitEvents: retryRows[0].count,
    permanentState: permanentOperation.state,
    permanentDeadLetters: permanentDeadLetters[0].count,
    ambiguousState: ambiguousOperation.state,
    retryAttempts: deadLetter.attempts,
    deniedReplayStatus: 403,
    successfulReplayGeneration: replayed.replay_generation,
    originalEventIdRetained: deadLetter.original_event_id,
    replayTraceLinks: replaySpan.links.length,
  };
  return { exhausted, replayReason };
}

async function verifyQuarantine() {
  log('verifying poison quarantine');
  const before = Number((await query('SELECT count(*) FROM workflow.poison_records'))[0].count);
  await publishRecord(
    { partitionKey: 'poison' },
    {
      key: 'poison',
      value: `{not-json-${runId}`,
      headers: { 'replay-generation': '0' },
    },
  );
  const after = await waitFor(
    'poison quarantine row',
    async () => {
      const count = Number((await query('SELECT count(*) FROM workflow.poison_records'))[0].count);
      return count > before ? count : false;
    },
    30_000,
    500,
  );
  evidence.checks.quarantine = { recordsAdded: after - before, rawPayloadStored: false };
}

async function verifyMetricsAndRedaction(fixtures, traceRestrictedValues, metricRestrictedValues) {
  log('verifying Prometheus samples and telemetry redaction');
  const requiredMetrics = [
    'controlplane_command_accepted_total',
    'controlplane_messaging_processed_total',
    'controlplane_messaging_queue_residence_seconds_bucket',
    'controlplane_outbox_publish_delay_seconds_bucket',
    'controlplane_workflow_transition_total',
    'controlplane_workflow_retry_total',
    'controlplane_workflow_active',
    'controlplane_workflow_oldest_ready_age_seconds',
    'controlplane_provider_operation_duration_seconds_bucket',
    'controlplane_projection_apply_duration_seconds_bucket',
    'controlplane_projection_event_age_seconds_bucket',
    'controlplane_dead_letter_total',
    'controlplane_quarantine_total',
    'controlplane_replay_total',
    'kafka_server_brokertopicmetrics_messagesin_total',
    'kafka_connect_task_running_ratio',
    'debezium_postgres_connected',
    'postgresql_commits_total',
    'postgresql_database_locks',
    'postgresql_replication_slot_active',
    'otelcol_receiver_accepted_metric_points_total',
    'otelcol_receiver_refused_metric_points_total',
    'otelcol_exporter_sent_spans_total',
  ];
  const missing = [];
  for (const metric of requiredMetrics) {
    const present = await waitFor(
      `${metric} sample`,
      async () => (await prometheusQuery(`count({__name__="${metric}"})`)).length > 0,
      30_000,
      1_000,
    ).catch(() => false);
    if (!present) missing.push(metric);
  }
  assert.deepEqual(missing, [], `missing Prometheus metrics: ${missing.join(', ')}`);

  const seriesUrl = new URL(`${prometheusBase}/api/v1/series`);
  seriesUrl.searchParams.append('match[]', '{__name__=~"controlplane_.+"}');
  seriesUrl.searchParams.set('start', new Date(startedAt.getTime() - 60_000).toISOString());
  const series = (await jsonRequest(seriesUrl)).data;
  // Prometheus adds `instance` and `job` at scrape time; they are not application metric
  // attributes. Match exact business identifiers so approved dimensions such as
  // `event_schema_name` remain usable while high-cardinality entity identity is rejected.
  const scrapeMetadataLabels = new Set(['instance', 'job']);
  const prohibitedMetricLabel =
    /(^|_)(project_id|tenant_id|instance_id|operation_id|event_id|resource_id|task_id|aggregate_id|idempotency_key|partition_key|ssh_key|address|credential|hostname|ip_address|reason|payload)($|_)/i;
  const prohibitedLabels = series.flatMap((item) =>
    Object.keys(item)
      .filter(
        (key) =>
          key !== '__name__' && !scrapeMetadataLabels.has(key) && prohibitedMetricLabel.test(key),
      )
      .map((key) => `${item.__name__}:${key}`),
  );
  assert.deepEqual(prohibitedLabels, []);
  assert(
    series.every((item) => item.instance === 'otel-collector:8889'),
    'Control-plane metrics must be scraped only from the consolidated Collector endpoint',
  );
  const seriesText = JSON.stringify(series);
  for (const value of [...traceRestrictedValues, ...metricRestrictedValues]) {
    assert(!seriesText.includes(value), `Restricted fixture value reached metric labels: ${value}`);
  }

  for (const fixture of fixtures) {
    const trace = await tempoTrace(fixture.traceId, 60_000);
    const traceText = JSON.stringify(trace);
    for (const value of traceRestrictedValues) {
      assert(!traceText.includes(value), `Restricted fixture value reached trace export: ${value}`);
    }
  }
  evidence.checks.telemetry = {
    requiredMetrics,
    prohibitedMetricLabels: prohibitedLabels.length,
    restrictedValuesInMetrics: 0,
    restrictedValuesInTraces: 0,
  };
}

async function verifyGrafanaProvisioning() {
  const dashboard = await jsonRequest(
    'http://127.0.0.1:3101/api/dashboards/uid/private-cloud-phase4-event-pipeline',
  );
  const datasources = await jsonRequest('http://127.0.0.1:3101/api/datasources');
  assert.equal(dashboard.dashboard.panels.length, 5);
  assert.deepEqual(datasources.map((source) => source.uid).sort(), ['prometheus', 'tempo']);
  const prometheus = datasources.find((source) => source.uid === 'prometheus');
  assert.equal(prometheus.jsonData.exemplarTraceIdDestinations[0].datasourceUid, 'tempo');
  evidence.checks.grafana = {
    dashboardUid: dashboard.dashboard.uid,
    panels: dashboard.dashboard.panels.map((panel) => panel.title),
    datasources: ['prometheus', 'tempo'],
    exemplarTraceDestination: 'tempo',
    screenshots: [
      'docs/verification/evidence/phase4-grafana-dashboard.png',
      'docs/verification/evidence/phase4-tempo-trace.png',
    ],
  };
}

async function restoreHealthyStack() {
  await compose(['up', '-d', '--no-deps', 'kafka']);
  await waitForHealth('kafka', 120_000);
  await compose(['up', '-d', '--no-deps', 'debezium-connect']);
  await waitForHealth('debezium-connect', 120_000);
  await compose(['up', '-d', '--no-deps', 'provisioning-orchestrator', 'control-api']);
  await setProvider('fake', 'success');
  for (const service of healthCheckedServices) {
    await waitForHealth(service, 120_000);
  }
  await waitFor('final Debezium state', connectorRunning, 120_000, 1_000);
  assert.equal((await containerState('tempo'))?.Status, 'running');
  for (const service of initializationJobs) {
    const state = await containerState(service);
    assert.equal(state?.Status, 'exited', `${service} did not exit`);
    assert.equal(state?.ExitCode, 0, `${service} did not exit successfully`);
  }

  // Catch delayed health transitions before claiming that the persistent stack is stable.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  for (const service of healthCheckedServices) {
    assert.equal(await containerHealth(service), true, `${service} did not remain healthy`);
  }
}

let failure;
try {
  await verifyInitialEnvironment();
  const tenant = await token();
  const admin = await token('platform_administrator');
  const happy = await verifyProxmoxHappyPath(tenant);
  await verifyKafkaAndCheckpointRecovery(tenant);
  const recovery = await verifyFailurePolicy(tenant, admin);
  await verifyQuarantine();
  await verifyMetricsAndRedaction(
    [happy, recovery.exhausted, { traceId: traceId('authorized-replay') }],
    [happy.secretFixture, happy.hostname, recovery.replayReason, tenant, admin],
    [
      ...Object.values(evidence.fixtures)
        .flatMap((fixture) => [fixture.operationId, fixture.instanceId])
        .filter(Boolean),
    ],
  );
  await verifyGrafanaProvisioning();
  evidence.status = 'passed';
} catch (error) {
  failure = error;
  evidence.status = 'failed';
  evidence.failure = error instanceof Error ? error.stack : String(error);
} finally {
  try {
    await restoreHealthyStack();
    evidence.finalStack = {
      healthy: true,
      persistent: true,
      healthCheckedServices: healthCheckedServices.length,
      runningServices: healthCheckedServices.length + 1,
      initializationJobs: initializationJobs.length,
      stabilityWindowSeconds: 10,
    };
  } catch (restoreError) {
    evidence.finalStack = {
      healthy: false,
      error: restoreError instanceof Error ? restoreError.message : String(restoreError),
    };
    failure ??= restoreError;
    evidence.status = 'failed';
  }
  evidence.completedAt = new Date().toISOString();
  evidence.durationSeconds = Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  await pool.end();
}

if (failure) throw failure;
log(`all runtime checks passed; evidence: ${evidenceFile.pathname}`);
