import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@private-cloud/contracts';
import {
  isInstanceCreateRequestedV1,
  isInstanceMutationCompletedV1,
  isInstanceMutationFailedV1,
  isProvisioningDeadLetteredV1,
  isProvisioningReplayRequestedV1,
  isProvisioningReplayResolvedV1,
  isWorkflowProgressedV1,
} from './event-validation.js';

const envelope: EventEnvelope & { data: Record<string, unknown> } = {
  eventId: '10000000-0000-4000-8000-000000000001',
  schemaName: 'instance.create.requested',
  schemaVersion: 1,
  aggregateType: 'instance',
  aggregateId: '20000000-0000-4000-8000-000000000001',
  projectId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  correlationId: '50000000-0000-4000-8000-000000000001',
  causationId: '60000000-0000-4000-8000-000000000001',
  occurredAt: '2026-08-27T00:00:00.000Z',
  traceContext: {
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  },
  partitionKey: '20000000-0000-4000-8000-000000000001',
  data: {
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    networkId: 'lab-primary',
    providerProfileId: 'fake-lab',
    hostname: 'web-01',
    resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 },
    ipv4: {
      address: '192.0.2.10',
      prefixLength: 27,
      gateway: '192.0.2.1',
      dnsServers: ['192.0.2.53'],
    },
  },
};

describe('isInstanceCreateRequestedV1', () => {
  it('accepts the complete supported command contract', () => {
    expect(isInstanceCreateRequestedV1(envelope)).toBe(true);
  });

  it('rejects a future schema version until this deployment supports it', () => {
    expect(isInstanceCreateRequestedV1({ ...envelope, schemaVersion: 2 })).toBe(false);
  });

  it('rejects an incomplete resource or network payload', () => {
    expect(
      isInstanceCreateRequestedV1({
        ...envelope,
        data: { ...envelope.data, resources: { cpuCount: 2 } },
      }),
    ).toBe(false);
  });
});

describe('isProvisioningReplayResolvedV1', () => {
  const resolution = {
    ...envelope,
    schemaName: 'provisioning.replay.resolved',
    data: {
      replayRequestId: '70000000-0000-4000-8000-000000000001',
      originalEventId: envelope.eventId,
      outcome: 'rejected',
      replayGeneration: 0,
      resolvedAt: '2026-08-27T01:00:00.000Z',
    },
  };

  it('accepts a complete resolution fact', () => {
    expect(isProvisioningReplayResolvedV1(resolution)).toBe(true);
  });

  it('rejects malformed identities and generations', () => {
    expect(
      isProvisioningReplayResolvedV1({
        ...resolution,
        data: { ...resolution.data, replayRequestId: 'not-a-uuid' },
      }),
    ).toBe(false);
    expect(
      isProvisioningReplayResolvedV1({
        ...resolution,
        data: { ...resolution.data, replayGeneration: -1 },
      }),
    ).toBe(false);
  });
});

describe('projection event validators', () => {
  it('accepts complete progress, completion, failure, replay, and dead-letter facts', () => {
    expect(
      isWorkflowProgressedV1({
        ...envelope,
        schemaName: 'workflow.progressed',
        data: { stage: 'configuring', attempt: 1, operationState: 'running' },
      }),
    ).toBe(true);
    expect(
      isInstanceMutationCompletedV1({
        ...envelope,
        schemaName: 'instance.mutation.completed',
        data: {
          action: 'create_instance',
          lifecycleState: 'active',
          providerResourceId: 'fake-resource-000001',
          evidenceId: '70000000-0000-4000-8000-000000000001',
        },
      }),
    ).toBe(true);
    expect(
      isInstanceMutationFailedV1({
        ...envelope,
        schemaName: 'instance.mutation.failed',
        data: {
          action: 'create_instance',
          failure: { category: 'permanent', code: 'FAILED', safeMessage: 'Create failed.' },
          compensationState: 'not_required',
        },
      }),
    ).toBe(true);
    expect(
      isProvisioningReplayRequestedV1({
        ...envelope,
        schemaName: 'provisioning.replay.requested',
        data: {
          replayRequestId: '70000000-0000-4000-8000-000000000001',
          originalEventId: envelope.eventId,
          requestedAt: '2026-08-27T01:00:00.000Z',
        },
      }),
    ).toBe(true);
    expect(
      isProvisioningDeadLetteredV1({
        ...envelope,
        schemaName: 'provisioning.dead_lettered',
        data: {
          originalEventId: envelope.eventId,
          originalSchemaName: 'instance.create.requested',
          originalSchemaVersion: 2,
          failure: { category: 'permanent', code: 'UNSUPPORTED', safeMessage: 'Unsupported.' },
          attempts: 3,
          replayAllowed: true,
          deadLetteredAt: '2026-08-27T01:00:00.000Z',
        },
      }),
    ).toBe(true);
  });

  it('rejects invalid enums, nested arrays, non-integers, and undeclared fields', () => {
    expect(
      isWorkflowProgressedV1({
        ...envelope,
        schemaName: 'workflow.progressed',
        data: { stage: 'configuring', attempt: 0, operationState: 'invented' },
      }),
    ).toBe(false);
    expect(
      isInstanceMutationFailedV1({
        ...envelope,
        schemaName: 'instance.mutation.failed',
        data: { action: 'create_instance', failure: [], compensationState: 'not_required' },
      }),
    ).toBe(false);
    expect(
      isProvisioningDeadLetteredV1({
        ...envelope,
        schemaName: 'provisioning.dead_lettered',
        data: {
          originalEventId: envelope.eventId,
          originalSchemaName: 'instance.create.requested',
          originalSchemaVersion: 1.5,
          failure: { category: 'permanent', code: 'UNSUPPORTED', safeMessage: 'Unsupported.' },
          attempts: 3,
          replayAllowed: true,
          deadLetteredAt: '2026-08-27T01:00:00.000Z',
          undeclared: true,
        },
      }),
    ).toBe(false);
  });
});
