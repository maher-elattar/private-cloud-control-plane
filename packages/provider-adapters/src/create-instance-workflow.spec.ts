import {
  CreateInstanceWorkflow,
  type ClaimedWorkflow,
  type CommandAdmission,
  type WorkflowEvent,
  type WorkflowStage,
  type WorkflowStore,
} from '@private-cloud/application';
import type { InstanceCreateRequestedV1 } from '@private-cloud/contracts';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake-provider.js';

const command: InstanceCreateRequestedV1 = {
  eventId: '00000000-0000-4000-8000-000000000001',
  schemaName: 'instance.create.requested',
  schemaVersion: 1,
  aggregateType: 'instance',
  aggregateId: '00000000-0000-4000-8000-000000000002',
  projectId: '00000000-0000-4000-8000-000000000003',
  operationId: '00000000-0000-4000-8000-000000000004',
  correlationId: '00000000-0000-4000-8000-000000000005',
  causationId: '00000000-0000-4000-8000-000000000004',
  occurredAt: '2026-08-26T00:00:00.000Z',
  traceContext: {
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  },
  partitionKey: '00000000-0000-4000-8000-000000000002',
  data: {
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    networkId: 'lab-primary',
    providerProfileId: 'fake-lab',
    hostname: 'workflow-test',
    resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 },
    ipv4: {
      address: '192.0.2.5',
      prefixLength: 27,
      gateway: '192.0.2.1',
      dnsServers: ['192.0.2.53'],
    },
  },
};

class MemoryWorkflowStore implements WorkflowStore {
  public stage: WorkflowStage = 'accepted';
  public attempt = 0;
  public stageAttempt = 0;
  public retryStartedAt: Date | undefined;
  public fencingToken = 0n;
  public providerResourceId: string | undefined;
  public providerTaskReference: string | undefined;
  public terminal: 'failed' | 'manual_review' | 'succeeded' | undefined;
  public readonly events: WorkflowEvent[] = [];
  public readonly retryTimes: Date[] = [];
  public readonly deadLetters: Parameters<WorkflowStore['deadLetterWorkflow']>[0][] = [];

  public constructor(private readonly failCheckpointStage?: WorkflowStage) {}

  private checkpointFailed = false;

  public admitCommand(): Promise<CommandAdmission> {
    return Promise.resolve({ outcome: 'accepted' });
  }

  public admitReplayRequest(): Promise<'accepted' | 'duplicate' | 'rejected'> {
    return Promise.resolve('accepted');
  }

  public quarantineRecord(): Promise<'quarantined' | 'duplicate'> {
    return Promise.resolve('quarantined');
  }

  public deadLetterCommand(): Promise<'dead_lettered' | 'duplicate'> {
    return Promise.resolve('dead_lettered');
  }

  public claimNext(): Promise<ClaimedWorkflow | null> {
    if (this.terminal) return Promise.resolve(null);
    this.attempt += 1;
    this.fencingToken += 1n;
    return Promise.resolve({
      action: 'create_instance' as const,
      command,
      traceContext: command.traceContext,
      stage: this.stage,
      attempt: this.attempt,
      stageAttempt: this.stageAttempt,
      ...(this.retryStartedAt ? { retryStartedAt: this.retryStartedAt } : {}),
      fencingToken: this.fencingToken,
      ...(this.providerResourceId ? { providerResourceId: this.providerResourceId } : {}),
      ...(this.providerTaskReference ? { providerTaskReference: this.providerTaskReference } : {}),
    });
  }

  public checkpoint(input: Parameters<WorkflowStore['checkpoint']>[0]): Promise<void> {
    this.assertFence(input.fencingToken);
    if (input.stage === this.failCheckpointStage && !this.checkpointFailed) {
      this.checkpointFailed = true;
      return Promise.reject(new Error('injected checkpoint failure'));
    }
    this.stage = input.stage;
    if (input.providerResourceId) this.providerResourceId = input.providerResourceId;
    if ('providerTaskReference' in input) {
      this.providerTaskReference = input.providerTaskReference ?? undefined;
    }
    this.stageAttempt = input.retry?.attempt ?? 0;
    this.retryStartedAt = input.retry?.startedAt;
    if (input.nextAttemptAt) this.retryTimes.push(input.nextAttemptAt);
    this.events.push(input.event);
    return Promise.resolve();
  }

