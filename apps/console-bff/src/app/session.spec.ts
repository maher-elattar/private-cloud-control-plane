/**
 * The session store holds the only bearer credential in the system that a browser sits in front of.
 *
 * WHY these properties are tested rather than trusted: the whole reason this process exists is to
 * keep the access token out of the browser. A store that leaked it through its public view, or
 * honoured an expired session, or handed out guessable identifiers would defeat that while looking
 * exactly like a working login.
 */
import { describe, expect, it, vi } from 'vitest';
import { publicView, SessionStore } from './session.js';

/** A record with a far-future expiry, for the cases that are not about expiry. */
function record(overrides: Partial<Parameters<SessionStore['create']>[0]> = {}) {
  return {
    subject: 'demo@testsrv.lab',
    displayName: 'demo@testsrv.lab',
    projectId: '00000000-0000-4000-8000-0000000000a1',
    accessToken: 'header.payload.signature',
    expiresAt: Date.now() + 900_000,
    ...overrides,
  };
}

describe('publicView', () => {
  it('omits the access token', () => {
    // The single most important assertion in this file. `publicView` is what `/auth/session`
    // returns, so anything it carries reaches the browser — and the token must not.
    const view = publicView({ ...record(), createdAt: Date.now() });

    expect(JSON.stringify(view)).not.toContain('header.payload.signature');
    expect(Object.keys(view).sort()).toEqual(['displayName', 'expiresAt', 'projectId', 'subject']);
  });
});

describe('SessionStore', () => {
  it('reads back a session it created', () => {
    const store = new SessionStore();
    const id = store.create(record());

    expect(store.read(id)?.accessToken).toBe('header.payload.signature');
  });

  it('returns nothing for an absent or unknown identifier', () => {
    const store = new SessionStore();

    expect(store.read(undefined)).toBeUndefined();
    expect(store.read('not-a-session')).toBeUndefined();
  });

  it('issues identifiers that are unguessable, not merely unique', () => {
    // A UUID is unique and predictable enough to be a poor credential. This value *is* the
    // credential as far as the browser is concerned, so it comes from the CSPRNG.
    const store = new SessionStore();
    const identifiers = new Set(Array.from({ length: 50 }, () => store.create(record())));

    expect(identifiers.size).toBe(50);
    for (const id of identifiers) {
      // 32 bytes of base64url.
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('refuses a session whose token has expired, and forgets it', () => {
    const store = new SessionStore();
    const id = store.create(record({ expiresAt: Date.now() - 1 }));

    expect(store.read(id)).toBeUndefined();
    // Dropped rather than merely hidden: a store that kept refusing without deleting would grow
    // for as long as the process ran.
    expect(store.size).toBe(0);
  });

  it('refuses a session older than the absolute ceiling even with a live token', () => {
    // A token can be refreshed; a session should still end. Without this a single sign-in could
    // be extended indefinitely.
    vi.useFakeTimers();
    try {
      const store = new SessionStore();
      const id = store.create(record({ expiresAt: Date.now() + 100 * 60 * 60 * 1000 }));
      expect(store.read(id)).toBeDefined();

      vi.advanceTimersByTime(13 * 60 * 60 * 1000);

      expect(store.read(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a session, and a repeated destroy is not an error', () => {
    const store = new SessionStore();
    const id = store.create(record());

    store.destroy(id);
    store.destroy(id);
    store.destroy(undefined);

    expect(store.read(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('sets createdAt itself, so a caller cannot backdate a session', () => {
    const store = new SessionStore();
    const id = store.create({ ...record(), createdAt: 0 } as never);

    expect(store.read(id)?.createdAt).toBeGreaterThan(0);
  });
});
