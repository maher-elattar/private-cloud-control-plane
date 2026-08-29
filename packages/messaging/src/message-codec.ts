import type { EventEnvelope } from '@private-cloud/contracts';

/** Common envelope plus the schema-specific object validated by downstream handlers. */
export type DecodedEventEnvelope = EventEnvelope & {
  readonly data: Record<string, unknown>;
};

/** Failure raised before an untrusted Kafka value reaches an application handler. */
export class MessageDecodeError extends Error {
  public constructor(
    public readonly code:
      | 'EMPTY_VALUE'
      | 'INVALID_JSON'
      | 'INVALID_ENVELOPE'
      | 'INVALID_TRANSPORT_METADATA'
      | 'INVALID_REPLAY_GENERATION',
    message: string,
  ) {
    super(message);
    this.name = 'MessageDecodeError';
  }
}

/**
 * Parses the governed delivery generation carried in Kafka metadata.
 *
 * `parseInt` is deliberately insufficient here: it accepts values such as `1junk` and negative
 * generations would otherwise fail only at the database constraint, causing endless redelivery.
 */
export function decodeReplayGeneration(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 16) {
    throw new MessageDecodeError(
      'INVALID_REPLAY_GENERATION',
      'Kafka replay generation is not a non-negative safe integer.',
    );
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new MessageDecodeError(
      'INVALID_REPLAY_GENERATION',
      'Kafka replay generation is not a non-negative safe integer.',
    );
  }
  return generation;
}

/**
 * Verifies that Debezium's routing metadata describes the same logical event as the value.
 *
 * A mismatched Kafka key would break per-instance ordering, while mismatched identity headers make
 * broker inspection disagree with the durable envelope. Both are poison records, not retriable
 * infrastructure failures.
 */
export function validateEventTransport(
  envelope: DecodedEventEnvelope,
  key: Buffer | null,
  headers: Readonly<Record<string, string>>,
): void {
  const valid =
    key?.toString('utf8') === envelope.partitionKey &&
    headers['event-id'] === envelope.eventId &&
    headers['schema-name'] === envelope.schemaName &&
    headers['schema-version'] === String(envelope.schemaVersion);
  if (!valid) {
    throw new MessageDecodeError(
      'INVALID_TRANSPORT_METADATA',
      'Kafka key or identity headers do not match the event envelope.',
    );
  }
}

/** A decoded record whose schema or supported version cannot be handled by this deployment. */
export class PermanentMessageError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const traceparentPattern = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Checks a bounded non-empty contract string. */
function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximumLength;
}

/** Rejects malformed W3C carriers and the reserved all-zero trace or span identities. */
function validTraceContext(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const carrier = value as Record<string, unknown>;
  if (typeof carrier.traceparent !== 'string') return false;
  const match = traceparentPattern.exec(carrier.traceparent);
  if (!match || /^0+$/.test(match[1] ?? '') || /^0+$/.test(match[2] ?? '')) return false;
  if (carrier.tracestate === undefined) return true;
  if (!boundedString(carrier.tracestate, 512)) return false;
  return ![...carrier.tracestate].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/** Parses the common, versioned event envelope at the messaging trust boundary. */
export function decodeEventEnvelope(value: Buffer | null): DecodedEventEnvelope {
  if (!value?.length) throw new MessageDecodeError('EMPTY_VALUE', 'Kafka record value is empty.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8')) as unknown;
  } catch {
    throw new MessageDecodeError('INVALID_JSON', 'Kafka record value is not valid JSON.');
  }
  if (!isEventEnvelope(parsed)) {
    throw new MessageDecodeError(
      'INVALID_ENVELOPE',
      'Kafka record does not contain a supported event envelope.',
    );
  }
  return parsed;
}

/** Runtime minimum required before schema-specific validation and handling. */
function isEventEnvelope(value: unknown): value is DecodedEventEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const traceContext = candidate.traceContext;
  return (
    typeof candidate.eventId === 'string' &&
    uuidPattern.test(candidate.eventId) &&
    boundedString(candidate.schemaName, 120) &&
    Number.isSafeInteger(candidate.schemaVersion) &&
    Number(candidate.schemaVersion) > 0 &&
    boundedString(candidate.aggregateType, 64) &&
    typeof candidate.aggregateId === 'string' &&
    uuidPattern.test(candidate.aggregateId) &&
    typeof candidate.projectId === 'string' &&
    uuidPattern.test(candidate.projectId) &&
    typeof candidate.operationId === 'string' &&
    uuidPattern.test(candidate.operationId) &&
    typeof candidate.correlationId === 'string' &&
    uuidPattern.test(candidate.correlationId) &&
    typeof candidate.causationId === 'string' &&
    uuidPattern.test(candidate.causationId) &&
    typeof candidate.occurredAt === 'string' &&
    Number.isFinite(Date.parse(candidate.occurredAt)) &&
    boundedString(candidate.partitionKey, 128) &&
    validTraceContext(traceContext) &&
    candidate.data !== null &&
    typeof candidate.data === 'object' &&
    !Array.isArray(candidate.data)
  );
}
