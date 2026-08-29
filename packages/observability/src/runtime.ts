import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Span,
  type TextMapGetter,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type {
  ApplicationTelemetry,
  ApplicationTraceContext,
  TelemetryAttributes,
} from '@private-cloud/application';

/** Process-wide SDK instance. A Node.js process must register global providers only once. */
let sdk: NodeSDK | undefined;

/** Custom instruments are created only after the SDK has installed its global meter provider. */
interface RuntimeInstruments {
  readonly commandAccepted: Counter;
  readonly workflowTransitions: Counter;
  readonly workflowRetries: Counter;
  readonly messagesProcessed: Counter;
  readonly queueResidence: Histogram;
  readonly outboxPublishDelay: Histogram;
  readonly providerDuration: Histogram;
  readonly projectionDuration: Histogram;
  readonly deadLetters: Counter;
  readonly quarantines: Counter;
  readonly replays: Counter;
}

let instruments: RuntimeInstruments | undefined;
const outboxBacklogState = new Map<string, { count: number; oldestAgeSeconds: number }>();

/** Names exposed by the local and Kubernetes OTLP pipelines. */
export const TELEMETRY_INSTRUMENTATION_NAME = 'private-cloud-control-plane';

/** Options that are stable across local containers and Kubernetes deployment. */
export interface TelemetryRuntimeOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
}

/** Narrow text-map getter used for HTTP, gRPC, outbox, and Kafka W3C carriers. */
const carrierGetter: TextMapGetter<Record<string, string | undefined>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase()],
};

/** Parses a bounded integer environment setting or returns the documented default. */
function durationSetting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error(`${name} must be an integer between 1000 and 300000 milliseconds.`);
  }
  return value;
}

/** Removes undefined values before crossing the OpenTelemetry API boundary. */
function attributes(values: TelemetryAttributes): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    }),
  );
}

/** Records a bounded failure without exporting an exception message, stack, or provider payload. */
function recordFailure(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'Operation failed' });
  span.recordException({
    name: error instanceof Error ? error.name : 'UnknownError',
    message: 'Operation failed; inspect correlated restricted logs.',
  });
}

/**
 * Starts the process telemetry SDK before framework and driver modules are imported.
 *
 * Export is deliberately best effort. SDK startup validates only local configuration and never
 * connects synchronously to the Collector, so a telemetry outage cannot block application startup.
 */
export function startTelemetry(options: TelemetryRuntimeOptions): void {
  if (sdk || process.env.OTEL_SDK_DISABLED?.toLowerCase() === 'true') return;
  if (!options.serviceName.trim())
    throw new Error('A non-empty OpenTelemetry service name is required.');

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || 'http://127.0.0.1:4317';
  const exportIntervalMillis = durationSetting('OTEL_METRIC_EXPORT_INTERVAL', 5_000);
  const exportTimeoutMillis = Math.min(
    durationSetting('OTEL_METRIC_EXPORT_TIMEOUT', 4_000),
    exportIntervalMillis,
  );
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: endpoint }),
    exportIntervalMillis,
    exportTimeoutMillis,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.namespace': 'private-cloud-control-plane',
      'service.version': options.serviceVersion ?? process.env.SERVICE_VERSION ?? '0.1.0',
      'service.instance.id': process.env.HOSTNAME ?? `${options.serviceName}-${process.pid}`,
      'deployment.environment.name': process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    metricReaders: [metricReader],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-kafkajs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  instruments = createRuntimeInstruments();
}

/** Flushes and unregisters process telemetry during graceful shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  const activeSdk = sdk;
  sdk = undefined;
  instruments = undefined;
  if (activeSdk) await activeSdk.shutdown();
}

/** Returns safe correlation fields for structured logs. */
export function currentTraceFields(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext?.traceId || !spanContext.spanId) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

/** Emits one-line structured operational logs correlated to the active span. */
export function structuredLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
): void {
  const document = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...currentTraceFields(),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  });
  const output = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  output.write(`${document}\n`);
}

