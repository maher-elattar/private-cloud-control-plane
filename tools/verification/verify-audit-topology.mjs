import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ControlPlaneApplication,
  CreateInstanceWorkflow,
} from '../../packages/application/dist/index.js';
import {
  PostgresControlPlaneStore,
  PostgresProjectionStore,
  PostgresWorkflowStore,
  createPostgresDatabase,
} from '../../packages/postgres-adapter/dist/index.js';
import { FakeProvider } from '../../packages/provider-adapters/dist/index.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required. Run migrations and seed first.');

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const startedAt = new Date();
const runId = randomUUID();

// Direct adapter tests still need realistic, run-unique source coordinates because the durable
// receipt constraint intentionally rejects two different events claiming the same Kafka record.
const syntheticOffsetBase = BigInt(`0x${runId.replaceAll('-', '').slice(0, 15)}`);
const syntheticOffset = (delta) => (syntheticOffsetBase + BigInt(delta)).toString();

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function syntheticCreateCommand() {
  const operationId = randomUUID();
  const instanceId = randomUUID();
  return {
    eventId: randomUUID(),
    schemaName: 'instance.create.requested',
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: instanceId,
    projectId: PROJECT_ID,
    operationId,
    correlationId: randomUUID(),
    causationId: operationId,
    occurredAt: new Date().toISOString(),
    traceContext: { traceparent: TRACEPARENT },
    partitionKey: instanceId,
    data: {
      imageId: 'ubuntu-24-04-cloud',
      flavorId: 'lab-small',
      networkId: 'lab-primary',
      providerProfileId: 'fake-lab',
      hostname: 'audit-replay-01',
      resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 },
      ipv4: {
        address: '192.0.2.20',
        prefixLength: 27,
        gateway: '192.0.2.1',
        dnsServers: ['192.0.2.53'],
      },
    },
  };
}