  public deadLetterWorkflow(
    input: Parameters<WorkflowStore['deadLetterWorkflow']>[0],
  ): Promise<void> {
    this.assertFence(input.fencingToken);
    this.stageAttempt = input.attempts;
    this.terminal = 'failed';
    this.deadLetters.push(input);
    this.events.push(input.event);
    return Promise.resolve();
  }

  public complete(input: Parameters<WorkflowStore['complete']>[0]): Promise<void> {
    this.assertFence(input.fencingToken);
    this.terminal = input.status;
    this.events.push(input.event);
    return Promise.resolve();
  }

  private assertFence(value: bigint): void {
    if (value !== this.fencingToken) throw new Error('stale fencing token');
  }
}

async function drain(workflow: CreateInstanceWorkflow, maximumSteps = 20): Promise<void> {
  for (let step = 0; step < maximumSteps; step += 1) {
    if (!(await workflow.runOne())) return;
  }
  throw new Error('Workflow did not reach a terminal state.');
}

describe('CreateInstanceWorkflow', () => {
  it('checkpoints every fake-provider task and completes after owned running observation', async () => {
    const store = new MemoryWorkflowStore();
    const provider = new FakeProvider({ defaultTaskPollsBeforeSuccess: 0 });
    await drain(new CreateInstanceWorkflow(store, provider, 'worker-1'));

    expect(store.terminal).toBe('succeeded');
    expect(store.stage).toBe('observing');
    expect(provider.resourceCount()).toBe(1);
    expect(provider.logicalMutationCount('submitCreateInstance')).toBe(1);
    expect(provider.logicalMutationCount('applyInstanceConfiguration')).toBe(1);
    expect(provider.logicalMutationCount('startInstance')).toBe(1);
    expect(store.events.at(-1)?.schemaName).toBe('instance.mutation.completed');
  });

  it('replays the same provider request after a post-mutation checkpoint failure', async () => {
    const store = new MemoryWorkflowStore('polling_create');
    const provider = new FakeProvider({ defaultTaskPollsBeforeSuccess: 0 });
    const workflow = new CreateInstanceWorkflow(store, provider, 'worker-1');

    expect(await workflow.runOne()).toBe(true);
    await expect(workflow.runOne()).rejects.toThrow('injected checkpoint failure');
    await drain(workflow);

    const submits = provider.calls.filter((call) => call.method === 'submitCreateInstance');
    expect(submits).toHaveLength(2);
    expect(submits[1]?.duplicate).toBe(true);
    expect(provider.resourceCount()).toBe(1);
    expect(store.terminal).toBe('succeeded');
  });

  it('uses persisted full-jitter delays and dead-letters the eighth safe failure', async () => {
    const store = new MemoryWorkflowStore();
    const provider = new FakeProvider({ script: { getTask: [{ mode: 'failure' }] } });
    const now = new Date('2026-08-30T00:00:00.000Z');
    const workflow = new CreateInstanceWorkflow(store, provider, 'worker-1', undefined, {
      now: () => now,
      random: () => 0.999,
    });

    await drain(workflow);

    expect(provider.calls.filter((call) => call.method === 'getTask')).toHaveLength(8);
    expect(store.retryTimes.map((value) => value.getTime() - now.getTime())).toEqual([
      499, 999, 1_998, 3_996, 7_992, 15_984, 29_970,
    ]);
    expect(store.stageAttempt).toBe(8);
    expect(store.terminal).toBe('failed');
    expect(store.deadLetters).toHaveLength(1);
    expect(store.deadLetters[0]?.failureCode).toBe('WORKFLOW_RETRY_EXHAUSTED');
    expect(store.deadLetters[0]?.lastErrorCode).toBe('unavailable');
  });

  it('exhausts the persisted retry budget even before eight failures', async () => {
    const store = new MemoryWorkflowStore();
    const provider = new FakeProvider({ script: { getTask: [{ mode: 'timeout' }] } });
    let now = new Date('2026-08-30T00:00:00.000Z');
    const workflow = new CreateInstanceWorkflow(store, provider, 'worker-1', undefined, {
      now: () => now,
      random: () => 0,
    });

    await workflow.runOne();
    await workflow.runOne();
    await workflow.runOne();
    expect(store.stageAttempt).toBe(1);

    now = new Date(now.getTime() + 15 * 60 * 1_000);
    await workflow.runOne();

    expect(store.terminal).toBe('failed');
    expect(store.deadLetters[0]?.attempts).toBe(2);
  });

  it('resets persisted retry state after a provider call succeeds', async () => {
    const store = new MemoryWorkflowStore();
    const provider = new FakeProvider({
      script: { getTask: [{ mode: 'failure' }, { mode: 'success' }] },
    });
    const workflow = new CreateInstanceWorkflow(store, provider, 'worker-1', undefined, {
      random: () => 0,
    });

    await workflow.runOne();
    await workflow.runOne();
    await workflow.runOne();
    expect(store.stageAttempt).toBe(1);
    await workflow.runOne();

    expect(store.stage).toBe('configuring');
    expect(store.stageAttempt).toBe(0);
    expect(store.retryStartedAt).toBeUndefined();
  });

  it('routes an ambiguous mutation transport outcome directly to manual review', async () => {
    const store = new MemoryWorkflowStore();
    const provider = new FakeProvider({ script: { submitCreateInstance: [{ mode: 'timeout' }] } });
    const workflow = new CreateInstanceWorkflow(store, provider, 'worker-1');

    await workflow.runOne();
    await workflow.runOne();

    expect(store.terminal).toBe('manual_review');
    expect(store.deadLetters).toHaveLength(0);
  });
});

