import assert from 'node:assert/strict';
import test from 'node:test';
import { connectWhenReady } from './postgres-ready.mjs';

test('retries transient startup errors before returning a connection', async () => {
  const connection = {};
  let attempts = 0;
  const pool = {
    async connect() {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('starting'), { code: '57P03' });
      return connection;
    },
  };

  assert.equal(await connectWhenReady(pool, { initialDelayMs: 1, maximumDelayMs: 1 }), connection);
  assert.equal(attempts, 3);
});

test('does not mask non-transient database failures', async () => {
  let attempts = 0;
  const pool = {
    async connect() {
      attempts += 1;
      throw Object.assign(new Error('authentication failed'), { code: '28P01' });
    },
  };

  await assert.rejects(() => connectWhenReady(pool), { code: '28P01' });
  assert.equal(attempts, 1);
});

test('stops retrying when the readiness budget is exhausted', async () => {
  let attempts = 0;
  const pool = {
    async connect() {
      attempts += 1;
      throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
    },
  };

  await assert.rejects(() => connectWhenReady(pool, { timeoutMs: 0 }), {
    code: 'ECONNREFUSED',
  });
  assert.equal(attempts, 1);
});
