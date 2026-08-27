/** W3C fields that can cross an outbox boundary. */
export interface PersistedTraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

/**
 * Serializes W3C context in the `java.util.Properties` form expected by Debezium's Event Router.
 *
 * Values are escaped even though valid W3C carriers cannot contain newlines. Keeping the encoder
 * defensive prevents a future caller from turning one database row into multiple properties.
 */
export function serializeDebeziumTraceContext(context: PersistedTraceContext): string {
  const escape = (value: string): string =>
    value.replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  const fields = [`traceparent=${escape(context.traceparent)}`];
  if (context.tracestate) fields.push(`tracestate=${escape(context.tracestate)}`);
  return `${fields.join('\n')}\n`;
}
