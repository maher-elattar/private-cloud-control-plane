import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  isInstanceMutationCompletedV1,
  isInstanceMutationFailedV1,
  isProvisioningDeadLetteredV1,
  isProvisioningReplayResolvedV1,
  isWorkflowProgressedV1,
  type ProjectionStore,
  type WorkflowEvent,
} from '@private-cloud/application';
import type { ProvisioningDeadLetteredV1 } from '@private-cloud/contracts';
import {
  KafkaConsumerRunner,
  MessageDecodeError,
  PermanentMessageError,
  decodeEventEnvelope,
  kafkaBrokers,
  type IncomingKafkaRecord,
  type MessageHandlingResult,
} from '@private-cloud/messaging';
import {
  recordProjectionDuration,
  recordQuarantine,
  structuredLog,
  withSpan,
} from '@private-cloud/observability';
import { PROJECTION_STORE } from '../tokens';

const EVENT_TOPIC = 'provisioning.events.v1';
const DLQ_TOPIC = 'provisioning.dlq.v1';

/** Narrows the three workflow event variants accepted by the projection. */
function workflowEvent(record: IncomingKafkaRecord): WorkflowEvent {
  const event = decodeEventEnvelope(record.value);
  const supported =
    isWorkflowProgressedV1(event) ||
    isInstanceMutationCompletedV1(event) ||
    isInstanceMutationFailedV1(event) ||
    isProvisioningReplayResolvedV1(event);
  if (!supported) {
    throw new PermanentMessageError(
      'PROJECTION_SCHEMA_UNSUPPORTED',
      'Workflow event schema or version is unsupported.',
    );
  }
  return event as WorkflowEvent;
}

/** Narrows the governed DLQ event projected for administrator readback. */
function deadLetterEvent(record: IncomingKafkaRecord): ProvisioningDeadLetteredV1 {
  const event = decodeEventEnvelope(record.value);
  if (!isProvisioningDeadLetteredV1(event)) {
    throw new PermanentMessageError(
      'DLQ_SCHEMA_UNSUPPORTED',
      'Dead-letter event schema or version is unsupported.',
    );
  }
  return event as ProvisioningDeadLetteredV1;
}

/** Kafka-owned CQRS projection boundary for workflow and DLQ topics. */
@Injectable()
export class ProjectionConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly events: KafkaConsumerRunner;
  private readonly deadLetters: KafkaConsumerRunner;

  public constructor(@Inject(PROJECTION_STORE) private readonly store: ProjectionStore) {
    const brokers = kafkaBrokers();
    this.events = this.runner(EVENT_TOPIC, 'control-api.provisioning-events.v1', brokers);
    this.deadLetters = this.runner(DLQ_TOPIC, 'control-api.provisioning-dlq.v1', brokers);
  }

  public async onApplicationBootstrap(): Promise<void> {
    await Promise.all([this.events.start(), this.deadLetters.start()]);
  }

  /** Kafka drains before the later database lifecycle hook closes the pool. */
  public async onModuleDestroy(): Promise<void> {
    await Promise.all([this.events.stop(), this.deadLetters.stop()]);
  }

  private runner(topic: string, groupId: string, brokers: readonly string[]): KafkaConsumerRunner {
    return new KafkaConsumerRunner({
      clientId: `${process.env.HOSTNAME ?? `control-api-${process.pid}`}-${topic}`,
      groupId,
      topic,
      brokers,
      maximumAttempts: Number.parseInt(process.env.KAFKA_HANDLER_MAX_ATTEMPTS ?? '3', 10),
      handle: (record) => this.handle(record),
      exhausted: (record, error) => this.exhausted(record, error),
    });
  }

  private async handle(record: IncomingKafkaRecord): Promise<MessageHandlingResult> {
    const started = performance.now();
    if (record.delivery.topic === EVENT_TOPIC) {
      const event = workflowEvent(record);
      const outcome = await withSpan(
        'controlplane.projection.apply',
        { 'event.schema.name': event.schemaName },
        () => this.store.applyWorkflowEvent(event, record.delivery),
      );
      recordProjectionDuration(
        event.schemaName,
        outcome,
        (performance.now() - started) / 1_000,
        Date.parse(event.occurredAt),
      );
      structuredLog('info', 'workflow_event_projected', {
        schema_name: event.schemaName,
        outcome,
        operation_id: event.operationId,
        instance_id: event.aggregateId,
      });
      return {
        outcome: outcome === 'applied' ? 'handled' : 'duplicate',
        schemaName: event.schemaName,
        occurredAtMs: Date.parse(event.occurredAt),
      };
    }
    const event = deadLetterEvent(record);
    const outcome = await withSpan(
      'controlplane.projection.apply',
      { 'event.schema.name': event.schemaName },
      () => this.store.applyDeadLetterEvent(event, record.delivery),
    );
    recordProjectionDuration(
      event.schemaName,
      outcome,
      (performance.now() - started) / 1_000,
      Date.parse(event.occurredAt),
    );
    return {
      outcome: outcome === 'applied' ? 'handled' : 'duplicate',
      schemaName: event.schemaName,
      occurredAtMs: Date.parse(event.occurredAt),
    };
  }

  private async exhausted(
    record: IncomingKafkaRecord,
    error: unknown,
  ): Promise<MessageHandlingResult> {
    if (!(error instanceof MessageDecodeError) && !(error instanceof PermanentMessageError)) {
      throw error;
    }
    const outcome = await this.store.quarantineRecord({
      delivery: record.delivery,
      ...(record.envelope ? { eventId: record.envelope.eventId } : {}),
      payloadHash: createHash('sha256')
        .update(record.value ?? Buffer.alloc(0))
        .digest('hex'),
      failureCode: error.code,
      safeMessage: 'The projection record could not be handled by this contract version.',
    });
    recordQuarantine(error.code);
    return {
      outcome: outcome === 'quarantined' ? 'quarantined' : 'duplicate',
      schemaName: record.envelope?.schemaName ?? 'unknown',
      occurredAtMs: record.envelope
        ? Date.parse(record.envelope.occurredAt)
        : record.delivery.brokerTimestampMs,
    };
  }
}
