import { metrics } from '@opentelemetry/api';
import { DataPointType, type MetricData, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import {
  STANDARD_AUTO_INSTRUMENTATIONS,
  TELEMETRY_INSTRUMENTATION_NAME,
  OpenTelemetryApplicationTelemetry,
  activeTraceCarrier,
  createInMemoryTelemetryHarness,
  currentTraceFields,
  extractTransportContext,
  recordMessageProcessed,
  recordProjectionDuration,
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
    expect(replay?.dataPoints[0]?.attributes).toEqual({ outcome: 'accepted' });
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
