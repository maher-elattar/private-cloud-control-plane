/**
 * Idempotency keys, derived rather than random.
 *
 * SAFE-008 requires every mutation to carry a key scoped to the project, the operation type and
 * the target aggregate. SAFE-009 makes reusing a key with a *different* canonical request an
 * error — `IDEMPOTENCY_CONFLICT`.
 *
 * Those two rules together rule out `crypto.randomUUID()` per attempt, which is what this console
 * did before. A fresh key on every retry means a request that timed out after the server accepted
 * it gets submitted a second time as new work — exactly the duplicate the mechanism exists to
 * prevent. Deriving the key from the request's own content instead makes a retry of the same
 * request carry the same key, and any different request carry a different one, without the caller
 * having to remember anything.
 *
 * The API enforces a **minimum of 8 characters**, stricter than the contract's stated 1, and a
 * character set of `[A-Za-z0-9._:-]`. The format below satisfies both.
 *
 * @see docs/architecture/safety-invariants.md
 */

/** The contract's pattern. Hex and the two separators used here are all inside it. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** The API's floor, which is stricter than the contract's. */
const MINIMUM_LENGTH = 8;

/** The contract's ceiling. */
const MAXIMUM_LENGTH = 128;

/**
 * Canonical JSON: object keys sorted at every depth.
 *
 * WHY canonicalisation matters here: the server hashes the request body to decide whether a
 * replayed key carries the same request. Two bodies that differ only in key order are the same
 * request, and a client that hashed them differently would generate two keys for one intent and
 * lose replay protection.
 *
 * @param value Any JSON-serialisable value.
 * @returns A stable string for equal values.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * A hex digest of a string, using the platform's subtle crypto.
 *
 * @param text The text to digest.
 * @returns Lower-case hex SHA-256.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives the idempotency key for one mutation.
 *
 * The same action, target and body always produce the same key, so a retry is recognised as a
 * replay and answered with the original operation instead of starting a second one. Changing any
 * of the three produces a different key.
 *
 * @param input.action The operation type, such as `create-instance` or `resize-instance`.
 * @param input.projectId The project the mutation is scoped to.
 * @param input.targetId The aggregate being mutated; omit for a create, which has no target yet.
 * @param input.body The request body, or `undefined` for a bodyless mutation such as a delete.
 * @returns A key satisfying both the contract's pattern and the API's stricter minimum length.
 */
export async function idempotencyKey(input: {
  readonly action: string;
  readonly projectId: string;
  // `| undefined` explicitly, because this workspace sets `exactOptionalPropertyTypes`: an
  // optional property there means "may be absent", not "may be undefined", and a create genuinely
  // passes `undefined` for a target that does not exist yet.
  readonly targetId?: string | undefined;
  readonly body?: unknown;
}): Promise<string> {
  const material = canonicalJson({
    action: input.action,
    projectId: input.projectId,
    targetId: input.targetId ?? null,
    body: input.body ?? null,
  });
  // The prefix makes a key legible in an audit trail — an operator reading `control.operations`
  // can tell what a key was for without reversing a hash. 32 hex characters of the digest is
  // ample: these are scoped per project and target already, so the space only has to be free of
  // accidental collisions, not of deliberate ones.
  const key = `console.${input.action}.${(await sha256Hex(material)).slice(0, 32)}`;
  if (key.length < MINIMUM_LENGTH || key.length > MAXIMUM_LENGTH || !KEY_PATTERN.test(key)) {
    throw new Error(`Derived an unusable idempotency key: ${key}`);
  }
  return key;
}
