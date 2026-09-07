/**
 * Maps a command topic record onto the narrowed command a workflow can be admitted from.
 *
 * PATTERN — Trust boundary. Everything here runs on bytes that arrived from Kafka, so a payload
 * is not a command until it has been proved to satisfy its published contract. A schema this
 * deployment does not implement, and a payload that does not validate, are both
 * {@link PermanentMessageError}: redelivering them would never succeed, so they belong in the
 * governed dead letter rather than in an uncommitted-offset retry loop.
 *
 * Extracted from the consumer so the routing table can be tested without a broker. It is eight
 * branches wide and grows with every capability, which is exactly the shape that drifts silently.
 *
 * @see docs/architecture/phase-5-lifecycle-capabilities.md
 */
import {
  isInstanceCreateRequestedV1,
  isInstancePowerRequestedV1,
  isInstancePurgeRequestedV1,
  isInstanceResizeRequestedV1,
  isInstanceRetentionRequestedV1,
  isSnapshotActionRequestedV1,
  isSnapshotCreateRequestedV1,
  type LifecycleCommand,
} from '@private-cloud/application';
import type {
  InstanceCreateRequestedV1,
  InstancePowerRequestedV1,
  InstanceResizeRequestedV1,
} from '@private-cloud/contracts';
import {
  PermanentMessageError,
  decodeEventEnvelope,
  type IncomingKafkaRecord,
} from '@private-cloud/messaging';

/** Every command schema this deployment can admit a workflow from. */
export const SUPPORTED_COMMAND_SCHEMAS = [
  'instance.create.requested',
  'instance.power.requested',
  'instance.resize.requested',
  'snapshot.create.requested',
  'snapshot.rollback.requested',
  'snapshot.delete.requested',
  'instance.retention.requested',
  'instance.purge.requested',
] as const;

/** Whether this deployment knows how to admit the given schema. */
export function isSupportedCommandSchema(schemaName: string): boolean {
  return (SUPPORTED_COMMAND_SCHEMAS as readonly string[]).includes(schemaName);
}

/** Rejects malformed create commands before a workflow can be partially admitted. */
function createCommand(record: IncomingKafkaRecord): InstanceCreateRequestedV1 {
  const event = decodeEventEnvelope(record.value);
  if (event.schemaName !== 'instance.create.requested' || event.schemaVersion !== 1) {
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Create command schema or version is unsupported.',
    );
  }
  if (!isInstanceCreateRequestedV1(event)) {
    throw new PermanentMessageError(
      'COMMAND_PAYLOAD_INVALID',
      'Create command payload does not satisfy the supported contract.',
    );
  }
  return event;
}

/** Rejects malformed power commands before a workflow can be partially admitted. */
function powerCommand(record: IncomingKafkaRecord): InstancePowerRequestedV1 {
  const event = decodeEventEnvelope(record.value);
  if (event.schemaName !== 'instance.power.requested' || event.schemaVersion !== 1) {
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Power command schema or version is unsupported.',
    );
  }
  if (!isInstancePowerRequestedV1(event)) {
    throw new PermanentMessageError(
      'COMMAND_PAYLOAD_INVALID',
      'Power command payload does not satisfy the supported contract.',
    );
  }
  return event as InstancePowerRequestedV1;
}

/** Rejects malformed resize commands before a workflow can be partially admitted. */
function resizeCommand(record: IncomingKafkaRecord): InstanceResizeRequestedV1 {
  const event = decodeEventEnvelope(record.value);
  if (event.schemaName !== 'instance.resize.requested' || event.schemaVersion !== 1) {
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Resize command schema or version is unsupported.',
    );
  }
  if (!isInstanceResizeRequestedV1(event)) {
    throw new PermanentMessageError(
      'COMMAND_PAYLOAD_INVALID',
      'Resize command payload does not satisfy the supported contract.',
    );
  }
  return event as InstanceResizeRequestedV1;
}

/** Rejects malformed snapshot commands before a workflow can be partially admitted. */
function snapshotCommand(record: IncomingKafkaRecord): LifecycleCommand {
  const event = decodeEventEnvelope(record.value);
  const valid =
    event.schemaName === 'snapshot.create.requested'
      ? isSnapshotCreateRequestedV1(event)
      : isSnapshotActionRequestedV1(
          event,
          event.schemaName as 'snapshot.rollback.requested' | 'snapshot.delete.requested',
        );
  if (event.schemaVersion !== 1) {
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Snapshot command schema or version is unsupported.',
    );
  }
  if (!valid) {
    throw new PermanentMessageError(
      'COMMAND_PAYLOAD_INVALID',
      'Snapshot command payload does not satisfy the supported contract.',
    );
  }
  return event as unknown as LifecycleCommand;
}

/** Rejects malformed retention commands before a workflow can be partially admitted. */
function retentionCommand(record: IncomingKafkaRecord): LifecycleCommand {
  const event = decodeEventEnvelope(record.value);
  if (event.schemaVersion !== 1) {
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Retention command schema or version is unsupported.',
    );
  }
  if (!isInstanceRetentionRequestedV1(event)) {
    throw new PermanentMessageError(
      'COMMAND_PAYLOAD_INVALID',
      'Retention command payload does not satisfy the supported contract.',
    );
  }
  return event as unknown as LifecycleCommand;
}

/** Rejects malformed purge commands before a workflow can be partially admitted. */
function purgeCommand(record: IncomingKafkaRecord): LifecycleCommand {
  const event = decodeEventEnvelope(record.value);
  if (event.schemaVersion !== 1) {
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Purge command schema or version is unsupported.',
    );
  }
  if (!isInstancePurgeRequestedV1(event)) {
    throw new PermanentMessageError(
      'COMMAND_PAYLOAD_INVALID',
      'Purge command payload does not satisfy the supported contract.',
    );
  }
  return event as unknown as LifecycleCommand;
}

/**
 * Narrows one command record to the capability that owns it.
 *
 * @throws PermanentMessageError when the schema is unsupported or the payload does not validate.
 */
export function narrowCommand(record: IncomingKafkaRecord): LifecycleCommand {
  const envelope = decodeEventEnvelope(record.value);
  switch (envelope.schemaName) {
    case 'instance.create.requested':
      return createCommand(record);
    case 'instance.power.requested':
      return powerCommand(record);
    case 'instance.resize.requested':
      return resizeCommand(record);
    case 'instance.retention.requested':
      return retentionCommand(record);
    case 'instance.purge.requested':
      return purgeCommand(record);
    case 'snapshot.create.requested':
    case 'snapshot.rollback.requested':
    case 'snapshot.delete.requested':
      return snapshotCommand(record);
    default:
      throw new PermanentMessageError(
        'COMMAND_SCHEMA_UNSUPPORTED',
        'Command topic contains an unsupported schema.',
      );
  }
}