/** Extracts W3C context from a case-normalized transport carrier. */
export function extractTransportContext(
  carrier: Record<string, string | undefined>,
  parent: Context = context.active(),
): Context {
  const normalized = Object.fromEntries(
    Object.entries(carrier).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return propagation.extract(parent, normalized, carrierGetter);
}

/** Injects the active context into a plain string carrier. */
export function activeTraceCarrier(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Executes a bounded span, optionally under context restored from an asynchronous carrier. */
export function withSpan<T>(
  name: string,
  values: TelemetryAttributes,
  operation: () => Promise<T>,
  options: { readonly kind?: SpanKind; readonly parent?: Context } = {},
): Promise<T> {
  const tracer = trace.getTracer(TELEMETRY_INSTRUMENTATION_NAME);
  return tracer.startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: attributes(values) },
    options.parent ?? context.active(),
    async (span): Promise<T> => {
      try {
        return await operation();
      } catch (error: unknown) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Registers custom instruments against the real provider installed by `NodeSDK.start()`. */
function createRuntimeInstruments(): RuntimeInstruments {
  const meter = metrics.getMeter(TELEMETRY_INSTRUMENTATION_NAME);
  const commandAccepted = meter.createCounter('controlplane.command.accepted', {
    unit: '{command}',
    description: 'Durably accepted control-plane commands.',
  });
  const workflowTransitions = meter.createCounter('controlplane.workflow.transition', {
    unit: '{transition}',
    description: 'Persisted workflow stage transitions.',
  });
  const workflowRetries = meter.createCounter('controlplane.workflow.retry', {
    unit: '{retry}',
    description: 'Classified workflow retries.',
  });
  const messagesProcessed = meter.createCounter('controlplane.messaging.processed', {
    unit: '{message}',
    description: 'Kafka delivery outcomes after durable handling.',
  });
  const queueResidence = meter.createHistogram('controlplane.messaging.queue_residence', {
    unit: 's',
    description: 'Time from Kafka broker append to consumer handling.',
  });
  const outboxPublishDelay = meter.createHistogram('controlplane.outbox.publish_delay', {
    unit: 's',
    description: 'Time from domain occurrence to Kafka broker append.',
  });
  const providerDuration = meter.createHistogram('controlplane.provider.operation.duration', {
    unit: 's',
    description: 'Provider-port operation duration.',
  });
  const projectionDuration = meter.createHistogram('controlplane.projection.apply.duration', {
    unit: 's',
    description: 'Projection transaction duration.',
  });
  const deadLetters = meter.createCounter('controlplane.dead_letter', {
    unit: '{message}',
    description: 'Messages moved to governed dead-letter state.',
  });
  const quarantines = meter.createCounter('controlplane.quarantine', {
    unit: '{message}',
    description: 'Unparseable records durably quarantined.',
  });
  const replays = meter.createCounter('controlplane.replay', {
    unit: '{replay}',
    description: 'Governed dead-letter replay outcomes.',
  });
  const outboxBacklog = meter.createObservableGauge('controlplane.outbox.pending', {
    unit: '{record}',
    description: 'Transactional outbox records not yet durably handled by their consumer.',
  });
  outboxBacklog.addCallback((observer) => {
    for (const [owner, value] of outboxBacklogState) {
      observer.observe(value.count, { 'outbox.owner': owner });
    }
  });
  const outboxOldest = meter.createObservableGauge('controlplane.outbox.oldest_age', {
    unit: 's',
    description: 'Age of the oldest transactional outbox record not yet durably consumed.',
  });
  outboxOldest.addCallback((observer) => {
    for (const [owner, value] of outboxBacklogState) {
      observer.observe(value.oldestAgeSeconds, { 'outbox.owner': owner });
    }
  });
  return {
    commandAccepted,
    workflowTransitions,
    workflowRetries,
    messagesProcessed,
    queueResidence,
    outboxPublishDelay,
    providerDuration,
    projectionDuration,
    deadLetters,
    quarantines,
    replays,
  };
}

/** OpenTelemetry implementation of the application-layer telemetry port. */
export class OpenTelemetryApplicationTelemetry implements ApplicationTelemetry {
  /** Executes an application span and records a safe failure when it throws. */
  public trace<T>(
    name: string,
    values: TelemetryAttributes,
    operation: () => Promise<T>,
    parent?: ApplicationTraceContext,
  ): Promise<T> {
    return withSpan(
      name,
      values,
      operation,
      parent
        ? {
            parent: extractTransportContext({
              traceparent: parent.traceparent,
              tracestate: parent.tracestate,
            }),
          }
        : {},
    );
  }

  /** Captures the active W3C carrier for the next persisted asynchronous hop. */
  public currentTraceContext(fallback: ApplicationTraceContext): ApplicationTraceContext {
    const carrier = activeTraceCarrier();
    if (!carrier.traceparent) return fallback;
    return {
      traceparent: carrier.traceparent,
      ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
    };
  }

  /** Counts a durable command outcome. */
  public commandAccepted(commandType: string, outcome: string): void {
    instruments?.commandAccepted.add(1, { 'command.type': commandType, outcome });
  }

  /** Counts a persisted stage transition. */
  public workflowTransition(from: string, to: string): void {
    instruments?.workflowTransitions.add(1, {
      'workflow.stage.from': from,
      'workflow.stage.to': to,
    });
  }

  /** Counts a bounded classified retry. */
  public workflowRetry(stage: string, category: string): void {
    instruments?.workflowRetries.add(1, { 'workflow.stage': stage, 'error.category': category });
  }
}

/** Records a handled Kafka delivery and both asynchronous latency components. */
export function recordMessageProcessed(input: {
  readonly topic: string;
  readonly consumerGroup: string;
  readonly schemaName: string;
  readonly outcome: string;
  readonly brokerTimestampMs: number;
  readonly occurredAtMs: number;
  readonly handledAtMs?: number;
}): void {
  const labels = {
    'messaging.destination.name': input.topic,
    'messaging.consumer.group.name': input.consumerGroup,
    'event.schema.name': input.schemaName,
    outcome: input.outcome,
  };
  const handledAt = input.handledAtMs ?? Date.now();
  instruments?.messagesProcessed.add(1, labels);
  instruments?.queueResidence.record(
    Math.max(0, handledAt - input.brokerTimestampMs) / 1_000,
    labels,
  );
  instruments?.outboxPublishDelay.record(
    Math.max(0, input.brokerTimestampMs - input.occurredAtMs) / 1_000,
    labels,
  );
}

/** Records a provider-port call without provider resource identity. */
export function recordProviderDuration(
  operation: string,
  outcome: string,
  durationSeconds: number,
): void {
  instruments?.providerDuration.record(durationSeconds, {
    'provider.operation': operation,
    outcome,
  });
}

/** Records an event projection transaction. */
export function recordProjectionDuration(
  schemaName: string,
  outcome: string,
  durationSeconds: number,
): void {
  instruments?.projectionDuration.record(durationSeconds, {
    'event.schema.name': schemaName,
    outcome,
  });
}

/** Records one governed dead-letter decision. */
export function recordDeadLetter(
  schemaName: string,
  category: string,
  replayAllowed: boolean,
): void {
  instruments?.deadLetters.add(1, {
    'event.schema.name': schemaName,
    'error.category': category,
    'replay.allowed': replayAllowed,
  });
}

/** Records one raw-record quarantine without raw record identity. */
export function recordQuarantine(reason: string): void {
  instruments?.quarantines.add(1, { reason });
}

/** Records one governed replay result. */
export function recordReplay(outcome: string): void {
  instruments?.replays.add(1, { outcome });
}

/** Updates process-local values observed by the outbox backlog gauges. */
export function updateOutboxBacklog(
  owner: 'control' | 'workflow',
  count: number,
  oldestAgeSeconds: number,
): void {
  outboxBacklogState.set(owner, {
    count: Math.max(0, count),
    oldestAgeSeconds: Math.max(0, oldestAgeSeconds),
  });
}

export { SpanKind };
