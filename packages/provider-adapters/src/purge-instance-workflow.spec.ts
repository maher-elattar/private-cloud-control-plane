/**
 * Unit coverage for the power capability against the deterministic fake.
 *
 * Lives here rather than in `packages/application` because the Nx layer tags forbid
 * `layer:application` depending on `layer:adapter`, and these need `FakeProvider`.
 *
 * The mutation-stage assertion is the one that matters most. `handleProviderError` routes a
 * transport failure in a mutation stage to `manual_review` instead of retrying it, so a capability
 * that declared the wrong set could re-issue a hard stop against a VM that had already taken one.
 */
import { describe, expect, it } from 'vitest';
import {
  PurgeInstanceWorkflow,
  type ClaimedWorkflow,
  type CommandAdmission,
  type WorkflowEvent,
  type WorkflowStage,
  type WorkflowStore,
} from '@private-cloud/application';
import type { InstancePurgeRequestedV1 } from '@private-cloud/contracts';
import { FakeProvider } from './fake-provider.js';

/** The operation that created the VM, and therefore the one in its ownership markers. */
const CREATE_OPERATION_ID = '00000000-0000-4000-8000-0000000000c1';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000012';
const PROJECT_ID = '00000000-0000-4000-8000-000000000013';

/**
 * Creates an owned VM in the fake, as a prior create workflow would have.
 *
 * Power acts on an existing resource, so a bare fake has nothing to act on. Building the resource
 * through the real create call rather than seeding internal state keeps the ownership markers
 * exactly as a genuine create would have written them — which is the thing under test.
 */
async function seedOwnedInstance(provider: FakeProvider): Promise<string> {
  const response = await provider.submitCreateInstance({
    context: {
      requestId: `${CREATE_OPERATION_ID}:create`,
      operationId: CREATE_OPERATION_ID,
      correlationId: '00000000-0000-4000-8000-000000000015',
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      providerProfileId: 'fake-lab',
      attempt: 1,
    },
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    hostname: 'power-test',
    resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
    network: {
      networkId: 'lab-primary',
      ipv4Address: '192.0.2.5',
      ipv4PrefixLength: 27,
      ipv4Gateway: '192.0.2.1',
      dnsServers: ['192.0.2.53'],
    },
    sshPublicKeys: [],
    ownershipMarkers: {
      managedBy: 'private-cloud-control-plane',
      environment: 'lab',
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      createOperationId: CREATE_OPERATION_ID,
    },
  });
  return response.result?.providerResourceId ?? '';
}

function command(): InstancePurgeRequestedV1 {
  return {
    eventId: '00000000-0000-4000-8000-000000000011',
    schemaName: 'instance.purge.requested',
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: '00000000-0000-4000-8000-000000000012',
    projectId: '00000000-0000-4000-8000-000000000013',
    operationId: '00000000-0000-4000-8000-000000000014',
    correlationId: '00000000-0000-4000-8000-000000000015',
    causationId: '00000000-0000-4000-8000-000000000014',
    occurredAt: '2026-09-04T00:00:00.000Z',
    traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    partitionKey: '00000000-0000-4000-8000-000000000012',
    data: {
      purgeAuthorizationId: '00000000-0000-4000-8000-0000000000e1',
      retentionDeadline: '2026-09-01T00:00:00.000Z',
      reasonReference: '00000000-0000-4000-8000-0000000000e1',
      providerProfileId: 'fake-lab',
      createOperationId: CREATE_OPERATION_ID,
    },
  } as InstancePurgeRequestedV1;
}

/** Minimal in-memory store that records the transitions a workflow performs. */
class MemoryWorkflowStore implements WorkflowStore {
  public stage: WorkflowStage = 'accepted';
  public fencingToken = 0n;
  public providerResourceId = '910001';
  public providerTaskReference: string | undefined;
  public terminal: 'failed' | 'manual_review' | 'succeeded' | undefined;
  public terminalCode: string | undefined;
  public readonly events: WorkflowEvent[] = [];

