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
  type Link,
  type Span,
  type TextMapGetter,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  AggregationType,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  type IMetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
// A **type-only** import, so nothing from the application layer survives into the bundle. It is
// declared as a devDependency for exactly that reason: listing it as a runtime dependency made
// every service image carry the whole application layer plus its own transitive graph — five
// workspace modules — for three interfaces that are erased at build time.
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
  readonly projectionEventAge: Histogram;
  readonly deadLetters: Counter;
  readonly quarantines: Counter;
  readonly replays: Counter;
}

let instruments: RuntimeInstruments | undefined;
const outboxBacklogState = new Map<string, { count: number; oldestAgeSeconds: number }>();
let workflowActivityState = { active: 0, oldestReadyAgeSeconds: 0 };

const ASYNC_LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900,
];
const OPERATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const METRIC_CARDINALITY_LIMIT = 128;

/**
 * Attributes retained on the HTTP server duration histogram.
 *
 * WHY an allow list rather than the instrumentation's defaults: `@opentelemetry/instrumentation-http`
 * emits `server.address`, `server.port`, `network.peer.address`, and `url.scheme` alongside the
 * useful dimensions. Addresses are forbidden as metric labels (SAFE-034), and the Collector strips
 * them on the OTLP path. The scrape path has no Collector in front of it, so the contract has to
 * hold at the SDK, which is where this package already enforces every other attribute contract.
 */
export const HTTP_SERVER_METRIC_ATTRIBUTES = [
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'error.type',
] as const;

/** Instrument and meter emitting the request histogram that rollout analysis reads. */
export const HTTP_SERVER_DURATION_INSTRUMENT = 'http.server.request.duration';
export const HTTP_INSTRUMENTATION_METER = '@opentelemetry/instrumentation-http';

/**
 * Prometheus name the {@link HTTP_SERVER_DURATION_INSTRUMENT} histogram is scraped under.
 *
 * Blue-green promotion analysis queries this series, so the mapping from the OpenTelemetry name
 * to the Prometheus name is asserted by a test rather than left to the exporter's conventions.
 */
export const HTTP_SERVER_DURATION_SCRAPE_NAME = 'http_server_request_duration';

/**
 * Series ceiling for the HTTP server histogram.
 *
 * Higher than {@link METRIC_CARDINALITY_LIMIT} because the dimensions are a genuine cross product
 * of routes, methods, and status codes rather than a small closed enumeration: 39 REST routes and
 * the health endpoints, times the methods each accepts, times the status codes each can return.
 * The value is still a hard ceiling, so a route explosion degrades to an overflow bucket instead
 * of unbounded memory.
 */
const HTTP_SERVER_CARDINALITY_LIMIT = 512;

/**
 * Bucket boundaries for the HTTP server histogram, in seconds.
 *
 * Pinned rather than left to instrumentation advice for the same reason every other histogram in
 * this file is pinned: a bucket layout that changes underneath a dashboard or an alert silently
 * invalidates both. These are the boundaries the HTTP semantic conventions recommend.
 */
const HTTP_SERVER_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** Default port for the scrape endpoint when one is enabled but not configured. */
const DEFAULT_PROMETHEUS_SCRAPE_PORT = 9464;

