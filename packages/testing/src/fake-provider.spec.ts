import { ObservedPowerState } from '@private-cloud/contracts';
import {
  ProviderResultState,
  ProviderTaskState,
  type ObserveInstanceRequest,
  type OwnershipMarkers,
  type SubmitCreateInstanceRequest,
} from '@private-cloud/contracts/provider';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake-provider.js';

const ownership: OwnershipMarkers = {
  managedBy: 'private-cloud-control-plane',
  environment: 'test',
  projectId: 'project-1',
  instanceId: 'instance-1',
  createOperationId: 'operation-1',
};

function createRequest(requestId = 'request-create-1'): SubmitCreateInstanceRequest {
  return {
    context: {
      requestId,
      operationId: 'operation-1',
      correlationId: 'correlation-1',
      projectId: 'project-1',
      instanceId: 'instance-1',
      providerProfileId: 'provider-profile-1',
      attempt: 1,
    },
    imageId: 'image-1',
    flavorId: 'flavor-1',
    hostname: 'web-01',
    resources: { cpuCount: 2, memoryMib: '4096', diskGib: '40' },
    network: {
      networkId: 'network-1',
      ipv4Address: '192.0.2.10',
      ipv4PrefixLength: 24,
      ipv4Gateway: '192.0.2.1',
      dnsServers: ['192.0.2.53'],
    },
    ownershipMarkers: ownership,
  };
}

function observationRequest(
  providerResourceId: string | undefined,
  requestId = 'request-observe-1',
): ObserveInstanceRequest {
  return {
    context: {
      requestId,
      operationId: 'operation-observe-1',
      correlationId: 'correlation-1',
      projectId: 'project-1',
      instanceId: 'instance-1',
      providerProfileId: 'provider-profile-1',
      attempt: 1,
    },
    ...(providerResourceId ? { providerResourceId } : {}),
    expectedOwnershipMarkers: ownership,
  };
}

describe('provider port conformance', () => {
  it('returns an accepted task and a provider-neutral observation', async () => {
    const provider = new FakeProvider({ defaultTaskPollsBeforeSuccess: 1 });
    const created = await provider.submitCreateInstance(createRequest());

    expect(created.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    expect(created.result?.providerResourceId).toMatch(/^fake-resource-/);
    expect(created.result?.providerTaskReference).toMatch(/^fake-task-/);

    const firstPoll = await provider.getTask({
      context: { ...createRequest().context, requestId: 'request-task-1' },
      providerTaskReference: created.result?.providerTaskReference,
    });
    const secondPoll = await provider.getTask({
      context: { ...createRequest().context, requestId: 'request-task-2' },
      providerTaskReference: created.result?.providerTaskReference,
    });
    const observed = await provider.observeInstance(
      observationRequest(created.result?.providerResourceId),
    );

    expect(firstPoll.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_RUNNING);
    expect(secondPoll.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED);
    expect(observed.observation).toMatchObject({
      exists: true,
      powerState: ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
      ownership: { complete: true, match: true },
    });
  });

  it('deduplicates a repeated mutation before consuming another scripted step', async () => {
    const provider = new FakeProvider({
      script: {
        submitCreateInstance: [{ mode: 'success' }, { mode: 'failure' }],
      },
    });
    const request = createRequest();
    const first = await provider.submitCreateInstance(request);
    const duplicate = await provider.submitCreateInstance(request);

    expect(duplicate).toEqual(first);
    expect(provider.resourceCount()).toBe(1);
    expect(provider.logicalMutationCount('submitCreateInstance')).toBe(1);
    expect(provider.calls.at(-1)?.duplicate).toBe(true);
  });

  it('rejects request identity reuse with different canonical input', async () => {
    const provider = new FakeProvider();
    await provider.submitCreateInstance(createRequest());

    await expect(
      provider.submitCreateInstance({ ...createRequest(), hostname: 'different-host' }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      retryable: false,
    });
  });

  it('injects deterministic latency without relying on wall-clock time', async () => {
    const delays: number[] = [];
    const provider = new FakeProvider({
      defaultLatencyMs: 125,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    await provider.getCapabilities({ requestId: 'request-capabilities-1' });
    expect(delays).toEqual([125]);
  });

  it('returns a classified provider rejection', async () => {
    const provider = new FakeProvider({
      script: {
        submitCreateInstance: [{ mode: 'failure', failureCode: 'CAPACITY_EXHAUSTED' }],
      },
    });

    const result = await provider.submitCreateInstance(createRequest());
    expect(result.result).toMatchObject({
      state: ProviderResultState.PROVIDER_RESULT_STATE_REJECTED,
      failure: { code: 'CAPACITY_EXHAUSTED' },
    });
    expect(provider.resourceCount()).toBe(0);
  });

  it('models a timeout before the provider applies a mutation', async () => {
    const provider = new FakeProvider({
      script: { submitCreateInstance: [{ mode: 'timeout' }] },
    });

    await expect(provider.submitCreateInstance(createRequest())).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(provider.resourceCount()).toBe(0);
  });

  it('models a lost response after mutation and deduplicates the retry', async () => {
    const provider = new FakeProvider({
      script: {
        submitCreateInstance: [{ mode: 'timeout', applyBeforeResponse: true }],
      },
    });
    const request = createRequest();

    await expect(provider.submitCreateInstance(request)).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    const retry = await provider.submitCreateInstance(request);

    expect(retry.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    expect(provider.resourceCount()).toBe(1);
    expect(provider.logicalMutationCount('submitCreateInstance')).toBe(1);
  });

  it('exposes an applied unknown outcome through observation without changing retry identity', async () => {
    const provider = new FakeProvider({
      script: {
        submitCreateInstance: [{ mode: 'unknown-outcome', applyBeforeResponse: true }],
      },
    });
    const request = createRequest();
    const result = await provider.submitCreateInstance(request);
    const retry = await provider.submitCreateInstance(request);
    const observation = await provider.observeInstance(observationRequest(undefined));

    expect(result.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_UNKNOWN);
    expect(retry).toEqual(result);
    expect(observation.observation?.exists).toBe(true);
    expect(provider.resourceCount()).toBe(1);
  });
});
