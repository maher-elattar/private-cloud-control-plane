import type { AuditRecordedV1, EventEnvelope } from '@private-cloud/contracts';

/** Inputs every state owner must supply for one append-only audit fact. */
export interface AuditRecordedInput {
  readonly eventId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: Date;
  readonly traceContext: EventEnvelope['traceContext'];
  readonly actorId: string;
  readonly actorRole: AuditRecordedV1['data']['actorRole'];
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly outcome: AuditRecordedV1['data']['outcome'];
  readonly reasonReference?: string;
}

/** Builds the one versioned audit envelope used by every transactional owner outbox. */
export function auditRecordedEvent(input: AuditRecordedInput): AuditRecordedV1 {
  return {
    eventId: input.eventId,
    schemaName: 'audit.recorded',
    schemaVersion: 1,
    aggregateType: 'audit',
    aggregateId: input.eventId,
    projectId: input.projectId,
    operationId: input.operationId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: input.occurredAt.toISOString(),
    traceContext: input.traceContext,
    partitionKey: input.projectId,
    data: {
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      ...(input.reasonReference ? { reasonReference: input.reasonReference } : {}),
    },
  };
}
