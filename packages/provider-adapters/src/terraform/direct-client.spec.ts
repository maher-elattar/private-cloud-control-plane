/**
 * The narrowed direct client.
 *
 * The cases that earn their place are the refusals. This client exists to perform six operations
 * Terraform cannot express, and four of those six are destructive or state-invalidating — so what
 * it declines to do is the interesting half.
 *
 * @see packages/provider-adapters/src/terraform/direct-client.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxmoxDirectClient, type DirectClientConfiguration } from './direct-client.js';

const configuration: DirectClientConfiguration = {
  endpoint: 'https://proxmox.test:8006',
  apiTokenId: 'control-plane@pve!provisioner',
  apiTokenSecret: 'test-secret',
  node: 'proxtest',
  resourceIdMinimum: 910_000,
  resourceIdMaximum: 910_099,
  requestTimeoutMs: 2_000,
};

/** A Proxmox response, in the `{data}` envelope every endpoint uses. */
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('construction', () => {
  it('refuses a non-TLS endpoint', () => {
    expect(
      () => new ProxmoxDirectClient({ ...configuration, endpoint: 'http://proxmox.test' }),
    ).toThrow(/HTTPS/);
  });
});

describe('the reserved interval', () => {
  it('refuses every operation on a VMID outside it', async () => {
    const client = new ProxmoxDirectClient(configuration);
    // The boundary is checked before the request is built, so a VMID belonging to someone else
    // cannot even be named — there is no code path that puts it in a URL.
    for (const call of [
      () => client.listSnapshots(101),
      () => client.createSnapshot(101, 'snap', undefined),
      () => client.rollbackSnapshot(101, 'snap'),
      () => client.deleteSnapshot(101, 'snap'),
      () => client.reboot(101),
      () => client.stopHard(101),
      () => client.config(101),
    ]) {
      await expect(call()).rejects.toThrow(/outside the reserved range/);
    }
  });

  it('refuses one past each end of the interval', async () => {
    const client = new ProxmoxDirectClient(configuration);
    await expect(client.reboot(909_999)).rejects.toThrow(/outside the reserved range/);
    await expect(client.reboot(910_100)).rejects.toThrow(/outside the reserved range/);
  });
});

describe('snapshot names', () => {
  it('refuses a name that could not sit safely in a URL path', async () => {
    const client = new ProxmoxDirectClient(configuration);
    for (const name of ['../escape', 'has space', 'semi;colon', '', 'a'.repeat(64), '-leading']) {
      await expect(client.createSnapshot(910_000, name, undefined)).rejects.toThrow(
        /Snapshot name is invalid/,
      );
    }
  });

  it('refuses the synthetic `current` entry as a target', async () => {
    // `current` is not a snapshot; it is Proxmox's name for the VM as it is now. Rolling back to
    // it is not an operation, and deleting it is nonsense.
    const client = new ProxmoxDirectClient(configuration);
    await expect(client.rollbackSnapshot(910_000, 'current')).rejects.toThrow(/invalid/);
    await expect(client.deleteSnapshot(910_000, 'current')).rejects.toThrow(/invalid/);
  });
});

describe('listSnapshots', () => {
  it('removes the synthetic current entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        response([
          { name: 'before-upgrade', snaptime: 1_700_000_000 },
          { name: 'current', description: 'You are here!' },
        ]),
      ),
    );

    const snapshots = await new ProxmoxDirectClient(configuration).listSnapshots(910_000);

    // Returning `current` would offer a rollback target that is not one.
    expect(snapshots.map((entry) => entry.name)).toEqual(['before-upgrade']);
  });
});

describe('the operations Terraform cannot express', () => {
  it('takes a disk-only snapshot', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response('UPID:x:1:snapshot:'));
    vi.stubGlobal('fetch', fetchMock);

    await new ProxmoxDirectClient(configuration).createSnapshot(910_000, 'before-upgrade', 'note');

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    // Memory would make the snapshot far larger and make a rollback restore a running process
    // image, which is not what a lifecycle snapshot means here.
    expect(body.get('vmstate')).toBe('0');
    expect(body.get('snapname')).toBe('before-upgrade');
  });

  it('overrules a pending shutdown when stopping hard', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response('UPID:x:1:qmstop:'));
    vi.stubGlobal('fetch', fetchMock);

    await new ProxmoxDirectClient(configuration).stopHard(910_000);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/status/stop');
    // Without this, Proxmox refuses when a graceful shutdown is already in flight.
    expect((init?.body as URLSearchParams).get('overrule-shutdown')).toBe('1');
  });

  it('starts the VM again after a rollback', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response('UPID:x:1:rollback:'));
    vi.stubGlobal('fetch', fetchMock);

    await new ProxmoxDirectClient(configuration).rollbackSnapshot(910_000, 'before-upgrade');

    expect((fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams).get('start')).toBe('1');
  });
});

describe('task state', () => {
  it('treats stopped without OK as failure, not success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({ status: 'running' }))
        .mockResolvedValueOnce(response({ status: 'stopped', exitstatus: 'OK' }))
        .mockResolvedValueOnce(response({ status: 'stopped', exitstatus: 'clone failed' })),
    );

    const client = new ProxmoxDirectClient(configuration);
    expect(await client.taskState('UPID:x:1:a:')).toBe('running');
    expect(await client.taskState('UPID:x:1:b:')).toBe('succeeded');
    // `stopped` alone means finished, not succeeded, and the difference decides whether a
    // workflow proceeds or goes to review.
    expect(await client.taskState('UPID:x:1:c:')).toBe('failed');
  });
});

describe('failure classification', () => {
  it('reports a 5xx as retryable and a 4xx as not', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(null, 503))
        .mockResolvedValueOnce(response(null, 400)),
    );
    const client = new ProxmoxDirectClient(configuration);

    await expect(client.reboot(910_000)).rejects.toMatchObject({ retryable: true });
    await expect(client.reboot(910_000)).rejects.toMatchObject({ retryable: false });
  });

  it('reports an absent VM as null rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response(null, 404)));
    expect(await new ProxmoxDirectClient(configuration).config(910_000)).toBeNull();
  });

  it('reports a forbidden VM as null too', async () => {
    // With per-VMID access control, a VMID that does not exist is indistinguishable from one
    // this token may not see, and both mean "not ours to report".
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response(null, 403)));
    expect(await new ProxmoxDirectClient(configuration).config(910_000)).toBeNull();
  });

  it('distinguishes a caller cancellation from a deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    );
    // Cancellation is local transport control and must never be read as provider rollback.
    await expect(
      new ProxmoxDirectClient(configuration).reboot(910_000, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});
