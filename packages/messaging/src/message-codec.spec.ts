import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeEventEnvelope,
  decodeOutboxId,
  decodeReplayGeneration,
  MessageDecodeError,
  validateEventTransport,
} from './message-codec.js';

describe('decodeEventEnvelope', () => {
  it('decodes the contract fixture', () => {
    const fixture = readFileSync(
      new URL(
        '../../contracts/fixtures/events/instance-create-requested.valid.json',
        import.meta.url,
      ),
    );
    expect(decodeEventEnvelope(fixture).schemaName).toBe('instance.create.requested');
  });

  it('rejects empty, invalid JSON, and incomplete envelopes', () => {
    expect(() => decodeEventEnvelope(null)).toThrow(MessageDecodeError);
    expect(() => decodeEventEnvelope(Buffer.from('{'))).toThrow('not valid JSON');
    expect(() => decodeEventEnvelope(Buffer.from('{}'))).toThrow('supported event envelope');
  });

  it('rejects identifiers and trace context that cannot cross durable boundaries', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../contracts/fixtures/events/instance-create-requested.valid.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(() =>
      decodeEventEnvelope(Buffer.from(JSON.stringify({ ...fixture, eventId: 'not-a-uuid' }))),
    ).toThrow('supported event envelope');
    expect(() =>
      decodeEventEnvelope(
        Buffer.from(
          JSON.stringify({ ...fixture, traceContext: { traceparent: 'not-a-traceparent' } }),
        ),
      ),
    ).toThrow('supported event envelope');
    expect(() =>
      decodeEventEnvelope(
        Buffer.from(
          JSON.stringify({
            ...fixture,
            traceContext: {
              traceparent: '00-00000000000000000000000000000000-0000000000000000-01',
            },
          }),
        ),
      ),
    ).toThrow('supported event envelope');
  });
});

describe('decodeReplayGeneration', () => {
  it('defaults normal deliveries to generation zero and accepts safe integers', () => {
    expect(decodeReplayGeneration(undefined)).toBe(0);
    expect(decodeReplayGeneration('0')).toBe(0);
    expect(decodeReplayGeneration('12')).toBe(12);
  });

  it.each(['-1', '01', '1junk', '9007199254740992'])('rejects invalid value %s', (value) => {
    expect(() => decodeReplayGeneration(value)).toThrow(MessageDecodeError);
  });
});

describe('decodeOutboxId', () => {
  it('accepts an owner outbox UUID and rejects missing or malformed metadata', () => {
    expect(decodeOutboxId('70000000-0000-4000-8000-000000000001')).toBe(
      '70000000-0000-4000-8000-000000000001',
    );
    expect(() => decodeOutboxId(undefined)).toThrow(MessageDecodeError);
    expect(() => decodeOutboxId('not-an-outbox-id')).toThrow(MessageDecodeError);
  });
});

describe('validateEventTransport', () => {
  const fixture = decodeEventEnvelope(
    readFileSync(
      new URL(
        '../../contracts/fixtures/events/instance-create-requested.valid.json',
        import.meta.url,
      ),
    ),
  );
  const headers = {
    'event-id': fixture.eventId,
    'schema-name': fixture.schemaName,
    'schema-version': String(fixture.schemaVersion),
    'outbox-id': '70000000-0000-4000-8000-000000000001',
  };

  it('accepts a key and identity headers that agree with the envelope', () => {
    expect(() =>
      validateEventTransport(fixture, Buffer.from(fixture.partitionKey), headers),
    ).not.toThrow();
  });

  it('rejects a mismatched partition key or event identity', () => {
    expect(() => validateEventTransport(fixture, Buffer.from('other-instance'), headers)).toThrow(
      MessageDecodeError,
    );
    expect(() =>
      validateEventTransport(fixture, Buffer.from(fixture.partitionKey), {
        ...headers,
        'event-id': '70000000-0000-4000-8000-000000000001',
      }),
    ).toThrow(MessageDecodeError);
  });
});
