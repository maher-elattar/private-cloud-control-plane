/** Low-cardinality attributes allowed on application spans and metrics. */
export type TelemetryAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

/** Vendor-neutral W3C carrier persisted across asynchronous boundaries. */
export interface ApplicationTraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

/**
 * Cross-cutting telemetry required by application use cases.
 *
 * The port keeps the application independent from an SDK and gives tests a no-op default. Domain
 * identifiers may be span attributes, but callers must never pass them to metric methods.
 */
export interface ApplicationTelemetry {
  /** Executes one application operation inside a short-lived span. */
  trace<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: () => Promise<T>,
    parent?: ApplicationTraceContext,
    links?: readonly ApplicationTraceContext[],
  ): Promise<T>;
  /** Captures the active span carrier, falling back when telemetry is disabled. */
  currentTraceContext(fallback: ApplicationTraceContext): ApplicationTraceContext;
  /** Counts a command acceptance outcome without high-cardinality request identity. */
  commandAccepted(commandType: string, outcome: string): void;
  /** Counts a persisted workflow transition. */
  workflowTransition(from: string, to: string): void;
  /** Records one classified workflow retry. */
  workflowRetry(stage: string, category: string): void;
  /** Counts one governed dead-letter decision after its owner transaction commits. */
  deadLetter(schemaName: string, category: string, replayAllowed: boolean): void;
}

/** Default used by unit tests and by runtimes that deliberately disable telemetry. */
export const NOOP_APPLICATION_TELEMETRY: ApplicationTelemetry = {
  trace: async <T>(
    _name: string,
    _attributes: TelemetryAttributes,
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
  currentTraceContext: (fallback) => fallback,
  commandAccepted: () => undefined,
  workflowTransition: () => undefined,
  workflowRetry: () => undefined,
  deadLetter: () => undefined,
};
