/**
 * Integration coverage for leased, fenced workflow execution and governed replay authorization.
 *
 * This is the file that most needed to exist. `workflow-store.ts` is the single-writer guarantee
 * for the whole control plane — if two workers can hold one instance at once, or a stale worker's
 * write lands, the system builds a second VM. None of that is observable without a real database:
 * `FOR UPDATE ... SKIP LOCKED`, `ON CONFLICT DO UPDATE` returning an incremented token, and
 * transaction visibility between concurrent claims are all engine behaviour.
 *
 * @see docs/architecture/glossary.md#lease-and-fencing-token
 * @see docs/architecture/safety-invariants.md
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@private-cloud/domain';
import type { InstanceCreateRequestedV1, InstancePowerRequestedV1 } from '@private-cloud/contracts';
import type { MessageDeliveryIdentity } from '@private-cloud/application';
import { sql } from 'kysely';
import { createPostgresDatabase } from './database.js';
import { resetIntegrationState } from './integration-support.js';
import { PostgresWorkflowStore } from './workflow-store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; the global setup should provide it.');

const db = createPostgresDatabase(databaseUrl);
const store = new PostgresWorkflowStore(db);
const projectId = '00000000-0000-4000-8000-000000000001';

let offset = 0;
function delivery(overrides: Partial<MessageDeliveryIdentity> = {}): MessageDeliveryIdentity {
  offset += 1;
  return {
    topic: 'provisioning.commands.v1',
    partition: 0,
    offset: String(offset),
    replayGeneration: 0,
    outboxId: randomUUID(),
    ...overrides,
  };
}

function command(overrides: Partial<InstanceCreateRequestedV1> = {}): InstanceCreateRequestedV1 {
  const operationId = randomUUID();
  const instanceId = randomUUID();
  return {
    eventId: randomUUID(),
    schemaName: 'instance.create.requested',
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: instanceId,
    projectId,
    operationId,
    correlationId: randomUUID(),
    causationId: operationId,
    occurredAt: new Date().toISOString(),
    traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    partitionKey: instanceId,
    data: {
      imageId: 'ubuntu-24-04-cloud',
      flavorId: 'lab-small',
      networkId: 'lab-primary',
      providerProfileId: 'fake-lab',
      hostname: `wf-${randomUUID().slice(0, 8)}`,
      resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 },
      ipv4: {
        address: '192.0.2.5',
        prefixLength: 27,
        gateway: '192.0.2.1',
        dnsServers: ['192.0.2.53'],
      },
    },
    ...overrides,
  } as InstanceCreateRequestedV1;
}

/**
 * A power command, which is the simplest capability whose payload is *not* a create.
 *
 * Present because every claim path used to validate stored commands against the create contract
 * alone. Building one here is what makes the difference between "the claim query filters by action"
 * — already covered — and "a claimed non-create command can actually be decoded", which is where
 * the bug was.
 */
function powerCommand(overrides: Partial<InstancePowerRequestedV1> = {}): InstancePowerRequestedV1 {
  const operationId = randomUUID();
  const instanceId = randomUUID();
  return {
    eventId: randomUUID(),
    schemaName: 'instance.power.requested',
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: instanceId,
    projectId,
    operationId,
    correlationId: randomUUID(),
    causationId: operationId,
    occurredAt: new Date().toISOString(),
    traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    partitionKey: instanceId,
    data: {
      action: 'shutdown',
      providerProfileId: 'fake-lab',
      createOperationId: randomUUID(),
    },
    ...overrides,
  } as InstancePowerRequestedV1;
}

beforeEach(() => resetIntegrationState(db));
afterAll(async () => {
  await db.destroy();
});

