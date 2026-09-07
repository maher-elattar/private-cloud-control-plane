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
    acceptPowerAction: vi.fn().mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000002',
      targetId: '20000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-09-04T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000002',
      replayed: false,
    }),
    acceptResize: vi.fn().mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000003',
      targetId: '20000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-09-04T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000003',
      replayed: false,
    }),
    releaseIpv4Lease: vi.fn(),
    getRetentionPolicy: vi.fn(),
    acceptSnapshotCreate: vi.fn().mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000004',
      targetId: '20000000-0000-4000-8000-000000000009',
      acceptedAt: '2026-09-04T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000004',
      replayed: false,
    }),
    acceptSnapshotAction: vi.fn().mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000005',
      targetId: '20000000-0000-4000-8000-000000000009',
      acceptedAt: '2026-09-04T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000005',
      replayed: false,
    }),
    acceptRetention: vi.fn().mockResolvedValue({
      operationId: '40000000-0000-4000-8000-000000000006',
      targetId: '20000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-09-04T00:00:00.000Z',
      statusUrl: '/operations/40000000-0000-4000-8000-000000000006',
      replayed: false,
    }),
    acceptPurge: vi.fn(),
    requestReconciliation: vi.fn().mockResolvedValue(true),
    listSnapshots: vi.fn(),
    listDeadLetters: vi.fn(),
    listAuditEvents: vi.fn(),
    getAdministrativeOperation: vi.fn(),
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
      deadLetter: vi.fn(),
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

  it('refuses the administrative read surface to a tenant actor', async () => {
    const repository = store();
    const application = new ControlPlaneApplication(repository);

    // WHY both routes: each one deliberately skips the project-membership filter that guards the
    // tenant equivalents, so the administrator role check is the only thing standing between a
    // tenant token and every project's history.
    //
    // The two assert differently because the guard runs before the method returns a promise.
    // `listAuditEvents` delegates without awaiting, matching `listDeadLetters`, so its rejection
    // surfaces as a synchronous throw; `getAdministrativeOperation` awaits the store and rejects.
    expect(() => application.listAuditEvents(actor)).toThrowError(DomainError);
    await expect(
      application.getAdministrativeOperation(actor, '40000000-0000-4000-8000-000000000001'),
    ).rejects.toThrowError(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(repository.listAuditEvents).not.toHaveBeenCalled();
    expect(repository.getAdministrativeOperation).not.toHaveBeenCalled();
  });

  it('passes paging through to the store and clamps a nonsensical limit', async () => {
    const repository = store();
    const application = new ControlPlaneApplication(repository);
    const administrator = { subject: 'admin-1', roles: ['platform_administrator'], projects: [] };

    await application.listAuditEvents(administrator, { projectId: 'p-1' }, 10, 'cursor-token');
    expect(repository.listAuditEvents).toHaveBeenCalledWith(
      { projectId: 'p-1' },
      { limit: 10, cursor: 'cursor-token' },
    );

    // An out-of-range limit falls back to the default rather than failing a read.
    await application.listAuditEvents(administrator, {}, 5_000);
    expect(repository.listAuditEvents).toHaveBeenLastCalledWith({}, { limit: 50 });

    // An absent cursor is omitted, not sent as `undefined`, so the store sees a first page.
    expect(repository.listAuditEvents).toHaveBeenLastCalledWith(
      {},
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
  });

  it('reports a missing administrative operation as OPERATION_NOT_FOUND', async () => {
    const repository = store();
    (repository.getAdministrativeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const application = new ControlPlaneApplication(repository);

    await expect(
      application.getAdministrativeOperation(
        { subject: 'admin-1', roles: ['platform_administrator'], projects: [] },
        '40000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'OPERATION_NOT_FOUND' }));
  });

  it('rejects an unsupported power action before it reaches the store', async () => {
    const repository = store();
    const application = new ControlPlaneApplication(repository);

    await expect(
      application.mutateInstancePower({
        actor,
        projectId: actor.projects[0] ?? '',
        instanceId: '20000000-0000-4000-8000-000000000001',
        idempotencyKey: 'power-web-01',
        correlationId: '50000000-0000-4000-8000-000000000001',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        action: 'poweroff',
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(repository.acceptPowerAction).not.toHaveBeenCalled();
  });

  it('binds the target instance into the power request hash', async () => {
    // Reusing one key against a different instance must conflict rather than replay, or the
    // caller receives a success describing a machine they never named.
    const repository = store();
    const application = new ControlPlaneApplication(repository);
    const base = {
      actor,
      projectId: actor.projects[0] ?? '',
      idempotencyKey: 'power-web-01',
      correlationId: '50000000-0000-4000-8000-000000000001',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      action: 'start',
    };

    await application.mutateInstancePower({
      ...base,
      instanceId: '20000000-0000-4000-8000-000000000001',
    });
    await application.mutateInstancePower({
      ...base,
      instanceId: '20000000-0000-4000-8000-000000000002',
    });

    const mock = repository.acceptPowerAction as ReturnType<typeof vi.fn>;
    const [firstHash] = mock.mock.calls[0]?.slice(1) ?? [];
    const [secondHash] = mock.mock.calls[1]?.slice(1) ?? [];
    expect(firstHash).not.toBe(secondHash);
  });
});
