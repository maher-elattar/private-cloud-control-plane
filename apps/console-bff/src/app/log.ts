/**
 * Structured logging, in the shape the rest of the stack emits.
 *
 * WHY this small copy rather than `@private-cloud/observability`: that package carries the
 * OpenTelemetry SDK, which patches modules at require time and so cannot be bundled — depending on
 * it would mean this process externalises its dependencies and installs them in the image from a
 * pruned lockfile, which is a second place for a supply-chain policy to be evaluated against a
 * different workspace file. It also declared the whole application layer as a runtime dependency,
 * dragging five workspace modules into the image for three erased type imports.
 *
 * What this process gives up is its own spans. What it keeps is trace *continuity*: it forwards
 * `traceparent` unchanged, so a request that passes through it stays on one trace and appears
 * under `control-api`, which is fully instrumented. The console's own hop is the one link not
 * separately timed, and that is a smaller loss than an instrumentation runtime inside a static
 * file server.
 *
 * @see packages/observability/src/runtime.ts
 */

/** Fields every line carries, matching the backend services' envelope. */
interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * Writes one JSON line to stdout.
 *
 * Never accepts a credential. SAFE-031 keeps authorization headers, tokens and cloud-init secrets
 * out of logs, and the call sites here pass identities — a subject, a project — rather than the
 * material that proves them.
 *
 * @param level Severity, matching the backend's vocabulary.
 * @param event Machine-readable event name in snake case.
 * @param fields Additional structured fields.
 */
export function structuredLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}

/**
 * The trace id from an inbound `traceparent`, for correlating an error with the rest of a request.
 *
 * Returns nothing for a malformed header rather than throwing: a request must not fail because its
 * trace context was unusable.
 *
 * @param traceparent A W3C `traceparent` header value, if one was sent.
 * @returns `{ traceId }` when the header is well formed, otherwise `{}`.
 */
export function traceReference(traceparent: string | undefined): { readonly traceId?: string } {
  if (!traceparent) return {};
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
  return match?.[1] === undefined ? {} : { traceId: match[1] };
}
