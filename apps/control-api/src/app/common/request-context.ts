/**
 * Validates and defaults the correlation and trace identifiers carried on every request.
 *
 * WHY these are generated when absent rather than left empty: an accepted command is executed
 * minutes later by a different process. Without identifiers stamped at acceptance there is no
 * way to link a provider call back to the request that caused it, which is precisely what is
 * needed when diagnosing a `manual_review`.
 *
 * @see docs/architecture/create-instance-sequence.md
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const maximumTracestateLength = 512;

/**
 * Returns the caller's correlation ID, or generates one.
 *
 * A malformed value is rejected rather than replaced: silently substituting a fresh UUID
 * would break the client's own correlation without telling it anything went wrong.
 *
 * @throws BadRequestException if the supplied value is not a UUID.
 */
export function correlationId(value: string | undefined): string {
  if (!value) return randomUUID();
  if (!uuidPattern.test(value)) throw new BadRequestException('Correlation ID must be a UUID.');
  return value;
}

/**
 * Returns the caller's W3C `traceparent`, or generates a new root trace.
 *
 * WHY the all-zero trace and span IDs are rejected: the W3C spec defines both as invalid, and
 * some instrumentation emits them when tracing is disabled. Accepting one would produce spans
 * that silently attach to an unusable trace.
 *
 * @throws BadRequestException if the header is present but malformed.
 */
export function requestTraceparent(value: string | undefined): string {
  if (!value) {
    return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
  }
  const match = traceparentPattern.exec(value);
  if (!match || /^0+$/.test(match[1] ?? '') || /^0+$/.test(match[2] ?? '')) {
    throw new BadRequestException('Traceparent is invalid.');
  }
  return value;
}

/**
 * Validates the optional W3C `tracestate` companion header.
 *
 * Full member parsing remains the OpenTelemetry propagator's responsibility. This boundary
 * enforces the contract size, forbids control characters, and prevents vendor state from being
 * attached to a newly generated unrelated trace.
 */
export function requestTracestate(
  value: string | undefined,
  suppliedTraceparent: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (!suppliedTraceparent) {
    throw new BadRequestException('Tracestate requires a traceparent header.');
  }
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (value.length > maximumTracestateLength || hasControlCharacter) {
    throw new BadRequestException('Tracestate is invalid.');
  }
  return value;
}
