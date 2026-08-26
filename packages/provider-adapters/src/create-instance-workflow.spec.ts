import {
  CreateInstanceWorkflow,
  type ClaimedCreateWorkflow,
  type WorkflowEvent,
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
  public stage = 'accepted';
  public attempt = 0;
  public fencingToken = 0n;
  public providerResourceId: string | undefined;
  public providerTaskReference: string | undefined;
  public terminal: 'failed' | 'manual_review' | 'succeeded' | undefined;
  public readonly events: WorkflowEvent[] = [];

  public constructor(private readonly failCheckpointStage?: string) {}

  private checkpointFailed = false;

  public claimNextCreate(): Promise<ClaimedCreateWorkflow | null> {
    if (this.terminal) return Promise.resolve(null);
    this.attempt += 1;
    this.fencingToken += 1n;
    return Promise.resolve({
      command,
      stage: this.stage,
      attempt: this.attempt,
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
});
