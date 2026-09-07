/**
 * Unit coverage for the Kafka command routing table.
 *
 * This is the trust boundary: everything the routing table sees arrived as bytes from a broker.
 * The table is eight branches wide and gains one per capability, which is exactly the shape that
 * drifts silently — a new capability whose schema is published but not routed would dead-letter
 * every command it ever received, and nothing else in the build would notice.
 */
import { describe, expect, it } from 'vitest';
import { PermanentMessageError, type IncomingKafkaRecord } from '@private-cloud/messaging';
import {
  SUPPORTED_COMMAND_SCHEMAS,
  isSupportedCommandSchema,
  narrowCommand,
} from './command-routing';

const instanceId = '00000000-0000-4000-8000-000000000012';
const operationId = '00000000-0000-4000-8000-000000000014';

/** Envelope fields every command shares. */
function envelope(schemaName: string) {
  return {
    eventId: '00000000-0000-4000-8000-000000000011',
    schemaName,
    schemaVersion: 1,
    aggregateType: 'instance',
    aggregateId: instanceId,
    projectId: '00000000-0000-4000-8000-000000000013',
    operationId,
    correlationId: '00000000-0000-4000-8000-000000000015',
    causationId: operationId,
    occurredAt: '2026-09-05T00:00:00.000Z',
    traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    partitionKey: instanceId,
  };
}

/** The routing identity every non-create capability carries. */
const routing = {
  providerProfileId: 'fake-lab',
  createOperationId: '00000000-0000-4000-8000-0000000000c1',
};

/** Wraps a payload as the consumer would see it off the topic. */
function record(payload: unknown): IncomingKafkaRecord {
  return {
    delivery: {
      topic: 'provisioning.commands.v1',
      partition: 0,
      offset: '1',
      replayGeneration: 0,
    },
    key: instanceId,
    value: Buffer.from(JSON.stringify(payload), 'utf8'),
    headers: {},
  } as unknown as IncomingKafkaRecord;
}

/** One valid payload per supported schema. */
const validPayloads: Readonly<Record<string, unknown>> = {
  'instance.create.requested': {
    ...envelope('instance.create.requested'),
    data: {
      imageId: 'ubuntu-24-04-cloud',
      flavorId: 'lab-small',
      networkId: 'lab-primary',
      providerProfileId: 'fake-lab',
      hostname: 'routing-test',
      resources: { cpuCount: 2, memoryMiB: 4096, diskGiB: 32 },
      ipv4: {
        address: '192.0.2.5',
        prefixLength: 27,
        gateway: '192.0.2.1',
        dnsServers: ['192.0.2.53'],
      },
    },
  },
  'instance.power.requested': {
    ...envelope('instance.power.requested'),
    data: { action: 'start', ...routing },
  },
  'instance.resize.requested': {
    ...envelope('instance.resize.requested'),
    data: {
      flavorId: 'lab-medium',
      targetResources: { cpuCount: 4, memoryMiB: 8192, diskGiB: 64 },
      ...routing,
    },
  },
  'snapshot.create.requested': {
    ...envelope('snapshot.create.requested'),
    data: { snapshotId: '00000000-0000-4000-8000-0000000000d1', name: 'nightly', ...routing },
  },
  'snapshot.rollback.requested': {
    ...envelope('snapshot.rollback.requested'),
    data: {
      snapshotId: '00000000-0000-4000-8000-0000000000d1',
      providerSnapshotReference: 'nightly',
      ...routing,
    },
  },
  'snapshot.delete.requested': {
    ...envelope('snapshot.delete.requested'),
    data: {
      snapshotId: '00000000-0000-4000-8000-0000000000d1',
      providerSnapshotReference: 'nightly',
      ...routing,
    },
  },
  'instance.retention.requested': {
    ...envelope('instance.retention.requested'),
    data: {
      retentionDeadline: '2026-09-12T00:00:00.000Z',
      leaseReleaseMode: 'quarantine_until_purge',
      ...routing,
    },
  },
  'instance.purge.requested': {
    ...envelope('instance.purge.requested'),
    data: {
      purgeAuthorizationId: '00000000-0000-4000-8000-0000000000e1',
      retentionDeadline: '2026-09-01T00:00:00.000Z',
      reasonReference: '00000000-0000-4000-8000-0000000000e1',
      ...routing,
    },
  },
};

describe('command routing', () => {
  it('routes every schema it claims to support', () => {
    // The guard against a capability whose schema is published but never wired: this would fail
    // the moment `SUPPORTED_COMMAND_SCHEMAS` gains an entry `narrowCommand` cannot handle.
    for (const schemaName of SUPPORTED_COMMAND_SCHEMAS) {
      const payload = validPayloads[schemaName];
      expect(payload, `no fixture for ${schemaName}`).toBeDefined();
      expect(narrowCommand(record(payload)).schemaName).toBe(schemaName);
    }
  });

  it('agrees with itself about what it supports', () => {
    for (const schemaName of SUPPORTED_COMMAND_SCHEMAS) {
      expect(isSupportedCommandSchema(schemaName)).toBe(true);
    }
    expect(isSupportedCommandSchema('instance.teleport.requested')).toBe(false);
  });

  it('rejects an unsupported schema permanently rather than retrying it', () => {
    // Redelivery would never succeed, so this belongs in the governed dead letter rather than in
    // an uncommitted-offset loop.
    const payload = { ...envelope('instance.teleport.requested'), data: {} };
    expect(() => narrowCommand(record(payload))).toThrowError(
      expect.objectContaining({ code: 'COMMAND_SCHEMA_UNSUPPORTED' }),
    );
  });

  it('rejects a future schema version of a supported schema', () => {
    const payload = {
      ...(validPayloads['instance.power.requested'] as Record<string, unknown>),
      schemaVersion: 2,
    };
    expect(() => narrowCommand(record(payload))).toThrowError(PermanentMessageError);
  });

  it('rejects a payload that does not satisfy its contract', () => {
    for (const [schemaName, payload] of Object.entries(validPayloads)) {
      const broken = { ...(payload as Record<string, unknown>), data: { unexpected: true } };
      expect(() => narrowCommand(record(broken)), schemaName).toThrowError(PermanentMessageError);
    }
  });

  it('rejects a power action outside the supported set', () => {
    // Re-checked here even though the API validated it: a command off the broker has not
    // necessarily passed through this deployment's API.
    const payload = {
      ...envelope('instance.power.requested'),
      data: { action: 'poweroff', ...routing },
    };
    expect(() => narrowCommand(record(payload))).toThrowError(
      expect.objectContaining({ code: 'COMMAND_PAYLOAD_INVALID' }),
    );
  });

  it('rejects a snapshot command missing its provider routing identity', () => {
    // Without it the workflow cannot reach the provider, and the failure would surface mid-saga
    // rather than at admission.
    const payload = {
      ...envelope('snapshot.create.requested'),
      data: { snapshotId: '00000000-0000-4000-8000-0000000000d1', name: 'nightly' },
    };
    expect(() => narrowCommand(record(payload))).toThrowError(PermanentMessageError);
  });
});
