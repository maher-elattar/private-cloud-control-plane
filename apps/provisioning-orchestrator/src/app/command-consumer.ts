import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  isInstanceCreateRequestedV1,
  isProvisioningReplayRequestedV1,
  type WorkflowStore,
} from '@private-cloud/application';
import type {
  InstanceCreateRequestedV1,
  ProvisioningReplayRequestedV1,
} from '@private-cloud/contracts';
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
  recordDeadLetter,
  recordQuarantine,
  recordReplay,
  structuredLog,
} from '@private-cloud/observability';
import { WORKFLOW_STORE } from './tokens';

const COMMAND_TOPIC = 'provisioning.commands.v1';
const CONSUMER_GROUP = 'provisioning-orchestrator.v1';

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

/** Narrows a governed replay request. */
function replayRequest(record: IncomingKafkaRecord): ProvisioningReplayRequestedV1 {
  const event = decodeEventEnvelope(record.value);
  if (!isProvisioningReplayRequestedV1(event)) {
    throw new PermanentMessageError(
      'REPLAY_SCHEMA_UNSUPPORTED',
      'Replay request schema or version is unsupported.',
    );
  }
  return event as ProvisioningReplayRequestedV1;
}

/** Kafka command ingress. Offset commits happen only after durable inbox handling. */
@Injectable()
export class CommandConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly runner: KafkaConsumerRunner;

  public constructor(@Inject(WORKFLOW_STORE) private readonly store: WorkflowStore) {
    this.runner = new KafkaConsumerRunner({
      clientId: process.env.HOSTNAME ?? `orchestrator-${process.pid}`,
      groupId: CONSUMER_GROUP,
      topic: COMMAND_TOPIC,
      brokers: kafkaBrokers(),
      maximumAttempts: Number.parseInt(process.env.KAFKA_HANDLER_MAX_ATTEMPTS ?? '3', 10),
      handle: (record) => this.handle(record),
      exhausted: (record, error, attempts) => this.exhausted(record, error, attempts),
    });
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.runner.start();
  }

  public async onModuleDestroy(): Promise<void> {
    await this.runner.stop();
  }

  private async handle(record: IncomingKafkaRecord): Promise<MessageHandlingResult> {
    const envelope = decodeEventEnvelope(record.value);
    if (envelope.schemaName === 'instance.create.requested') {
      const command = createCommand(record);
      const outcome = await this.store.admitCreateCommand(command, record.delivery);
      structuredLog('info', 'provisioning_command_admitted', {
        schema_name: command.schemaName,
        outcome,
        operation_id: command.operationId,
        instance_id: command.aggregateId,
      });
      return {
        outcome: outcome === 'accepted' ? 'handled' : 'duplicate',
        schemaName: command.schemaName,
        occurredAtMs: Date.parse(command.occurredAt),
      };
    }
    if (envelope.schemaName === 'provisioning.replay.requested') {
      const request = replayRequest(record);
      const outcome = await this.store.admitReplayRequest(request, record.delivery);
      recordReplay(outcome);
      return {
        outcome: outcome === 'duplicate' ? 'duplicate' : 'handled',
        schemaName: request.schemaName,
        occurredAtMs: Date.parse(request.occurredAt),
      };
    }
    throw new PermanentMessageError(
      'COMMAND_SCHEMA_UNSUPPORTED',
      'Command topic contains an unsupported schema.',
    );
  }

  private async exhausted(
    record: IncomingKafkaRecord,
    error: unknown,
    attempts: number,
  ): Promise<MessageHandlingResult> {
    if (!(error instanceof MessageDecodeError) && !(error instanceof PermanentMessageError)) {
      // Infrastructure and programming failures leave the offset uncommitted. Kafka redelivers
      // after recovery; converting them to a DLQ record would turn an outage into data loss.
      throw error;
    }
    if (error instanceof MessageDecodeError || !record.envelope) {
      const outcome = await this.store.quarantineRecord({
        delivery: record.delivery,
        payloadHash: createHash('sha256')
          .update(record.value ?? Buffer.alloc(0))
          .digest('hex'),
        failureCode: error.code,
        safeMessage: 'The Kafka record could not be decoded as a versioned event envelope.',
      });
      recordQuarantine(error.code);
      return {
        outcome: outcome === 'quarantined' ? 'quarantined' : 'duplicate',
        schemaName: 'unknown',
        occurredAtMs: record.delivery.brokerTimestampMs,
      };
    }

    const replayAllowed =
      error.code === 'COMMAND_SCHEMA_UNSUPPORTED' &&
      record.envelope.schemaName === 'instance.create.requested';
    const outcome = await this.store.deadLetterCommand({
      event: record.envelope,
      delivery: record.delivery,
      attempts,
      failureCode: error.code,
      safeMessage: 'The command schema is not supported by this consumer deployment.',
      replayAllowed,
    });
    recordDeadLetter(record.envelope.schemaName, error.code, replayAllowed);
    return {
      outcome: outcome === 'dead_lettered' ? 'dead_lettered' : 'duplicate',
      schemaName: record.envelope.schemaName,
      occurredAtMs: Date.parse(record.envelope.occurredAt),
    };
  }
}