  public constructor(private readonly power: InstancePurgeRequestedV1) {}

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
    this.fencingToken += 1n;
    return Promise.resolve({
      action: 'purge_instance' as const,
      command: this.power,
      traceContext: this.power.traceContext,
      stage: this.stage,
      attempt: 1,
      stageAttempt: 0,
      fencingToken: this.fencingToken,
      providerResourceId: this.providerResourceId,
      ...(this.providerTaskReference ? { providerTaskReference: this.providerTaskReference } : {}),
    });
  }

  public checkpoint(input: {
    readonly stage: WorkflowStage;
    readonly event: WorkflowEvent;
    readonly providerTaskReference?: string | null;
  }) {
    this.stage = input.stage;
    // `null` clears a completed handle; omitting the field leaves the current one in place.
    if (input.providerTaskReference !== undefined) {
      this.providerTaskReference = input.providerTaskReference ?? undefined;
    }
    this.events.push(input.event);
    return Promise.resolve();
  }

  public deadLetterWorkflow(): Promise<void> {
    this.terminal = 'failed';
    return Promise.resolve();
  }

  public complete(input: {
    readonly status: 'succeeded' | 'failed' | 'manual_review';
    readonly event: WorkflowEvent;
  }): Promise<void> {
    this.terminal = input.status;
    this.events.push(input.event);
    const data = (input.event as { readonly data?: { readonly failure?: { code?: string } } }).data;
    this.terminalCode = data?.failure?.code;
    return Promise.resolve();
  }
}

/** Drives the workflow until it reaches a terminal state or runs out of turns. */
async function drive(store: MemoryWorkflowStore, provider: FakeProvider): Promise<void> {
  store.providerResourceId = await seedOwnedInstance(provider);
  const workflow = new PurgeInstanceWorkflow(store, provider, 'worker-test');
  for (let turn = 0; turn < 12 && !store.terminal; turn += 1) {
    if (!(await workflow.runOne())) break;
  }
}

describe('PurgeInstanceWorkflow', () => {
  it('declares only the submit stage as a mutation', () => {
    // `verifying_purge` is a read and must stay retryable: a transport failure while verifying
    // should send the workflow round again, not to manual review. Submitting is the opposite.
    const workflow = new PurgeInstanceWorkflow(
      new MemoryWorkflowStore(command()),
      new FakeProvider(),
      'worker-test',
    );
    const stages = (workflow as unknown as { mutationStages: readonly WorkflowStage[] })
      .mutationStages;
    expect([...stages]).toEqual(['submitting_purge']);
    expect(workflow.action).toBe('purge_instance');
  });

  it('destroys an owned instance and confirms its absence', async () => {
    const store = new MemoryWorkflowStore(command());
    await drive(store, new FakeProvider());
    expect(store.terminal).toBe('succeeded');
  });

  it('treats an already-absent instance as success without submitting a purge', async () => {
    // The goal of a purge is absence, and absence has been achieved. Submitting anyway would be a
    // destructive call against a VMID that may since belong to someone else.
    const store = new MemoryWorkflowStore(command());
    const provider = new FakeProvider();
    // No seeded resource: the first observation reports the instance missing.
    const workflow = new PurgeInstanceWorkflow(store, provider, 'worker-test');
    for (let turn = 0; turn < 12 && !store.terminal; turn += 1) {
      if (!(await workflow.runOne())) break;
    }
    expect(store.terminal).toBe('succeeded');
    expect(provider.calls.filter((call) => call.method === 'purgeInstance')).toHaveLength(0);
  });

  it('sends an unknown purge outcome to manual review rather than retrying it', async () => {
    const store = new MemoryWorkflowStore(command());
    const provider = new FakeProvider({ script: { purgeInstance: [{ mode: 'unknown-outcome' }] } });
    store.providerResourceId = await seedOwnedInstance(provider);
    const workflow = new PurgeInstanceWorkflow(store, provider, 'worker-test');
    for (let turn = 0; turn < 12 && !store.terminal; turn += 1) {
      if (!(await workflow.runOne())) break;
    }
    expect(store.terminal).toBe('manual_review');
  });
});
