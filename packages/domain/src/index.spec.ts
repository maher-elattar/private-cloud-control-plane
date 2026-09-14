import { describe, expect, it } from 'vitest';
import {
  allocateIpv4,
  canonicalJson,
  canonicalSha256,
  DomainError,
  validateCreateInstance,
  validatePowerAction,
  validateResize,
  validateSnapshotName,
  classifyDrift,
} from './index.js';

describe('canonical hashing', () => {
  it('is independent of key order, because it is an idempotency identity', () => {
    // Two clients serialising the same request with different key order must be recognised as the
    // same request, or an ordinary retry provisions a second VM.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalSha256({ b: 1, a: 2 })).toBe(canonicalSha256({ a: 2, b: 1 }));
  });

  it('drops undefined so an absent field and an omitted field hash alike', () => {
    expect(canonicalSha256({ a: 1, b: undefined })).toBe(canonicalSha256({ a: 1 }));
  });

  it('distinguishes values that must not collide', () => {
    expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: '1' }));
    expect(canonicalSha256([1, 2])).not.toBe(canonicalSha256([2, 1]));
    expect(canonicalSha256({ a: { b: 1 } })).not.toBe(canonicalSha256({ 'a.b': 1 }));
  });

  it('returns a lowercase 64-character digest', () => {
    expect(canonicalSha256({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('allocateIpv4', () => {
  const pool = { cidr: '192.0.2.0/29', gateway: '192.0.2.1', exclusions: ['192.0.2.2'] };

  it('allocates lowest-first, skipping network, gateway, and exclusions', () => {
    expect(allocateIpv4(pool, new Set())).toBe('192.0.2.3');
    expect(allocateIpv4(pool, new Set(['192.0.2.3']))).toBe('192.0.2.4');
  });

  it('never returns the network or broadcast address', () => {
    // SAFE-024. /29 spans .0 to .7, so .0 and .7 must never be handed out.
    const handed = new Set<string>();
    const leased = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const address = allocateIpv4(pool, leased);
      handed.add(address);
      leased.add(address);
    }
    expect(handed.has('192.0.2.0')).toBe(false);
    expect(handed.has('192.0.2.7')).toBe(false);
    expect([...handed].sort()).toEqual(['192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6']);
  });

  it('raises QUOTA_EXCEEDED rather than reusing an address when the pool is exhausted', () => {
    const leased = new Set(['192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6']);
    expect(() => allocateIpv4(pool, leased)).toThrowError(
      expect.objectContaining({ code: 'QUOTA_EXCEEDED' }),
    );
  });

  it('reads addresses at or above 128.0.0.0 as unsigned', () => {
    // JavaScript bitwise operators are signed; without the unsigned coercion these pools would
    // produce negative offsets and hand out nonsense.
    expect(
      allocateIpv4({ cidr: '203.0.113.0/29', gateway: '203.0.113.1', exclusions: [] }, new Set()),
    ).toBe('203.0.113.2');
    expect(
      allocateIpv4(
        { cidr: '255.255.255.0/29', gateway: '255.255.255.1', exclusions: [] },
        new Set(),
      ),
    ).toBe('255.255.255.2');
  });

  it('rejects a malformed or non-IPv4 pool', () => {
    for (const cidr of [
      'not-a-cidr',
      '192.0.2.0',
      '192.0.2.0/33',
      '2001:db8::/64',
      // `ipaddr.js` read this legacy short form as 192.0.0.2 and allocated outside the operator's
      // network, which SAFE-024 forbids. Regression guard for that fix.
      '192.0.2/24',
      '192.0.2.999/24',
      '1.2.3.4.5/24',
      '192.0.2.01/24',
    ]) {
      expect(() =>
        allocateIpv4({ cidr, gateway: '192.0.2.1', exclusions: [] }, new Set()),
      ).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
  });

  it('rejects a pool whose address is not the network address for its prefix', () => {
    // Masking the host bits off would silently allocate from a range nobody configured.
    expect(() =>
      allocateIpv4({ cidr: '192.0.2.5/24', gateway: '192.0.2.1', exclusions: [] }, new Set()),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects a non-IPv4 gateway', () => {
    expect(() =>
      allocateIpv4({ cidr: '192.0.2.0/29', gateway: 'not-an-address', exclusions: [] }, new Set()),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('validateCreateInstance', () => {
  const valid = {
    imageId: 'ubuntu-24-04-cloud',
    flavorId: 'lab-small',
    networkId: 'lab-primary',
    hostname: 'web-01',
  };

  it('accepts a well-formed request', () => {
    expect(() => validateCreateInstance(valid)).not.toThrow();
  });

  it('rejects catalog slugs that are uppercase, too short, or hyphen-led', () => {
    for (const imageId of ['Ubuntu', 'a', '-leading', '']) {
      expect(() => validateCreateInstance({ ...valid, imageId })).toThrowError(DomainError);
    }
  });

  it('rejects hostnames that are empty, over-long, or hyphen-terminated', () => {
    for (const hostname of ['', 'a'.repeat(64), '-lead', 'trail-']) {
      expect(() => validateCreateInstance({ ...valid, hostname })).toThrowError(DomainError);
    }
  });

  /** A real, structurally complete key. Not a secret: a public key never is. */
  const wellFormedKey =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKqQZyPkFmRLBCLiLwCHnUoCQkUxLZ8sKOUVCR+7bgBR lab@example';

  it('accepts a structurally complete key', () => {
    expect(() =>
      validateCreateInstance({ ...valid, sshPublicKeys: [wellFormedKey] }),
    ).not.toThrow();
  });

  it('rejects a key whose body does not name its own algorithm', () => {
    // This is the case that reached real hardware. It passes every length and character test, and
    // Proxmox answers it with an HTTP **500** — which a transport classifier reads as "the server
    // had a problem, retry". So a tenant pasting a truncated key produced a retryable provider
    // failure that burned the workflow's retry budget and ended in review, for input that could
    // never have worked. An SSH public key's body names its own algorithm, length-prefixed, so
    // the disagreement is detectable here with no provider call at all.
    const plausible = `ssh-ed25519 ${'A'.repeat(48)} probe@lab`;
    expect(() => validateCreateInstance({ ...valid, sshPublicKeys: [plausible] })).toThrowError(
      DomainError,
    );
  });

  it('rejects an unknown key type and a body that is not base64', () => {
    for (const key of [
      wellFormedKey.replace('ssh-ed25519', 'ssh-dss'),
      wellFormedKey.replace('AAAAC3Nza', 'not base64!'),
      'ssh-ed25519',
      `ssh-ed25519 ${'='.repeat(40)}`,
    ]) {
      expect(() => validateCreateInstance({ ...valid, sshPublicKeys: [key] })).toThrowError(
        DomainError,
      );
    }
  });

  it('rejects SSH keys containing control characters', () => {
    // Keys reach cloud-init, so a newline or NUL could inject further guest configuration.
    const injected = ['ssh-ed25519 AAA', 'injected'].join(String.fromCharCode(10));
    const carriage = 'ssh-ed25519 AAA' + String.fromCharCode(13);
    const nul = 'ssh-ed25519 AAA' + String.fromCharCode(0);
    for (const key of [injected, carriage, nul]) {
      expect(() => validateCreateInstance({ ...valid, sshPublicKeys: [key] })).toThrowError(
        DomainError,
      );
    }
  });

  it('rejects more than five keys and duplicate keys', () => {
    const key = (index: number) => `ssh-ed25519 AAAAKEY${index}`;
    expect(() =>
      validateCreateInstance({ ...valid, sshPublicKeys: [0, 1, 2, 3, 4, 5].map(key) }),
    ).toThrowError(DomainError);
    expect(() =>
      validateCreateInstance({ ...valid, sshPublicKeys: [key(1), key(1)] }),
    ).toThrowError(DomainError);
  });
});

describe('validatePowerAction', () => {
  it('accepts the four supported transitions', () => {
    for (const action of ['start', 'shutdown', 'stop', 'reboot']) {
      expect(validatePowerAction(action)).toBe(action);
    }
  });

  it('rejects anything else, including a plausible synonym', () => {
    // `poweroff` and `halt` read like `stop` but are not in the contract; accepting them would
    // mean guessing which of shutdown or stop the caller meant, and those differ in data safety.
    for (const action of ['', 'START', 'poweroff', 'halt', 'restart', 'destroy']) {
      expect(() => validatePowerAction(action)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });
});

describe('validateResize', () => {
  const current = { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 };

  it('accepts a compute change that leaves the disk alone', () => {
    expect(() =>
      validateResize({ current, target: { cpuCount: 4, memoryMiB: 8192, diskGiB: 32 } }),
    ).not.toThrow();
  });

  it('accepts disk growth', () => {
    expect(() => validateResize({ current, target: { ...current, diskGiB: 64 } })).not.toThrow();
  });

  it('refuses any disk reduction, however small', () => {
    // SAFE-026. Shrinking discards whatever lived in the removed extent, and no provider undoes it.
    expect(() => validateResize({ current, target: { ...current, diskGiB: 31 } })).toThrowError(
      expect.objectContaining({ code: 'DISK_SHRINK_FORBIDDEN' }),
    );
  });

  it('refuses a resize that changes nothing', () => {
    // A no-op resize still takes the instance lock and submits a provider mutation, so a retry
    // loop of them would hold an instance busy indefinitely.
    expect(() => validateResize({ current, target: { ...current } })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('validateSnapshotName', () => {
  it('accepts names Proxmox will take', () => {
    for (const name of ['nightly', 'pre-upgrade', 'v1.2.3', 'a', 'A_b-c.1']) {
      expect(() => validateSnapshotName(name)).not.toThrow();
    }
  });

  it('refuses the reserved name Proxmox injects into every listing', () => {
    // A real snapshot called `current` would be indistinguishable from the synthetic entry marking
    // live state, and a rollback aimed at the wrong one cannot be undone.
    for (const name of ['current', 'CURRENT', 'Current']) {
      expect(() => validateSnapshotName(name)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });

  it('refuses malformed names', () => {
    for (const name of ['', '-leading', 'has space', 'a'.repeat(64), 'semi;colon', 'sl/ash']) {
      expect(() => validateSnapshotName(name)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });
});

describe('classifyDrift', () => {
  const desired = {
    lifecycleState: 'active',
    powerState: 'running' as const,
    cpuCount: 2,
    memoryMiB: 4096,
    diskGiB: 32,
  };
  const matching = {
    exists: true,
    powerState: 'running' as const,
    markerMatch: true,
    cpuCount: 2,
    memoryMiB: 4096,
    diskGiB: 32,
  };

  it('reports no drift when observed matches desired', () => {
    expect(classifyDrift(desired, matching)).toEqual({ classification: 'none', dangerous: false });
  });

  it('checks identity before absence', () => {
    // A VM carrying someone else's markers is not evidence about our instance at all. Treating it
    // as present would be worse than treating it as missing.
    expect(classifyDrift(desired, { ...matching, markerMatch: false })).toEqual({
      classification: 'identity_mismatch',
      dangerous: true,
    });
  });

  it('reports a missing resource as dangerous', () => {
    expect(classifyDrift(desired, { ...matching, exists: false })).toEqual({
      classification: 'missing_resource',
      dangerous: true,
    });
  });

  it('does not report absence as drift for a purged instance', () => {
    // Absence is the intended end state of a purge, not a finding.
    expect(
      classifyDrift({ ...desired, lifecycleState: 'purged' }, { ...matching, exists: false }),
    ).toEqual({ classification: 'none', dangerous: false });
  });

  it('reports an unknown power state as ambiguous rather than guessing', () => {
    expect(classifyDrift(desired, { ...matching, powerState: 'unknown' })).toEqual({
      classification: 'ambiguous',
      dangerous: true,
    });
  });

  it('reports power drift as safely correctable', () => {
    // Starting or stopping a VM to match accepted intent destroys nothing.
    expect(classifyDrift(desired, { ...matching, powerState: 'stopped' })).toEqual({
      classification: 'power_drift',
      dangerous: false,
    });
  });

  it('ignores power state when desired intent is unchanged', () => {
    expect(
      classifyDrift(
        { ...desired, powerState: 'unchanged' },
        { ...matching, powerState: 'stopped' },
      ),
    ).toEqual({ classification: 'none', dangerous: false });
  });

  it('reports a smaller disk as drift but a larger one as not', () => {
    // Growth is the only direction permitted, and a tenant may have grown a disk outside our
    // record; reporting that as drift would produce a finding nobody should act on.
    expect(classifyDrift(desired, { ...matching, diskGiB: 16 }).classification).toBe(
      'network_drift',
    );
    expect(classifyDrift(desired, { ...matching, diskGiB: 64 }).classification).toBe('none');
  });

  it('ignores sizing the provider did not measure', () => {
    const unmeasured = { exists: true, powerState: 'running' as const, markerMatch: true };
    expect(classifyDrift(desired, unmeasured)).toEqual({
      classification: 'none',
      dangerous: false,
    });
  });
});