const db = createPostgresDatabase(databaseUrl);
try {
  const controlStore = new PostgresControlPlaneStore(db);
  const control = new ControlPlaneApplication(controlStore);
  const request = {
    actor: { subject: 'audit-verifier', roles: ['tenant_developer'], projects: [PROJECT_ID] },
    projectId: PROJECT_ID,
    idempotencyKey: `audit-create-${runId}`,
    correlationId: randomUUID(),
    traceparent: TRACEPARENT,
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    networkId: 'lab-primary',
    hostname: 'audit-web-01',
  };
  const accepted = await control.createInstance(request);
  const duplicateAcceptance = await control.createInstance(request);
  assert.equal(duplicateAcceptance.replayed, true);

  const commandRow = await db
    .selectFrom('control.outbox')
    .select(['payload', 'event_id'])
    .where('schema_name', '=', 'instance.create.requested')
    .where('aggregate_id', '=', accepted.targetId)
    .executeTakeFirstOrThrow();
  const command = json(commandRow.payload);

  const workflowStore = new PostgresWorkflowStore(db);
  assert.equal(
    await workflowStore.admitCreateCommand(command, {
      topic: 'provisioning.commands.v1',
      partition: 0,
      offset: syntheticOffset(0),
      replayGeneration: 0,
    }),
    'accepted',
  );
  assert.equal(
    await workflowStore.admitCreateCommand(command, {
      topic: 'provisioning.commands.v1',
      partition: 0,
      offset: syntheticOffset(0),
      replayGeneration: 0,
    }),
    'duplicate',
  );

  const workflow = new CreateInstanceWorkflow(
    workflowStore,
    new FakeProvider({ defaultTaskPollsBeforeSuccess: 0 }),
    'audit-verifier-worker',
  );
  for (let transition = 0; transition < 20; transition += 1) {
    if (!(await workflow.runOne())) break;
  }
  const completed = await db
    .selectFrom('workflow.workflows')
    .select('status')
    .where('operation_id', '=', accepted.operationId)
    .executeTakeFirstOrThrow();
  assert.equal(completed.status, 'succeeded');

  const replayable = syntheticCreateCommand();
  assert.equal(
    await workflowStore.deadLetterCommand({
      event: replayable,
      delivery: {
        topic: 'provisioning.commands.v1',
        partition: 1,
        offset: syntheticOffset(1),
        replayGeneration: 0,
      },
      attempts: 3,
      failureCode: 'COMMAND_SCHEMA_UNSUPPORTED',
      safeMessage: 'Compatibility is not deployed.',
      replayAllowed: true,
    }),
    'dead_lettered',
  );

  const dlqRow = await db
    .selectFrom('workflow.outbox')
    .select('payload')
    .where('topic', '=', 'provisioning.dlq.v1')
    .where('aggregate_id', '=', replayable.aggregateId)
    .executeTakeFirstOrThrow();
  await new PostgresProjectionStore(db).applyDeadLetterEvent(json(dlqRow.payload), {
    topic: 'provisioning.dlq.v1',
    partition: 1,
    offset: syntheticOffset(2),
    replayGeneration: 0,
  });

  await control.requestDeadLetterReplay({
    actor: { subject: 'platform-admin', roles: ['platform_administrator'], projects: [] },
    originalEventId: replayable.eventId,
    idempotencyKey: `audit-replay-${runId}`,
    correlationId: randomUUID(),
    traceparent: TRACEPARENT,
    reason: 'Compatibility was deployed and the provider is healthy.',
  });
  const replayRow = await db
    .selectFrom('control.outbox')
    .select('payload')
    .where('schema_name', '=', 'provisioning.replay.requested')
    .where('aggregate_id', '=', replayable.aggregateId)
    .executeTakeFirstOrThrow();
  const replayRequest = json(replayRow.payload);
  assert.equal(
    await workflowStore.admitReplayRequest(replayRequest, {
      topic: 'provisioning.commands.v1',
      partition: 1,
      offset: syntheticOffset(3),
      replayGeneration: 0,
    }),
    'accepted',
  );

  // The restored original is a new logical delivery, not a Kafka record that ever had coordinates.
  const restoredReceipt = await db
    .selectFrom('workflow.command_receipts')
    .select(['replay_generation', 'source_topic', 'source_partition', 'source_offset'])
    .where('event_id', '=', replayable.eventId)
    .where('replay_generation', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(restoredReceipt, {
    replay_generation: 1,
    source_topic: null,
    source_partition: null,
    source_offset: null,
  });

  const controlAudit = await db
    .selectFrom('control.outbox')
    .select(['payload', 'partition_key'])
    .where('topic', '=', 'audit.events.v1')
    .where('created_at', '>=', startedAt)
    .orderBy('created_at')
    .execute()
    .then((rows) =>
      rows.filter((row) => {
        const data = json(row.payload).data;
        return (
          (data.targetId === accepted.targetId && data.action === 'create_instance') ||
          (data.targetId === replayable.eventId && data.action === 'replay_dead_letter')
        );
      }),
    );
  const workflowAudit = await db
    .selectFrom('workflow.outbox')
    .select(['payload', 'partition_key'])
    .where('topic', '=', 'audit.events.v1')
    .where('created_at', '>=', startedAt)
    .orderBy('created_at')
    .execute()
    .then((rows) =>
      rows.filter((row) => {
        const data = json(row.payload).data;
        return (
          (data.targetId === accepted.targetId && data.action === 'create_instance') ||
          (data.targetId === replayable.aggregateId &&
            (data.action === 'dead_letter_command' || data.action === 'replay_dead_letter'))
        );
      }),
    );
  assert.equal(controlAudit.length, 2);
  assert.equal(workflowAudit.length, 3);
  for (const row of [...controlAudit, ...workflowAudit]) {
    const event = json(row.payload);
    assert.equal(event.schemaName, 'audit.recorded');
    assert.equal(event.aggregateType, 'audit');
    assert.equal(event.partitionKey, PROJECT_ID);
    assert.equal(row.partition_key, PROJECT_ID);
  }

  const auditEventIds = [...controlAudit, ...workflowAudit].map((row) => json(row.payload).eventId);
  const auditEntries = await db
    .selectFrom('audit.entries')
    .select('id')
    .where('id', 'in', auditEventIds)
    .execute();
  assert.equal(auditEntries.length, auditEventIds.length);

  process.stdout.write(
    `${JSON.stringify({
      controlAuditFacts: controlAudit.length,
      workflowAuditFacts: workflowAudit.length,
      restoredReplayGeneration: restoredReceipt.replay_generation,
      restoredCoordinates: null,
    })}\n`,
  );
} finally {
  await db.destroy();
}
