import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@private-cloud/domain';
import { ControlPlaneApplication } from './control-plane.js';
import type { ControlPlaneStore } from './ports.js';
import type {
  ApplicationTelemetry,
  ApplicationTraceContext,
  TelemetryAttributes,
} from './telemetry.js';

function store(): ControlPlaneStore {
  return {
    acceptCreate: vi.fn().mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000001',
      targetId: '20000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-08-26T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000001',
      replayed: false,
    }),
    listDeadLetters: vi.fn(),
    getDeadLetterTraceContext: vi.fn().mockResolvedValue(null),
    requestDeadLetterReplay: vi.fn(),
    getProject: vi.fn(),
    getQuota: vi.fn(),
    listImages: vi.fn(),
    listFlavors: vi.fn(),
    listNetworks: vi.fn(),
    getInstance: vi.fn(),
    listInstances: vi.fn(),
    getOperation: vi.fn(),
    listOperations: vi.fn(),
  };
}

const actor = {
  subject: 'user-1',
  roles: ['tenant_developer'],
  projects: ['00000000-0000-4000-8000-000000000001'],
};

describe('ControlPlaneApplication', () => {
  it('binds accepted create input to a stable canonical hash', async () => {
    const repository = store();
    const application = new ControlPlaneApplication(repository);
    await application.createInstance({
      actor,
      projectId: actor.projects[0] ?? '',
      idempotencyKey: 'create-web-01',
      correlationId: '50000000-0000-4000-8000-000000000001',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      imageId: 'ubuntu-24-04-cloud',
      flavorId: 'lab-small',
      networkId: 'lab-primary',
      hostname: 'web-01',
    });

    expect(repository.acceptCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  it('rejects a project not present in the actor grants before storage', async () => {
    const repository = store();
    const application = new ControlPlaneApplication(repository);
    await expect(
      application.createInstance({
        actor,
        projectId: '00000000-0000-4000-8000-000000000099',
        idempotencyKey: 'create-web-01',
        correlationId: '50000000-0000-4000-8000-000000000001',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        imageId: 'ubuntu-24-04-cloud',
        flavorId: 'lab-small',
        networkId: 'lab-primary',
        hostname: 'web-01',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(repository.acceptCreate).not.toHaveBeenCalled();
  });

  it('starts replay in a new trace linked to the original failed trace', async () => {
    const repository = store();
    const failedTrace = {
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    };
    vi.mocked(repository.getDeadLetterTraceContext).mockResolvedValue(failedTrace);
    vi.mocked(repository.requestDeadLetterReplay).mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000001',
      targetId: '20000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-08-26T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000001',
      replayed: false,
    });
    const traceCalls = vi.fn();
    const telemetry: ApplicationTelemetry = {
      trace: async <T>(
        name: string,
        attributes: TelemetryAttributes,
        operation: () => Promise<T>,
        parent?: ApplicationTraceContext,
        links?: readonly ApplicationTraceContext[],
      ): Promise<T> => {
        traceCalls(name, attributes, operation, parent, links);
        return operation();
      },
      currentTraceContext: (fallback) => fallback,
      commandAccepted: vi.fn(),
      workflowTransition: vi.fn(),
      workflowRetry: vi.fn(),
    };
    const application = new ControlPlaneApplication(repository, telemetry);

    await application.requestDeadLetterReplay({
      actor: { subject: 'admin-1', roles: ['platform_administrator'], projects: [] },
      originalEventId: '60000000-0000-4000-8000-000000000001',
      idempotencyKey: 'replay-event-01',
      correlationId: '50000000-0000-4000-8000-000000000001',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      reason: 'Provider recovered after the incident.',
    });

    expect(repository.getDeadLetterTraceContext).toHaveBeenCalledWith(
      '60000000-0000-4000-8000-000000000001',
    );
    expect(traceCalls).toHaveBeenCalledWith(
      'controlplane.replay.request',
      { 'command.type': 'replay_dead_letter' },
      expect.any(Function),
      undefined,
      [failedTrace],
    );
  });
});
