import {
  SpanKind,
  extractTransportContext,
  recordMessageProcessed,
  structuredLog,
  withSpan,
} from '@private-cloud/observability';
import { Kafka, logLevel, type Consumer, type KafkaMessage, type SASLOptions } from 'kafkajs';
import { readFileSync } from 'node:fs';
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
  /**
   * Transport security. Omitted means "read it from the environment", not "connect in the clear":
   * see {@link kafkaSecurity}.
   */
  readonly security?: KafkaSecurity;
  readonly maximumAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly handle: (record: IncomingKafkaRecord) => Promise<MessageHandlingResult>;
  readonly exhausted: (
    record: IncomingKafkaRecord,
    error: unknown,
    attempts: number,
  ) => Promise<MessageHandlingResult>;
}

/** SASL mechanisms a broker may require. Kafka's own `plain` is included for completeness. */
export type KafkaSaslMechanism = 'scram-sha-512' | 'scram-sha-256' | 'plain';

/**
 * Transport security for a broker connection.
 *
 * Passwords are carried as values here because KafkaJS needs one, but they are only ever *read*
 * from a mounted file. No credential is accepted from an environment variable, because an
 * environment variable is printed by `kubectl describe pod` and copied into every child process.
 */
export interface KafkaSecurity {
  readonly tls?: { readonly certificateAuthority: string };
  readonly sasl?: {
    readonly mechanism: KafkaSaslMechanism;
    readonly username: string;
    readonly password: string;
  };
}

const SASL_MECHANISMS: readonly KafkaSaslMechanism[] = ['scram-sha-512', 'scram-sha-256', 'plain'];

/**
 * Builds broker transport security from the process environment.
 *
 * The deployment supplies a cluster CA and a SASL identity that the message broker generated; the
 * repository holds only the names of the Secrets they are mounted from. Both the CA and the
 * password are read from files rather than variables, so no credential value appears in a pod
 * spec, an environment dump, or a crash report.
 *
 * Absent configuration yields an empty object, which is how the container-free local stack and
 * the unit tests keep talking to a plaintext broker.
 *
 * @param {NodeJS.ProcessEnv} [environment] Environment to read; defaults to the process
 *   environment.
 * @returns {KafkaSecurity} Security settings, empty when the broker requires none.
 */
export function kafkaSecurity(environment: NodeJS.ProcessEnv = process.env): KafkaSecurity {
  const certificateAuthorityFile = environment.KAFKA_TLS_CA_FILE?.trim();
  const mechanism = environment.KAFKA_SASL_MECHANISM?.trim().toLowerCase();
  const username = environment.KAFKA_SASL_USERNAME?.trim();
  const passwordFile = environment.KAFKA_SASL_PASSWORD_FILE?.trim();

  const tls = certificateAuthorityFile
    ? { certificateAuthority: readSecretFile(certificateAuthorityFile, 'KAFKA_TLS_CA_FILE') }
    : undefined;

  let sasl: KafkaSecurity['sasl'];
  if (mechanism || username || passwordFile) {
    if (!mechanism || !username || !passwordFile) {
      throw new Error(
        'KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME, and KAFKA_SASL_PASSWORD_FILE must be set together.',
      );
    }
    if (!SASL_MECHANISMS.includes(mechanism as KafkaSaslMechanism)) {
      throw new Error(`KAFKA_SASL_MECHANISM must be one of ${SASL_MECHANISMS.join(', ')}.`);
    }
    sasl = {
      mechanism: mechanism as KafkaSaslMechanism,
      username,
      password: readSecretFile(passwordFile, 'KAFKA_SASL_PASSWORD_FILE'),
    };
  }

  return { ...(tls ? { tls } : {}), ...(sasl ? { sasl } : {}) };
}

/**
 * Narrows the mechanism literal so KafkaJS's discriminated SASL union accepts the credentials.
 *
 * The three branches are identical in shape; the switch exists because the union discriminates on
 * a literal and a widened `'plain' | 'scram-sha-256' | 'scram-sha-512'` matches no single member.
 * Writing it out keeps the alternative — a cast — from hiding a future mechanism that is not
 * username-and-password shaped.
 *
 * @param {NonNullable<KafkaSecurity['sasl']>} sasl Validated SASL identity.
 * @returns {SASLOptions} KafkaJS SASL options.
 */
function saslOptions(sasl: NonNullable<KafkaSecurity['sasl']>): SASLOptions {
  const { username, password } = sasl;
  switch (sasl.mechanism) {
    case 'plain':
      return { mechanism: 'plain', username, password };
    case 'scram-sha-256':
      return { mechanism: 'scram-sha-256', username, password };
    case 'scram-sha-512':
      return { mechanism: 'scram-sha-512', username, password };
  }
}

/**
 * Reads a mounted credential file, failing with the variable name and never the content.
 *
 * @param {string} path File to read.
 * @param {string} variableName Environment variable that named it, used in the failure message.
 * @returns {string} File content with surrounding whitespace removed.
 */
function readSecretFile(path: string, variableName: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    // Deliberately no cause and no path content: this message reaches logs.
    throw new Error(`${variableName} points at a file that could not be read.`);
  }
  const trimmed = content.trim();
  if (!trimmed) throw new Error(`${variableName} points at an empty file.`);
  return trimmed;
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
    // Defaulted rather than required so that a service cannot connect without the credentials its
    // cluster demands merely because a call site forgot to pass them. The environment decides.
    const security = options.security ?? kafkaSecurity();
    const ssl = security.tls
      ? { ca: [security.tls.certificateAuthority], rejectUnauthorized: true as const }
      : undefined;
    const sasl = security.sasl ? saslOptions(security.sasl) : undefined;
    const kafka = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      logLevel: logLevel.NOTHING,
      retry: { retries: 8, initialRetryTime: 250, maxRetryTime: 10_000 },
      ...(ssl ? { ssl } : {}),
      ...(sasl ? { sasl } : {}),
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
        // WHY the message and not only the type: `error_type` alone is almost always `"error"`,
        // because most failures here are plain `Error` instances. A handler that retried three
        // times and gave up then leaves a log line saying that something failed and nothing about
        // what — which is indistinguishable from a healthy consumer to anyone reading the logs,
        // and leaves the operator with no starting point at all. Measured: a create that never
        // reached the orchestrator produced twenty such lines and named no cause.
        //
        // The message is the handler's own text, not tenant data: these are decode failures,
        // constraint violations and transport errors. The stack is included only on the final
        // attempt, where someone is actually going to read it.
        structuredLog(attempt < this.maximumAttempts ? 'warn' : 'error', 'kafka_handler_failed', {
          topic: this.options.topic,
          consumer_group: this.options.groupId,
          attempt,
          exhausted: attempt === this.maximumAttempts,
          error_type: error instanceof Error ? error.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : String(error),
          ...(attempt === this.maximumAttempts && error instanceof Error && error.stack
            ? { error_stack: error.stack }
            : {}),
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