describe('admitCommand', () => {
  it('admits a first delivery and creates a claimable workflow', async () => {
    const input = command();
    const admission = await store.admitCommand(input, delivery());

    expect(admission).toEqual({ outcome: 'accepted' });
    const workflow = await db
      .selectFrom('workflow.workflows')
      .selectAll()
      .where('operation_id', '=', input.operationId)
      .executeTakeFirstOrThrow();
    expect(workflow.status).toBe('running');
    expect(workflow.stage).toBe('accepted');
  });

  it('treats a redelivery as a duplicate and creates no second workflow', async () => {
    const input = command();
    await store.admitCommand(input, delivery());
    const second = await store.admitCommand(input, delivery());

    expect(second).toEqual({ outcome: 'duplicate' });
    const workflows = await db.selectFrom('workflow.workflows').selectAll().execute();
    expect(workflows).toHaveLength(1);
  });

  it('records a receipt carrying the real broker coordinates of each delivery', async () => {
    const input = command();
    await store.admitCommand(input, delivery({ partition: 3, offset: '4242' }));
    const receipt = await db
      .selectFrom('workflow.command_receipts')
      .selectAll()
      .where('event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();

    expect(receipt.source_topic).toBe('provisioning.commands.v1');
    expect(receipt.source_partition).toBe(3);
    expect(String(receipt.source_offset)).toBe('4242');
    expect(receipt.payload_hash).toBe(canonicalSha256(input));
  });
});

describe('claimNext', () => {
  it('hands one instance to exactly one of two competing workers', async () => {
    // SAFE-010. The losing worker must get null, not a second lease on the same instance.
    const input = command();
    await store.admitCommand(input, delivery());

    const [first, second] = await Promise.all([
      store.claimNext('worker-a', 30, 'create_instance'),
      store.claimNext('worker-b', 30, 'create_instance'),
    ]);

    const claims = [first, second].filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
  });

  it('increments the fencing token on every claim', async () => {
    const input = command();
    await store.admitCommand(input, delivery());

    const first = await store.claimNext('worker-a', 30, 'create_instance');
    expect(first).not.toBeNull();
    await store.checkpoint({
      operationId: input.operationId,
      workerId: 'worker-a',
      fencingToken: first?.fencingToken ?? 0n,
      stage: 'submitting_create',
      event: progressEvent(input, 'submitting_create'),
    });
    const second = await store.claimNext('worker-a', 30, 'create_instance');

    expect(second).not.toBeNull();
    expect(second?.fencingToken).toBeGreaterThan(first?.fencingToken ?? 0n);
  });

  it('rejects a write presenting a stale fencing token', async () => {
    // The scenario fencing exists for: a worker stalls past its lease, another claims the
    // instance, then the first wakes and tries to write. Its token is now behind.
    const input = command();
    await store.admitCommand(input, delivery());
    const stalled = await store.claimNext('worker-a', 30, 'create_instance');
    expect(stalled).not.toBeNull();

    await store.checkpoint({
      operationId: input.operationId,
      workerId: 'worker-a',
      fencingToken: stalled?.fencingToken ?? 0n,
      stage: 'submitting_create',
      event: progressEvent(input, 'submitting_create'),
    });
    const current = await store.claimNext('worker-b', 30, 'create_instance');
    expect(current).not.toBeNull();

    await expect(
      store.checkpoint({
        operationId: input.operationId,
        workerId: 'worker-a',
        fencingToken: stalled?.fencingToken ?? 0n,
        stage: 'polling_create',
        event: progressEvent(input, 'polling_create'),
      }),
    ).rejects.toThrowError();
  });

  it('claims only workflows of the requested capability', async () => {
    // The bug this guards: the registry rotates between executors, so an unscoped claim let the
    // power executor take a create workflow, take its lease, and then refuse to run it — leaving
    // the workflow stranded until the lease expired. Found by a runtime drill, not a unit test.
    const input = command();
    await store.admitCommand(input, delivery());
    expect(await store.claimNext('worker-a', 30, 'power_instance')).toBeNull();
    expect(await store.claimNext('worker-a', 30, 'create_instance')).not.toBeNull();
  });

  it('claims a non-create workflow and hands back its own command', async () => {
    // The bug this guards: the claim decoded *every* stored command against the create contract,
    // so a power, resize, snapshot, retention, or purge workflow threw "not supported by this
    // deployment" the instant it was claimed. From the API the operation simply sat at `accepted`
    // forever, which is why neither the unit tests nor the deployment verification saw it — the
    // accept path was working perfectly and nothing downstream reported an error to a caller.
    const input = powerCommand();
    await store.admitCommand(input, delivery());

    const claim = await store.claimNext('worker-a', 30, 'power_instance');

    expect(claim).not.toBeNull();
    expect(claim?.action).toBe('power_instance');
    expect(claim?.command.schemaName).toBe('instance.power.requested');
    expect(claim?.command.operationId).toBe(input.operationId);
  });

  it('seeds a non-create workflow with the provider resource the create discovered', async () => {
    // The bug this guards: every workflow was admitted with a null `provider_resource_id`, which is
    // correct for a create — it has no VM yet — and wrong for everything else. A power, resize,
    // snapshot, retention, or purge workflow then raised `protocol_error` on its first mutation
    // stage and failed at 20% progress, having never called the provider at all. The operation
    // reported PROVIDER_PROTOCOL_ERROR, which reads as a provider fault and is not one.
    const created = command();
    await store.admitCommand(created, delivery());
    const createClaim = await store.claimNext('worker-a', 30, 'create_instance');
    await store.checkpoint({
      operationId: created.operationId,
      workerId: 'worker-a',
      fencingToken: createClaim?.fencingToken ?? 0n,
      stage: 'submitting_create',
      providerResourceId: 'vm-910042',
      event: progressEvent(created, 'submitting_create'),
    });

    const power = powerCommand({ aggregateId: created.aggregateId });
    await store.admitCommand(power, delivery());
    const powerClaim = await store.claimNext('worker-a', 30, 'power_instance');

    expect(powerClaim?.providerResourceId).toBe('vm-910042');
  });

  it('refuses a workflow whose stored command does not match its action', async () => {
    // Corruption, or a payload written by an incompatible build. The claim must fail rather than
    // hand a create executor a power payload — that is how the wrong provider calls reach a VM.
    const input = powerCommand();
    await store.admitCommand(input, delivery());
    await sql`UPDATE workflow.workflows SET action = 'create_instance'`.execute(db);

    await expect(store.claimNext('worker-a', 30, 'create_instance')).rejects.toThrowError(
      /not supported by this deployment/,
    );
  });

  it('returns null when no workflow is ready', async () => {
    expect(await store.claimNext('worker-a', 30, 'create_instance')).toBeNull();
  });

  it('rejects a lease duration outside the permitted range', () => {
    // Asserted as a synchronous throw, not a rejection: the guard runs before the transaction
    // opens, so no promise exists to reject. The same shape appears on the read methods of
    // `ControlPlaneApplication`, and is noted in the Phase 5 ledger as worth making consistent.
    expect(() => store.claimNext('worker-a', 1, 'create_instance')).toThrowError();
    expect(() => store.claimNext('worker-a', 3_600, 'create_instance')).toThrowError();
    expect(() => store.claimNext('', 30, 'create_instance')).toThrowError();
  });
});

describe('governed replay authorization', () => {
  /**
   * Drives one workflow to a governed dead letter, which is the only legitimate starting point
   * for a replay. Building the row by hand would test the fixture rather than the code.
   */
  async function exhaustToDeadLetter(input: InstanceCreateRequestedV1): Promise<void> {
    await store.admitCommand(input, delivery());
    const claim = await store.claimNext('worker-a', 30, 'create_instance');
    if (!claim) throw new Error('The admitted workflow was not claimable.');
    await store.deadLetterWorkflow({
      operationId: input.operationId,
      workerId: 'worker-a',
      fencingToken: claim.fencingToken,
      attempts: 8,
      failureCode: 'PROVIDER_RETRY_EXHAUSTED',
      safeMessage: 'The provider did not accept the request within the retry budget.',
      lastErrorCategory: 'transient',
      lastErrorCode: 'unavailable',
      event: {
        eventId: randomUUID(),
        schemaName: 'instance.mutation.failed',
        schemaVersion: 1,
        aggregateType: 'instance',
        aggregateId: input.aggregateId,
        projectId: input.projectId,
        operationId: input.operationId,
        correlationId: input.correlationId,
        causationId: input.eventId,
        occurredAt: new Date().toISOString(),
        traceContext: input.traceContext,
        partitionKey: input.partitionKey,
        data: {
          action: 'create_instance',
          failure: {
            category: 'transient',
            code: 'unavailable',
            safeMessage: 'The provider was unreachable.',
          },
          compensationState: 'not_required',
        },
      } as never,
    });
  }

  function replayRequest(originalEventId: string, instanceId: string) {
    return {
      eventId: randomUUID(),
      schemaName: 'provisioning.replay.requested',
      schemaVersion: 1,
      aggregateType: 'instance',
      aggregateId: instanceId,
      projectId,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      traceContext: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
      partitionKey: instanceId,
      data: {
        replayRequestId: randomUUID(),
        originalEventId,
        requestedAt: new Date().toISOString(),
      },
    } as never;
  }

  it('authorizes a replay by writing durable authority and the restored command', async () => {
    const input = command();
    await exhaustToDeadLetter(input);

    const outcome = await store.admitReplayRequest(
      replayRequest(input.eventId, input.aggregateId),
      delivery(),
    );
    expect(outcome).toBe('accepted');

    const authorization = await db
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();
    expect(authorization.status).toBe('authorized');
    expect(authorization.replay_generation).toBe(1);

    // The authorized command must be published, not applied directly. Its outbox row is the
    // physical identity the later admission has to match.
    const outbox = await db
      .selectFrom('workflow.outbox')
      .selectAll()
      .where('topic', '=', 'provisioning.commands.v1')
      .executeTakeFirstOrThrow();
    expect(outbox.outbox_id).toBe(authorization.authorized_outbox_id);
    expect(outbox.replay_generation).toBe(1);

    // The workflow stays failed until the command comes back through Kafka.
    const workflow = await db
      .selectFrom('workflow.workflows')
      .selectAll()
      .where('operation_id', '=', input.operationId)
      .executeTakeFirstOrThrow();
    expect(workflow.status).toBe('failed');
  });

  it('reopens the workflow only for a delivery matching generation, hash, and outbox id', async () => {
    const input = command();
    await exhaustToDeadLetter(input);
    await store.admitReplayRequest(replayRequest(input.eventId, input.aggregateId), delivery());
    const authorization = await db
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();
    const outbox = await db
      .selectFrom('workflow.outbox')
      .selectAll()
      .where('outbox_id', '=', authorization.authorized_outbox_id ?? '')
      .executeTakeFirstOrThrow();
    const restored = outbox.payload as unknown as InstanceCreateRequestedV1;

    const admission = await store.admitCommand(
      restored,
      delivery({ replayGeneration: 1, outboxId: outbox.outbox_id }),
    );
    expect(admission).toEqual({ outcome: 'accepted' });

    const workflow = await db
      .selectFrom('workflow.workflows')
      .selectAll()
      .where('operation_id', '=', input.operationId)
      .executeTakeFirstOrThrow();
    expect(workflow.status).toBe('running');
    expect(workflow.replay_generation).toBe(1);
  });

  it('quarantines a replay command whose physical outbox identity does not match authority', async () => {
    const input = command();
    await exhaustToDeadLetter(input);
    await store.admitReplayRequest(replayRequest(input.eventId, input.aggregateId), delivery());
    const authorization = await db
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();
    const outbox = await db
      .selectFrom('workflow.outbox')
      .selectAll()
      .where('outbox_id', '=', authorization.authorized_outbox_id ?? '')
      .executeTakeFirstOrThrow();
    const restored = outbox.payload as unknown as InstanceCreateRequestedV1;

    // Everything matches except the physical outbox row it claims to come from.
    const admission = await store.admitCommand(
      restored,
      delivery({ replayGeneration: 1, outboxId: randomUUID() }),
    );
    expect(admission).toEqual({
      outcome: 'rejected',
      failureCode: 'REPLAY_COMMAND_UNAUTHORIZED',
    });

    const poison = await db.selectFrom('workflow.poison_records').selectAll().execute();
    expect(poison).toHaveLength(1);
    expect(poison[0]?.failure_code).toBe('REPLAY_COMMAND_UNAUTHORIZED');

    // The authority must survive so an operator can still see it was never consumed.
    const unchanged = await db
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();
    expect(unchanged.status).toBe('authorized');
    const workflow = await db
      .selectFrom('workflow.workflows')
      .selectAll()
      .where('operation_id', '=', input.operationId)
      .executeTakeFirstOrThrow();
    expect(workflow.status).toBe('failed');
  });

  it('rejects a replay request for a dead letter that does not allow it', async () => {
    const input = command();
    await exhaustToDeadLetter(input);
    await db
      .updateTable('workflow.dead_letters')
      .set({ replay_allowed: false })
      .where('original_event_id', '=', input.eventId)
      .execute();

    const outcome = await store.admitReplayRequest(
      replayRequest(input.eventId, input.aggregateId),
      delivery(),
    );
    expect(outcome).toBe('rejected');
    const authorization = await db
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();
    expect(authorization.status).toBe('rejected');
    expect(
      await db
        .selectFrom('workflow.outbox')
        .selectAll()
        .where('topic', '=', 'provisioning.commands.v1')
        .execute(),
    ).toEqual([]);
  });

  it('deduplicates a repeated replay request delivery', async () => {
    const input = command();
    await exhaustToDeadLetter(input);
    const request = replayRequest(input.eventId, input.aggregateId);
    const first = await store.admitReplayRequest(request, delivery());
    const second = await store.admitReplayRequest(request, delivery());

    expect(first).toBe('accepted');
    expect(second).toBe('duplicate');
    const authorizations = await db
      .selectFrom('workflow.replay_requests')
      .selectAll()
      .where('original_event_id', '=', input.eventId)
      .execute();
    expect(authorizations).toHaveLength(1);
  });
});

/** Minimal well-formed progress event for advancing a workflow under test. */
function progressEvent(input: InstanceCreateRequestedV1, stage: string) {
  return {
    eventId: randomUUID(),
    schemaName: 'workflow.progressed',
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: input.aggregateId,
    projectId: input.projectId,
    operationId: input.operationId,
    correlationId: input.correlationId,
    causationId: input.eventId,
    occurredAt: new Date().toISOString(),
    traceContext: input.traceContext,
    partitionKey: input.partitionKey,
    data: { stage, attempt: 1, operationState: 'running' },
  } as never;
}
