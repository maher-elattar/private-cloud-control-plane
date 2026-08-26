import { ProviderResultState, ProviderTaskState } from '@private-cloud/contracts/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxmoxProvider, type ProxmoxProviderConfiguration } from './proxmox-provider.js';

const configuration: ProxmoxProviderConfiguration = {
  endpoint: 'https://proxmox.test:8006',
  apiTokenId: 'svc@pve!control-plane',
  apiTokenSecret: 'test-secret',
  providerProfileId: 'proxmox-lab',
  clusterAlias: 'lab-proxmox',
  node: 'pve-lab-1',
  templateVmid: 9000,
  imageId: 'ubuntu-24-04-cloud',
  storage: 'lab-storage',
  bridge: 'vmbr1',
  networkId: 'lab-primary',
  ipv4Cidr: '192.0.2.0/27',
  ipv4Gateway: '192.0.2.1',
  resourceIdMinimum: 910_000,
  resourceIdMaximum: 910_099,
  projectId: '00000000-0000-4000-8000-000000000001',
  environment: 'lab',
  managedBy: 'private-cloud-control-plane',
};

const context = {
  requestId: '00000000-0000-4000-8000-000000000010:create',
  operationId: '00000000-0000-4000-8000-000000000010',
  correlationId: '00000000-0000-4000-8000-000000000020',
  projectId: configuration.projectId,
  instanceId: '00000000-0000-4000-8000-000000000030',
  providerProfileId: configuration.providerProfileId,
  attempt: 1,
};

const ownership = {
  managedBy: configuration.managedBy,
  environment: configuration.environment,
  projectId: context.projectId,
  instanceId: context.instanceId,
  createOperationId: context.operationId,
};

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ProxmoxProvider Phase 3 safety', () => {
  it('rejects non-TLS endpoints and VMID ranges outside the lab reservation', () => {
    expect(
      () => new ProxmoxProvider({ ...configuration, endpoint: 'http://proxmox.test' }),
    ).toThrow('HTTPS');
    expect(() => new ProxmoxProvider({ ...configuration, resourceIdMinimum: 100 })).toThrow(
      '910000-910099',
    );
    expect(() => new ProxmoxProvider({ ...configuration, ipv4Gateway: '198.51.100.1' })).toThrow(
      'IPv4 allowlist',
    );
  });

  it('distinguishes caller cancellation from a provider deadline', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ProxmoxProvider(configuration);
    const controller = new AbortController();
    controller.abort();

    const pending = provider.submitCreateInstance(
      {
        context,
        imageId: configuration.imageId,
        hostname: 'phase3-test',
        ownershipMarkers: ownership,
      },
      { signal: controller.signal },
    );

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('chooses only a reserved VMID and submits an ownership-marked full clone', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(null, 404))
      .mockResolvedValueOnce(response('UPID:pve-lab-1:0001:clone:'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ProxmoxProvider(configuration);

    const result = (
      await provider.submitCreateInstance({
        context,
        imageId: configuration.imageId,
        flavorId: 'lab-small',
        hostname: 'phase3-test',
        resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
        network: {
          networkId: configuration.networkId,
          ipv4Address: '192.0.2.5',
          ipv4PrefixLength: 27,
          ipv4Gateway: configuration.ipv4Gateway,
          dnsServers: ['192.0.2.53'],
        },
        ownershipMarkers: ownership,
      })
    ).result;

    expect(result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    expect(Number(result?.providerResourceId)).toBeGreaterThanOrEqual(910_000);
    expect(Number(result?.providerResourceId)).toBeLessThanOrEqual(910_099);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cluster/nextid'))).toBe(
      false,
    );
    const [cloneUrl, cloneInit] = fetchMock.mock.calls[2] ?? [];
    expect(String(cloneUrl)).toContain('/qemu/9000/clone');
    const body = cloneInit?.body as URLSearchParams;
    expect(body.get('full')).toBe('1');
    expect(body.get('storage')).toBe(configuration.storage);
    expect(body.get('description')).toContain(`"instanceId":"${context.instanceId}"`);
  });

  it('preserves inherited net0 data and omits blank secret fields during configuration', async () => {
    const description = `private-cloud-control:${JSON.stringify(ownership)}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          description,
          net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1',
          scsi0: 'lab-storage:vm-910000-disk-0,size=32G',
        }),
      )
      .mockResolvedValueOnce(response([{ vmid: 910_000 }]))
      .mockResolvedValueOnce(response('UPID:pve-lab-1:0002:config:'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ProxmoxProvider(configuration);

    const result = (
      await provider.applyInstanceConfiguration({
        context: { ...context, requestId: `${context.operationId}:configure` },
        providerResourceId: '910000',
        hostname: 'phase3-test',
        resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
        network: {
          networkId: configuration.networkId,
          ipv4Address: '192.0.2.5',
          ipv4PrefixLength: 27,
          ipv4Gateway: configuration.ipv4Gateway,
          dnsServers: ['192.0.2.53'],
        },
        sshPublicKeys: [],
        ownershipMarkers: ownership,
      })
    ).result;

    expect(result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    const body = fetchMock.mock.calls[2]?.[1]?.body as URLSearchParams;
    expect(body.get('net0')).toBe('virtio=AA:BB:CC:DD:EE:FF,firewall=1,bridge=vmbr1');
    expect(body.has('sshkeys')).toBe(false);
    expect(body.has('cipassword')).toBe(false);
    expect(body.get('ipconfig0')).toBe('ip=192.0.2.5/27,gw=192.0.2.1');
  });

  it('encodes the UPID and accepts only stopped tasks with an OK exit status', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(null, 404))
      .mockResolvedValueOnce(response('UPID:pve-lab-1:0003:start:'))
      .mockResolvedValueOnce(response({ status: 'stopped', exitstatus: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ProxmoxProvider(configuration);
    const submitted = await provider.submitCreateInstance({
      context,
      imageId: configuration.imageId,
      hostname: 'phase3-test',
      ownershipMarkers: ownership,
    });
    const task = await provider.getTask({
      context: { ...context, requestId: `${context.operationId}:poll` },
      providerTaskReference: submitted.result?.providerTaskReference,
    });

    expect(task.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/tasks/UPID%3A');
  });

  it('treats an owned already-running VM as an idempotent start success', async () => {
    const description = `private-cloud-control:${JSON.stringify(ownership)}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ description }))
      .mockResolvedValueOnce(response({ status: 'running' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ProxmoxProvider(configuration);

    const result = (
      await provider.startInstance({
        request: {
          context: { ...context, requestId: `${context.operationId}:start` },
          providerResourceId: '910000',
          expectedOwnershipMarkers: ownership,
        },
      })
    ).result;

    expect(result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED);
    expect(result?.providerResourceId).toBe('910000');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
