import {
  SpanKind,
  extractTransportContext,
  recordMessageProcessed,
  structuredLog,
  withSpan,
} from '@private-cloud/observability';
import { Kafka, logLevel, type Consumer, type KafkaMessage } from 'kafkajs';
import {
  MessageDecodeError,
  decodeOutboxId,
  decodeEventEnvelope,
  decodeReplayGeneration,
  type DecodedEventEnvelope,
  validateEventTransport,
} from './message-codec.js';

/** Broker identity retained with every durable inbox receipt. */
export interface MessageDelivery {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly brokerTimestampMs: number;
  readonly replayGeneration: number;
  readonly outboxId?: string;
}

/** Raw Kafka delivery passed to a bounded application handler. */
export interface IncomingKafkaRecord {
  readonly delivery: MessageDelivery;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly envelope?: DecodedEventEnvelope;
  /** Trust-boundary failure deferred to the bounded exhaustion path for durable quarantine. */
  readonly decodeError?: MessageDecodeError;
}

/** Durable processing result used for common tracing and metrics. */
export interface MessageHandlingResult {
  readonly outcome: 'handled' | 'duplicate' | 'dead_lettered' | 'quarantined';
  readonly schemaName: string;
  readonly occurredAtMs: number;
}

/** Construction contract for an explicitly committed, bounded-retry Kafka consumer. */
export interface KafkaConsumerRunnerOptions {
  readonly clientId: string;
  readonly groupId: string;
  readonly topic: string;
  readonly brokers: readonly string[];
  readonly maximumAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly handle: (record: IncomingKafkaRecord) => Promise<MessageHandlingResult>;
  readonly exhausted: (
    record: IncomingKafkaRecord,
    error: unknown,
    attempts: number,
  ) => Promise<MessageHandlingResult>;
}

/**
 * KafkaJS consumer with explicit offset commits and bounded handler retries.
 *
 * The offset advances only after the handler or exhaustion callback commits durable evidence.
 * A crash between the database commit and this offset commit intentionally redelivers the record;
 * consumer inbox identity makes that replay harmless.
 */
export class KafkaConsumerRunner {
  private readonly consumer: Consumer;
  private readonly maximumAttempts: number;
  private readonly retryBackoffMs: number;