/** Attribute contracts are enforced by SDK views, not merely by call-site convention. */
const CUSTOM_METRIC_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  'controlplane.command.accepted': ['command.type', 'outcome'],
  'controlplane.messaging.processed': [
    'messaging.destination.name',
    'messaging.consumer.group.name',
    'event.schema.name',
    'outcome',
  ],
  'controlplane.messaging.queue_residence': [
    'messaging.destination.name',
    'messaging.consumer.group.name',
    'event.schema.name',
    'outcome',
  ],
  'controlplane.outbox.publish_delay': [
    'messaging.destination.name',
    'messaging.consumer.group.name',
    'event.schema.name',
    'outcome',
  ],
  'controlplane.workflow.transition': ['workflow.stage.from', 'workflow.stage.to'],
  'controlplane.workflow.retry': ['workflow.stage', 'error.category'],
  'controlplane.workflow.active': [],
  'controlplane.workflow.oldest_ready.age': [],
  'controlplane.provider.operation.duration': ['provider.operation', 'outcome'],
  'controlplane.projection.apply.duration': ['event.schema.name', 'outcome'],
  'controlplane.projection.event_age': ['event.schema.name', 'outcome'],
  'controlplane.dead_letter': ['event.schema.name', 'error.category', 'replay.allowed'],
  'controlplane.quarantine': ['failure.code'],
  'controlplane.replay': ['outcome', 'phase'],
  'controlplane.outbox.pending': ['outbox.owner'],
  'controlplane.outbox.oldest_age': ['outbox.owner'],
};

const HISTOGRAM_BUCKETS: Readonly<Record<string, readonly number[]>> = {
  'controlplane.messaging.queue_residence': ASYNC_LATENCY_BUCKETS_SECONDS,
  'controlplane.outbox.publish_delay': ASYNC_LATENCY_BUCKETS_SECONDS,
  'controlplane.provider.operation.duration': OPERATION_BUCKETS_SECONDS,
  'controlplane.projection.apply.duration': OPERATION_BUCKETS_SECONDS,
  'controlplane.projection.event_age': ASYNC_LATENCY_BUCKETS_SECONDS,
};

/** Names exposed by the local and Kubernetes OTLP pipelines. */
export const TELEMETRY_INSTRUMENTATION_NAME = 'private-cloud-control-plane';

/** Standard signals deliberately retained alongside manual control-plane instrumentation. */
export const STANDARD_AUTO_INSTRUMENTATIONS = [
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-grpc',
  '@opentelemetry/instrumentation-pg',
  '@opentelemetry/instrumentation-undici',
  '@opentelemetry/instrumentation-host-metrics',
  '@opentelemetry/instrumentation-runtime-node',
] as const;

/** Options that are stable across local containers and Kubernetes deployment. */
export interface TelemetryRuntimeOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** Test-only exporter injection; production leaves this unset and uses OTLP/gRPC. */
  readonly traceExporter?: SpanExporter;
  /** Test-only processor injection for deterministic synchronous span export. */
  readonly spanProcessor?: SpanProcessor;
  /** Test-only reader injection; production leaves this unset and uses periodic OTLP export. */
  readonly metricReader?: IMetricReader;
  /** Avoids patching process modules in deterministic unit tests. */
  readonly disableAutoInstrumentation?: boolean;
}

/** Exporters and reader used to assert actual SDK output without a Collector. */
export interface InMemoryTelemetryHarness {
  readonly spanExporter: InMemorySpanExporter;
  readonly spanProcessor: SimpleSpanProcessor;
  readonly metricExporter: InMemoryMetricExporter;
  readonly metricReader: PeriodicExportingMetricReader;
}

/** Creates deterministic exporters and readers for SDK-level telemetry tests. */
export function createInMemoryTelemetryHarness(): InMemoryTelemetryHarness {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  return {
    spanExporter,
    spanProcessor: new SimpleSpanProcessor(spanExporter),
    metricExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 300_000,
      exportTimeoutMillis: 10_000,
    }),
  };
}

/** Builds one exact SDK view per custom instrument to bound labels and series cardinality. */
function metricViews(): ViewOptions[] {
  const customViews = Object.entries(CUSTOM_METRIC_ATTRIBUTES).map(([instrumentName, allowed]) => ({
    instrumentName,
    meterName: TELEMETRY_INSTRUMENTATION_NAME,
    attributesProcessors: [createAllowListAttributesProcessor([...allowed])],
    aggregationCardinalityLimit: METRIC_CARDINALITY_LIMIT,
    ...(HISTOGRAM_BUCKETS[instrumentName]
      ? {
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const,
            options: { boundaries: [...HISTOGRAM_BUCKETS[instrumentName]] },
          },
        }
      : {}),
  }));

  return [
    ...customViews,
    {
      instrumentName: HTTP_SERVER_DURATION_INSTRUMENT,
      meterName: HTTP_INSTRUMENTATION_METER,
      attributesProcessors: [
        createAllowListAttributesProcessor([...HTTP_SERVER_METRIC_ATTRIBUTES]),
      ],
      aggregationCardinalityLimit: HTTP_SERVER_CARDINALITY_LIMIT,
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const,
        options: { boundaries: [...HTTP_SERVER_DURATION_BUCKETS_SECONDS] },
      },
    },
  ];
}

