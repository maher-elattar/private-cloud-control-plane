const retryableConnectionCodes = new Set([
  '57P03',
  '08001',
  '08006',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

function errorCode(error) {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export async function connectWhenReady(
  pool,
  { timeoutMs = 60_000, initialDelayMs = 250, maximumDelayMs = 2_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let delayMs = initialDelayMs;

  for (;;) {
    try {
      return await pool.connect();
    } catch (error) {
      if (!retryableConnectionCodes.has(errorCode(error)) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(maximumDelayMs, delayMs * 2);
    }
  }
}