  public constructor(private readonly options: KafkaConsumerRunnerOptions) {
    if (!options.brokers.length) throw new Error('At least one Kafka broker is required.');
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
    if (
      !Number.isInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 10
    ) {
      throw new Error('Kafka handler maximum attempts must be between 1 and 10.');
    }
    const kafka = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      logLevel: logLevel.NOTHING,
      retry: { retries: 8, initialRetryTime: 250, maxRetryTime: 10_000 },
    });
    this.consumer = kafka.consumer({
      groupId: options.groupId,
      allowAutoTopicCreation: false,
      maxWaitTimeInMs: 1_000,
      retry: { retries: 8, initialRetryTime: 250, maxRetryTime: 10_000 },
    });
  }

  /** Connects, subscribes, and starts sequential per-partition handling. */
  public async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.options.topic, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: 1,
      eachMessage: async ({ topic, partition, message, heartbeat }) => {
        const consumedAtMs = Date.now();
        const record = this.record(topic, partition, message);
        const parentCarrier = record.headers.traceparent
          ? {
              traceparent: record.headers.traceparent,
              ...(record.headers.tracestate ? { tracestate: record.headers.tracestate } : {}),
            }
          : record.envelope
            ? {
                traceparent: record.envelope.traceContext.traceparent,
                ...(record.envelope.traceContext.tracestate
                  ? { tracestate: record.envelope.traceContext.tracestate }
                  : {}),
              }
            : undefined;
        const parent = parentCarrier ? extractTransportContext(parentCarrier) : undefined;
        await withSpan(
          `${topic} process`,
          {
            'messaging.system': 'kafka',
            'messaging.destination.name': topic,
            'messaging.consumer.group.name': this.options.groupId,
            'messaging.kafka.partition': partition,
            'messaging.kafka.offset': message.offset,
            'event.schema.name': record.envelope?.schemaName ?? 'unknown',
          },
          async () => {
            const handled = await this.handleWithRetry(record, heartbeat);
            // Record while the consumer span is active so trace-aware metric SDKs can retain an
            // exemplar. The Collector span-metrics path supplies exemplars for the current JS SDK.
            recordMessageProcessed({
              topic,
              consumerGroup: this.options.groupId,
              schemaName: handled.schemaName,
              outcome: handled.outcome,
              brokerTimestampMs: record.delivery.brokerTimestampMs,
              occurredAtMs: handled.occurredAtMs,
              handledAtMs: consumedAtMs,
            });
            return handled;
          },
          { kind: SpanKind.CONSUMER, ...(parent ? { parent } : {}) },
        );
        await this.consumer.commitOffsets([
          { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
      },
    });
    structuredLog('info', 'kafka_consumer_started', {
      topic: this.options.topic,
      consumer_group: this.options.groupId,
    });
  }

  /** Stops fetches, completes in-flight handling, and disconnects. */
  public async stop(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async handleWithRetry(
    record: IncomingKafkaRecord,
    heartbeat: () => Promise<void>,
  ): Promise<MessageHandlingResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      try {
        if (record.decodeError) throw record.decodeError;
        return await this.options.handle(record);
      } catch (error: unknown) {
        lastError = error;
        structuredLog(attempt < this.maximumAttempts ? 'warn' : 'error', 'kafka_handler_failed', {
          topic: this.options.topic,
          consumer_group: this.options.groupId,
          attempt,
          exhausted: attempt === this.maximumAttempts,
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });
        if (attempt < this.maximumAttempts) {
          await heartbeat();
          await new Promise<void>((resolve) => setTimeout(resolve, this.retryBackoffMs * attempt));
        }
      }
    }
    return this.options.exhausted(record, lastError, this.maximumAttempts);
  }

  private record(topic: string, partition: number, message: KafkaMessage): IncomingKafkaRecord {
    const headers = Object.fromEntries(
      Object.entries(message.headers ?? {}).flatMap(([key, value]) => {
        if (value === undefined) return [];
        const first = Array.isArray(value) ? value[0] : value;
        return first ? [[key.toLowerCase(), first.toString('utf8')]] : [];
      }),
    );
    let envelope: DecodedEventEnvelope | undefined;
    let decodeError: MessageDecodeError | undefined;
    try {
      envelope = decodeEventEnvelope(message.value);
    } catch (error: unknown) {
      // The application exhaustion callback persists the raw record's hash and coordinates.
      if (error instanceof MessageDecodeError) decodeError = error;
    }
    let replayGeneration = 0;
    try {
      replayGeneration = decodeReplayGeneration(headers['replay-generation']);
    } catch (error: unknown) {
      if (error instanceof MessageDecodeError) decodeError ??= error;
    }
    let outboxId: string | undefined;
    try {
      outboxId = decodeOutboxId(headers['outbox-id']);
    } catch (error: unknown) {
      if (error instanceof MessageDecodeError) decodeError ??= error;
    }
    if (envelope && !decodeError) {
      try {
        validateEventTransport(envelope, message.key, headers);
      } catch (error: unknown) {
        if (error instanceof MessageDecodeError) decodeError = error;
      }
    }
    const brokerTimestampMs = Number(message.timestamp);
    return {
      delivery: {
        topic,
        partition,
        offset: message.offset,
        brokerTimestampMs: Number.isFinite(brokerTimestampMs) ? brokerTimestampMs : Date.now(),
        replayGeneration,
        ...(outboxId ? { outboxId } : {}),
      },
      key: message.key,
      value: message.value,
      headers,
      ...(envelope ? { envelope } : {}),
      ...(decodeError ? { decodeError } : {}),
    };
  }
}

/** Parses a comma-separated broker list used consistently by local containers and pods. */
export function kafkaBrokers(value = process.env.KAFKA_BROKERS): string[] {
  const brokers = (value ?? '127.0.0.1:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
  if (!brokers.length) throw new Error('KAFKA_BROKERS must contain at least one broker.');
  return brokers;
}