/**
 * Builds the scrape reader when a port is configured, and nothing otherwise.
 *
 * WHY a second reader rather than reusing the Collector's Prometheus exporter: the Collector
 * aggregates every replica into one series set, which is exactly the wrong shape for blue-green
 * analysis. A promotion decision has to be able to read the green replicas alone, and the only
 * dimension that separates them from the blue ones is the pod they run in. Scraping each pod
 * directly preserves that dimension; pushing through a shared Collector destroys it.
 *
 * Both readers observe the same instruments and views, so the scrape endpoint cannot disagree
 * with the OTLP pipeline about what a metric means.
 *
 * @returns {PrometheusExporter | undefined} Reader to install, or `undefined` when unconfigured.
 */
function prometheusScrapeReader(): PrometheusExporter | undefined {
  const raw = process.env.PROMETHEUS_METRICS_PORT?.trim();
  if (!raw) return undefined;
  const port = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PROMETHEUS_METRICS_PORT must be an integer between 1 and 65535.');
  }
  return new PrometheusExporter({
    port: port === 0 ? DEFAULT_PROMETHEUS_SCRAPE_PORT : port,
    host: process.env.PROMETHEUS_METRICS_HOST?.trim() || '0.0.0.0',
    endpoint: process.env.PROMETHEUS_METRICS_PATH?.trim() || '/metrics',
    // Scrape-side target metadata is supplied by the scrape configuration, not by the process.
    appendTimestamp: false,
  });
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
  const metricReader =
    options.metricReader ??
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: endpoint }),
      exportIntervalMillis,
      exportTimeoutMillis,
    });

  const scrapeReader = prometheusScrapeReader();

  sdk = new NodeSDK({
    // WHY no detectors: the default set adds `host.name`, `process.command_line`,
    // `process.owner`, and the full argv to every exported resource. The Collector deletes all of
    // it on the OTLP path, but the scrape endpoint publishes the resource as `target_info` with
    // no Collector in front of it. Not collecting host and process identity in the first place is
    // the only version of this that is true on both pipelines.
    resourceDetectors: [],
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.namespace': 'private-cloud-control-plane',
      'service.version': options.serviceVersion ?? process.env.SERVICE_VERSION ?? '0.1.0',
      'service.instance.id': process.env.HOSTNAME ?? `${options.serviceName}-${process.pid}`,
      'deployment.environment.name': process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    ...(options.spanProcessor
      ? { spanProcessors: [options.spanProcessor] }
      : { traceExporter: options.traceExporter ?? new OTLPTraceExporter({ url: endpoint }) }),
    metricReaders: scrapeReader ? [metricReader, scrapeReader] : [metricReader],
    views: metricViews(),
    instrumentations: options.disableAutoInstrumentation
      ? []
      : [
          getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-dns': { enabled: false },
            '@opentelemetry/instrumentation-fs': { enabled: false },
            '@opentelemetry/instrumentation-kafkajs': { enabled: false },
            '@opentelemetry/instrumentation-net': { enabled: false },
            '@opentelemetry/instrumentation-grpc': { enabled: true },
            '@opentelemetry/instrumentation-host-metrics': { enabled: true },
            '@opentelemetry/instrumentation-http': { enabled: true },
            '@opentelemetry/instrumentation-pg': { enabled: true },
            '@opentelemetry/instrumentation-runtime-node': { enabled: true },
            '@opentelemetry/instrumentation-undici': { enabled: true },
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
  options: {
    readonly kind?: SpanKind;
    readonly parent?: Context;
    readonly links?: readonly Context[];
  } = {},
): Promise<T> {
  const tracer = trace.getTracer(TELEMETRY_INSTRUMENTATION_NAME);
  const links: Link[] = (options.links ?? [])
    .map((linkedContext) => trace.getSpanContext(linkedContext))
    .filter((spanContext): spanContext is NonNullable<typeof spanContext> => Boolean(spanContext))
    .map((spanContext) => ({ context: spanContext }));
  return tracer.startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: attributes(values), links },
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
  const projectionEventAge = meter.createHistogram('controlplane.projection.event_age', {
    unit: 's',
    description: 'Time from domain occurrence to projection transaction completion.',
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
  const workflowActive = meter.createObservableGauge('controlplane.workflow.active', {
    unit: '{workflow}',
    description: 'Provisioning workflows that have not reached a terminal state.',
  });
  workflowActive.addCallback((observer) => observer.observe(workflowActivityState.active));
  const workflowOldestReady = meter.createObservableGauge(
    'controlplane.workflow.oldest_ready.age',
    {
      unit: 's',
      description: 'Age of the oldest workflow currently eligible to be claimed.',
    },
  );
  workflowOldestReady.addCallback((observer) =>
    observer.observe(workflowActivityState.oldestReadyAgeSeconds),
  );
  return {
    commandAccepted,
    workflowTransitions,
    workflowRetries,
    messagesProcessed,
    queueResidence,
    outboxPublishDelay,
    providerDuration,
    projectionDuration,
    projectionEventAge,
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
    links: readonly ApplicationTraceContext[] = [],
  ): Promise<T> {
    return withSpan(name, values, operation, {
      ...(parent
        ? {
            parent: extractTransportContext({
              traceparent: parent.traceparent,
              tracestate: parent.tracestate,
            }),
          }
        : {}),
      links: links.map((link) =>
        extractTransportContext({
          traceparent: link.traceparent,
          tracestate: link.tracestate,
        }),
      ),
    });
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

  /** Counts a governed workflow dead letter after durable owner storage succeeds. */
  public deadLetter(schemaName: string, category: string, replayAllowed: boolean): void {
    recordDeadLetter(schemaName, category, replayAllowed);
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
  occurredAtMs?: number,
): void {
  const labels = {
    'event.schema.name': schemaName,
    outcome,
  };
  instruments?.projectionDuration.record(durationSeconds, labels);
  if (occurredAtMs !== undefined && Number.isFinite(occurredAtMs)) {
    instruments?.projectionEventAge.record(Math.max(0, Date.now() - occurredAtMs) / 1_000, labels);
  }
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
export function recordQuarantine(failureCode: string): void {
  instruments?.quarantines.add(1, { 'failure.code': failureCode });
}

/**
 * Records one governed replay decision.
 *
 * `phase` separates the two decisions this counter used to conflate: authorizing an
 * administrator's replay *request*, and admitting the restored *command* when Kafka delivers it
 * back. Both can be rejected, for entirely different reasons, and an operator reading a spike in
 * rejections needs to know which half of the loop produced it.
 *
 * @param outcome Result of the decision, e.g. `accepted`, `duplicate`, `rejected`.
 * @param phase Which half of the two-phase replay produced this outcome.
 */
export function recordReplay(outcome: string, phase: 'request' | 'command'): void {
  instruments?.replays.add(1, { outcome, phase });
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

/** Updates process-local values observed by the workflow activity gauges. */
export function updateWorkflowActivity(active: number, oldestReadyAgeSeconds: number): void {
  workflowActivityState = {
    active: Math.max(0, active),
    oldestReadyAgeSeconds: Math.max(0, oldestReadyAgeSeconds),
  };
}

export { SpanKind };