/**
 * The rule that decides whether a replay under a new lease is recognised as a duplicate.
 *
 * Both halves matter. Without the first, a workflow that legitimately resumed under a new claim
 * would be rejected by its provider and its instance abandoned. Without the second, a genuinely
 * different request could ride in on a reused identifier and the provider would answer it with a
 * cached result for work it never did.
 */
describe('provider idempotency under a moving lease', () => {
  const context = {
    requestId: 'operation-1:submit',
    operationId: '00000000-0000-4000-8000-000000000004',
    correlationId: '00000000-0000-4000-8000-000000000005',
    projectId: '00000000-0000-4000-8000-000000000003',
    instanceId: '00000000-0000-4000-8000-000000000002',
    providerProfileId: 'fake-lab',
    attempt: 1,
  };
  const request = {
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    hostname: 'fence-01',
    resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
    network: {
      networkId: 'lab-primary',
      ipv4Address: '192.0.2.4',
      ipv4PrefixLength: 27,
      ipv4Gateway: '192.0.2.1',
      dnsServers: ['192.0.2.2'],
    },
    sshPublicKeys: [],
    ownershipMarkers: {
      managedBy: 'private-cloud-control-plane',
      projectId: '00000000-0000-4000-8000-000000000003',
      instanceId: '00000000-0000-4000-8000-000000000002',
      createOperationId: '00000000-0000-4000-8000-000000000004',
      environment: 'lab',
    },
  };

  it('treats a changed fencing token as the same request', async () => {
    const provider = new FakeProvider({ defaultTaskPollsBeforeSuccess: 0 });

    await provider.submitCreateInstance({ ...request, context: { ...context, fencingToken: '1' } });
    await provider.submitCreateInstance({ ...request, context: { ...context, fencingToken: '2' } });

    const submits = provider.calls.filter((call) => call.method === 'submitCreateInstance');
    expect(submits).toHaveLength(2);
    expect(submits[1]?.duplicate).toBe(true);
    // The one assertion that matters: no second VM.
    expect(provider.resourceCount()).toBe(1);
  });

  it('still refuses a reused request id that carries different intent', async () => {
    const provider = new FakeProvider({ defaultTaskPollsBeforeSuccess: 0 });

    await provider.submitCreateInstance({ ...request, context: { ...context, fencingToken: '1' } });

    await expect(
      provider.submitCreateInstance({
        ...request,
        hostname: 'fence-02',
        context: { ...context, fencingToken: '2' },
      }),
    ).rejects.toThrow('was reused with different input');
    expect(provider.resourceCount()).toBe(1);
  });
});
