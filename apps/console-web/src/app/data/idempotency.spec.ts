/**
 * The idempotency key must be stable for the same request and different for any other.
 *
 * WHY this is worth a test rather than a comment: the predecessor called `crypto.randomUUID()` per
 * attempt, which satisfies the header's format and defeats its purpose — a retry of a request the
 * server already accepted arrives as new work. The property that matters is not "a valid key" but
 * "the same key for the same intent", and only a test states that.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, idempotencyKey } from './idempotency';

describe('canonicalJson', () => {
  it('is insensitive to key order at every depth', () => {
    // The server hashes the body to decide whether a replayed key carries the same request. Two
    // bodies differing only in key order are the same request, and a client that hashed them
    // differently would generate two keys for one intent and lose replay protection.
    const left = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const right = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('treats an absent property and an undefined one as the same request', () => {
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it('preserves array order, which is not a set', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('idempotencyKey', () => {
  const base = {
    action: 'create-instance',
    projectId: '00000000-0000-4000-8000-0000000000a1',
    body: { hostname: 'alpha', flavorId: 'lab-small' },
  } as const;

  it('returns the same key for the same request', async () => {
    expect(await idempotencyKey(base)).toBe(await idempotencyKey(base));
  });

  it('returns a different key when the body differs', async () => {
    const other = { ...base, body: { ...base.body, hostname: 'beta' } };

    expect(await idempotencyKey(base)).not.toBe(await idempotencyKey(other));
  });

  it('returns a different key for a different action on the same target', async () => {
    const shutdown = { action: 'instance-shutdown', projectId: base.projectId, targetId: 'i-1' };
    const start = { action: 'instance-start', projectId: base.projectId, targetId: 'i-1' };

    expect(await idempotencyKey(shutdown)).not.toBe(await idempotencyKey(start));
  });

  it('returns a different key for the same action on a different target', async () => {
    const first = { action: 'retain-instance', projectId: base.projectId, targetId: 'i-1' };
    const second = { action: 'retain-instance', projectId: base.projectId, targetId: 'i-2' };

    expect(await idempotencyKey(first)).not.toBe(await idempotencyKey(second));
  });

  it('satisfies the pattern and the length floor the application enforces', async () => {
    // The contract allows one character; `assertIdempotencyKey` in the application requires
    // eight, so a key valid against the contract alone earns a VALIDATION_FAILED.
    const key = await idempotencyKey(base);

    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[A-Za-z0-9._:-]+$/);
  });
});
