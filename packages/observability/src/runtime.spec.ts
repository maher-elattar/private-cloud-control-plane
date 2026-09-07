import { metrics } from '@opentelemetry/api';
import { DataPointType, type MetricData, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HTTP_INSTRUMENTATION_METER,
  HTTP_SERVER_DURATION_INSTRUMENT,
  HTTP_SERVER_DURATION_SCRAPE_NAME,
  HTTP_SERVER_METRIC_ATTRIBUTES,
  STANDARD_AUTO_INSTRUMENTATIONS,
  TELEMETRY_INSTRUMENTATION_NAME,
  OpenTelemetryApplicationTelemetry,
  activeTraceCarrier,
  createInMemoryTelemetryHarness,
  currentTraceFields,
  extractTransportContext,
  recordMessageProcessed,
  recordProjectionDuration,
  recordQuarantine,
  recordReplay,
  shutdownTelemetry,
  startTelemetry,
  updateWorkflowActivity,
} from './runtime.js';

function exportedMetrics(resources: ResourceMetrics[]): MetricData[] {
  return resources.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
}

describe('observability runtime without a registered SDK', () => {
  it('remains a no-op when no span is active', () => {
    expect(currentTraceFields()).toEqual({});
    expect(activeTraceCarrier()).toEqual({});
  });

  it('ignores malformed external W3C context instead of throwing', () => {
    expect(() => extractTransportContext({ traceparent: 'not-a-trace' })).not.toThrow();
  });

  it('keeps the required HTTP, gRPC, PostgreSQL, host, runtime, and Undici signals enabled', () => {
    expect(STANDARD_AUTO_INSTRUMENTATIONS).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-grpc',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-undici',
      '@opentelemetry/instrumentation-host-metrics',
      '@opentelemetry/instrumentation-runtime-node',
    ]);
  });

  it('exports replay links, bounded histogram buckets, gauges, and allowlisted labels', async () => {
    const harness = createInMemoryTelemetryHarness();
    startTelemetry({
      serviceName: 'observability-test',
      spanProcessor: harness.spanProcessor,
      metricReader: harness.metricReader,
      disableAutoInstrumentation: true,
    });

    const linkedTraceId = '11111111111111111111111111111111';
    const applicationTelemetry = new OpenTelemetryApplicationTelemetry();
    await applicationTelemetry.trace(
      'controlplane.replay.request',
      { 'command.type': 'replay_dead_letter' },
      async () => undefined,
      undefined,
      [{ traceparent: `00-${linkedTraceId}-2222222222222222-01` }],
    );
    applicationTelemetry.deadLetter('instance.mutation.failed', 'unavailable', true);
    recordMessageProcessed({
      topic: 'provisioning.commands.v1',
      consumerGroup: 'provisioning-orchestrator.v1',
      schemaName: 'instance.create.requested',
      outcome: 'handled',
      brokerTimestampMs: 2_000,
      occurredAtMs: 1_000,
      handledAtMs: 3_000,
    });
    recordProjectionDuration('workflow.progressed', 'applied', 0.025, Date.now() - 2_000);
    updateWorkflowActivity(3, 7);

    // Both halves of the two-phase replay can reject, for unrelated reasons. Before `phase`
    // existed these two calls collapsed into one indistinguishable series.
    recordReplay('rejected', 'request');
    recordReplay('rejected', 'command');
    recordQuarantine('REPLAY_COMMAND_STATE_CONFLICT');

    // The view must strip this prohibited identity even when an instrument is used incorrectly.
    metrics
      .getMeter(TELEMETRY_INSTRUMENTATION_NAME)
      .createCounter('controlplane.replay', { unit: '{replay}' })
      .add(1, { outcome: 'accepted', 'event.id': 'must-not-be-exported' });

    await harness.metricReader.forceFlush();

    const replaySpan = harness.spanExporter
      .getFinishedSpans()
      .find((span) => span.name === 'controlplane.replay.request');
    expect(replaySpan?.links).toHaveLength(1);
    expect(replaySpan?.links[0]?.context.traceId).toBe(linkedTraceId);

    const exported = exportedMetrics(harness.metricExporter.getMetrics());
    const queueResidence = exported.find(
      (metric) => metric.descriptor.name === 'controlplane.messaging.queue_residence',
    );
    expect(queueResidence?.dataPointType).toBe(DataPointType.HISTOGRAM);
    if (queueResidence?.dataPointType !== DataPointType.HISTOGRAM) {
      throw new Error('Expected queue residence to be exported as a histogram.');
    }
    expect(queueResidence.dataPoints[0]?.value.buckets.boundaries).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900,
    ]);

    const active = exported.find(
      (metric) => metric.descriptor.name === 'controlplane.workflow.active',
    );
    expect(active?.dataPoints[0]?.value).toBe(3);
    const oldest = exported.find(
      (metric) => metric.descriptor.name === 'controlplane.workflow.oldest_ready.age',
    );
    expect(oldest?.dataPoints[0]?.value).toBe(7);
    const replay = exported.find((metric) => metric.descriptor.name === 'controlplane.replay');
    expect(replay?.dataPoints.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([
        { outcome: 'rejected', phase: 'request' },
        { outcome: 'rejected', phase: 'command' },
        // The prohibited-attribute counter above carries no phase, proving the view strips
        // `event.id` rather than the whole data point.
        { outcome: 'accepted' },
      ]),
    );
    const quarantine = exported.find(
      (metric) => metric.descriptor.name === 'controlplane.quarantine',
    );
    expect(quarantine?.dataPoints[0]?.attributes).toEqual({
      'failure.code': 'REPLAY_COMMAND_STATE_CONFLICT',
    });
    const deadLetter = exported.find(
      (metric) => metric.descriptor.name === 'controlplane.dead_letter',
    );
    expect(deadLetter?.dataPoints[0]?.attributes).toEqual({
      'event.schema.name': 'instance.mutation.failed',
      'error.category': 'unavailable',
      'replay.allowed': true,
    });
    expect(JSON.stringify(exported)).not.toContain('must-not-be-exported');
    await shutdownTelemetry();
  });
});

