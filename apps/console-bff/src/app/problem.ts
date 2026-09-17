/**
 * RFC 9457 problem documents, as the BFF emits them.
 *
 * The console's error handling switches on the contract's `code` enum, so the BFF's own failures
 * have to speak the same vocabulary — otherwise a session expiry from this process would need a
 * second code path in the browser to mean the same thing as one from the API.
 *
 * @see packages/contracts/openapi/components.v1.yaml
 */

/** The subset of the contract's codes this process can legitimately produce. */
export type BffProblemCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** A problem document with the contract's required fields. */
export function problem(input: {
  readonly status: number;
  readonly title: string;
  readonly code: BffProblemCode;
  readonly detail: string;
  readonly instance?: string;
  readonly traceId?: string;
}): Record<string, unknown> {
  return {
    type: `https://private-cloud.invalid/problems/${input.code.toLowerCase()}`,
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
    ...(input.instance ? { instance: input.instance } : {}),
    // A zeroed trace id rather than an absent one: the contract marks `traceId` required, and a
    // response missing a required field is a contract violation even when the value is a
    // placeholder. The real one is attached by the caller when telemetry is running.
    traceId: input.traceId ?? '0'.repeat(32),
  };
}
