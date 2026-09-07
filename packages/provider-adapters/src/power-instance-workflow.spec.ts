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
  PowerInstanceWorkflow,
  type ClaimedWorkflow,
  type CommandAdmission,
  type WorkflowEvent,
  type WorkflowStage,
  type WorkflowStore,
} from '@private-cloud/application';
import type { InstancePowerRequestedV1 } from '@private-cloud/contracts';
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

function command(action: string): InstancePowerRequestedV1 {
  return {
    eventId: '00000000-0000-4000-8000-000000000011',
    schemaName: 'instance.power.requested',
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
    data: { action, providerProfileId: 'fake-lab', createOperationId: CREATE_OPERATION_ID },
  } as InstancePowerRequestedV1;
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

  public constructor(private readonly power: InstancePowerRequestedV1) {}

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
      action: 'power_instance' as const,
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
  const workflow = new PowerInstanceWorkflow(store, provider, 'worker-test');
  for (let turn = 0; turn < 12 && !store.terminal; turn += 1) {
    if (!(await workflow.runOne())) break;
  }
}

describe('PowerInstanceWorkflow', () => {
  it('declares only the submit stage as a mutation', () => {
    // The polling and observing stages are reads and are safe to repeat. Widening this set would
    // make a retryable failure look ambiguous; narrowing it would let a hard stop be re-issued.
    const workflow = new PowerInstanceWorkflow(
      new MemoryWorkflowStore(command('stop')),
      new FakeProvider(),
      'worker-test',
    );
    const stages = (workflow as unknown as { mutationStages: readonly WorkflowStage[] })
      .mutationStages;
    expect([...stages]).toEqual(['submitting_power']);
    expect(workflow.action).toBe('power_instance');
  });

  it.each(['start', 'shutdown', 'stop', 'reboot'])(
    'completes a %s transition once the provider reports the requested state',
    async (action) => {
      const store = new MemoryWorkflowStore(command(action));
      await drive(store, new FakeProvider());
      expect(store.terminal).toBe('succeeded');
    },
  );

  it('sends a rejected transition to terminal failure, not manual review', async () => {
    // A refusal is conclusive: the provider is saying it did not act, so nothing is ambiguous.
    const store = new MemoryWorkflowStore(command('start'));
    await drive(
      store,
      new FakeProvider({
        script: { startInstance: [{ mode: 'failure', failureCode: 'REJECTED' }] },
      }),
    );
    expect(store.terminal).toBe('failed');
  });

  it('sends an unknown mutation outcome to manual review rather than retrying it', async () => {
    // The provider cannot say whether the transition applied. Retrying a stop in that state could
    // cut power to a VM that had already been stopped and restarted by someone else.
    const store = new MemoryWorkflowStore(command('stop'));
    await drive(
      store,
      new FakeProvider({ script: { stopInstance: [{ mode: 'unknown-outcome' }] } }),
    );
    expect(store.terminal).toBe('manual_review');
  });

  it('records the create operation in the ownership markers, not its own', async () => {
    // The markers on the VM were written by create. Presenting this power operation's id instead
    // would make the provider refuse to touch a resource this control plane genuinely owns.
    const store = new MemoryWorkflowStore(command('start'));
    const provider = new FakeProvider();
    await drive(store, provider);
    expect(store.terminal).toBe('succeeded');
    // Every provider call after the seeded create belongs to the power workflow, and none was
    // refused for ownership — which is only possible if the create operation id was presented.
    expect(provider.calls.filter((call) => call.method === 'startInstance')).toHaveLength(1);
  });
});