/**
 * The Rollout promotion gate reads the HTTP server histogram out of Prometheus, one pod at a
 * time. These cases pin the three things that gate depends on: that the scrape endpoint exists
 * only when it is asked for, that what it publishes carries the dimensions the analysis query
 * names, and that it carries none of the identities the metric-label contract forbids.
 */
describe('prometheus scrape endpoint for rollout analysis', () => {
  const scrapePort = 19_464;

  beforeEach(() => {
    // `startTelemetry` installs process-global providers, and the OpenTelemetry API keeps the
    // first registration it is given. Without this, every test after the first would silently
    // record through the previous test's provider and see an empty scrape.
    metrics.disable();
  });

  afterEach(async () => {
    delete process.env.PROMETHEUS_METRICS_PORT;
    delete process.env.PROMETHEUS_METRICS_HOST;
    await shutdownTelemetry();
    metrics.disable();
  });

  it('stays off when no port is configured', async () => {
    const harness = createInMemoryTelemetryHarness();
    startTelemetry({
      serviceName: 'scrape-disabled',
      spanProcessor: harness.spanProcessor,
      metricReader: harness.metricReader,
      disableAutoInstrumentation: true,
    });

    await expect(fetch(`http://127.0.0.1:${scrapePort}/metrics`)).rejects.toThrow();
  });

  it('rejects a port outside the valid range instead of binding a wrong one', () => {
    process.env.PROMETHEUS_METRICS_PORT = '70000';
    expect(() =>
      startTelemetry({ serviceName: 'scrape-invalid', disableAutoInstrumentation: true }),
    ).toThrow(/PROMETHEUS_METRICS_PORT/);
  });

  it('publishes the request histogram with allowlisted dimensions and no host identity', async () => {
    process.env.PROMETHEUS_METRICS_PORT = String(scrapePort);
    process.env.PROMETHEUS_METRICS_HOST = '127.0.0.1';
    const harness = createInMemoryTelemetryHarness();
    startTelemetry({
      serviceName: 'scrape-enabled',
      spanProcessor: harness.spanProcessor,
      metricReader: harness.metricReader,
      disableAutoInstrumentation: true,
    });

    // Stands in for `@opentelemetry/instrumentation-http`, which is disabled in unit tests. The
    // view keys on the instrument name and the meter name, so recording through both exercises
    // the exact production path.
    metrics
      .getMeter(HTTP_INSTRUMENTATION_METER)
      .createHistogram(HTTP_SERVER_DURATION_INSTRUMENT, { unit: 's' })
      .record(0.012, {
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'http.route': '/v1/projects/{projectId}/instances',
        // Forbidden as metric labels. The Collector strips these on the OTLP path; on the scrape
        // path only this view can.
        'server.address': 'control-api.private-cloud.svc.cluster.local',
        'network.peer.address': '10.244.0.17',
      });

    const response = await fetch(`http://127.0.0.1:${scrapePort}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain(`${HTTP_SERVER_DURATION_SCRAPE_NAME}_count`);
    expect(body).toContain('http_response_status_code="200"');
    expect(body).toContain('http_route="/v1/projects/{projectId}/instances"');
    // A bucket layout that drifts silently invalidates every dashboard and alert built on it.
    expect(body).toContain(`${HTTP_SERVER_DURATION_SCRAPE_NAME}_bucket`);
    expect(body).toContain('le="0.075"');
    expect(body).not.toContain('server_address');
    expect(body).not.toContain('network_peer_address');
    expect(body).not.toContain('10.244.0.17');

    // `target_info` publishes the whole resource. Host name, process owner, and the process
    // command line must never reach it.
    expect(body).not.toContain('host_name');
    expect(body).not.toContain('process_owner');
    expect(body).not.toContain('process_command');
    expect(body).toContain('service_name="scrape-enabled"');
  });

  it('keeps the allow list to dimensions the promotion query can rely on', () => {
    expect(HTTP_SERVER_METRIC_ATTRIBUTES).toEqual([
      'http.request.method',
      'http.response.status_code',
      'http.route',
      'error.type',
    ]);
  });
});
