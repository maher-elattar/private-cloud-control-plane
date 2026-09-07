import type {
  AcceptedMutation,
  AdministrativeOperationView,
  AuditEventView,
  DeadLetterView,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  ProjectView,
  QuotaView,
} from '@private-cloud/application';
import {
  DesiredPowerState,
  DriftClassification,
  FailureCategory,
  InstanceLifecycleState,
  ObservedPowerState,
  OperationState,
  type AdministrativeOperation,
  type AuditEvent,
  type MutationAccepted,
  type DeadLetter,
  type Flavor,
  type Image,
  type Instance,
  type Network,
  type Operation,
  type Project,
  type QuotaSet,
} from '@private-cloud/contracts';

const lifecycleStates: Readonly<Record<InstanceView['lifecycleState'], InstanceLifecycleState>> = {
  pending: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_PENDING,
  provisioning: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_PROVISIONING,
  active: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_ACTIVE,
  updating: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_UPDATING,
  failed: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_FAILED,
  unknown_outcome: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_UNKNOWN_OUTCOME,
  retained: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_RETAINED,
  purge_pending: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_PURGE_PENDING,
  purged: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_PURGED,
  manual_review: InstanceLifecycleState.INSTANCE_LIFECYCLE_STATE_MANUAL_REVIEW,
};

const operationStates: Readonly<Record<OperationView['state'], OperationState>> = {
  accepted: OperationState.OPERATION_STATE_ACCEPTED,
  queued: OperationState.OPERATION_STATE_QUEUED,
  running: OperationState.OPERATION_STATE_RUNNING,
  retry_wait: OperationState.OPERATION_STATE_RETRY_WAIT,
  compensating: OperationState.OPERATION_STATE_COMPENSATING,
  unknown_outcome: OperationState.OPERATION_STATE_UNKNOWN_OUTCOME,
  manual_review: OperationState.OPERATION_STATE_MANUAL_REVIEW,
  succeeded: OperationState.OPERATION_STATE_SUCCEEDED,
  failed: OperationState.OPERATION_STATE_FAILED,
  cancelled: OperationState.OPERATION_STATE_CANCELLED,
};

const failureCategories = {
  validation: FailureCategory.FAILURE_CATEGORY_VALIDATION,
  authentication: FailureCategory.FAILURE_CATEGORY_AUTHENTICATION,
  authorization: FailureCategory.FAILURE_CATEGORY_AUTHORIZATION,
  not_found: FailureCategory.FAILURE_CATEGORY_NOT_FOUND,
  conflict: FailureCategory.FAILURE_CATEGORY_CONFLICT,
  quota: FailureCategory.FAILURE_CATEGORY_QUOTA,
  transient: FailureCategory.FAILURE_CATEGORY_TRANSIENT,
  permanent: FailureCategory.FAILURE_CATEGORY_PERMANENT,
  unknown_outcome: FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
  compensation_failure: FailureCategory.FAILURE_CATEGORY_COMPENSATION_FAILURE,
  manual_review: FailureCategory.FAILURE_CATEGORY_MANUAL_REVIEW,
  internal: FailureCategory.FAILURE_CATEGORY_INTERNAL,
} as const;

// The generated API model exposes Timestamp fields as RFC 3339 strings, while
// Nest's dynamic protobuf serializer requires the wire-level seconds/nanos shape.
export function grpcTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid timestamp: ${value}`);
  return {
    seconds: String(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000,
  } as unknown as string;
}

export function grpcProject(view: ProjectView): Project {
  return {
    ...view,
    createdAt: grpcTimestamp(view.createdAt),
    updatedAt: grpcTimestamp(view.updatedAt),
  };
}

export function grpcQuota(view: QuotaView): QuotaSet {
  return {
    projectId: view.projectId,
    limits: {
      instances: view.limits.instances,
      cpuCount: view.limits.cpuCount,
      memoryMib: String(view.limits.memoryMiB),
      diskGib: String(view.limits.diskGiB),
      ipv4Addresses: view.limits.ipv4Addresses,
      snapshots: view.limits.snapshots,
    },
    usage: {
      instances: view.usage.instances,
      cpuCount: view.usage.cpuCount,
      memoryMib: String(view.usage.memoryMiB),
      diskGib: String(view.usage.diskGiB),
      ipv4Addresses: view.usage.ipv4Addresses,
      snapshots: view.usage.snapshots,
    },
    measuredAt: grpcTimestamp(view.measuredAt),
  };
}

export function grpcImage(view: ImageView): Image {
  return {
    ...view,
    createdAt: grpcTimestamp(view.createdAt),
    updatedAt: grpcTimestamp(view.updatedAt),
  };
}

export function grpcFlavor(view: FlavorView): Flavor {
  return {
    id: view.id,
    name: view.name,
    cpuCount: view.cpuCount,
    memoryMib: String(view.memoryMiB),
    minimumDiskGib: String(view.minimumDiskGiB),
    enabled: view.enabled,
    createdAt: grpcTimestamp(view.createdAt),
    updatedAt: grpcTimestamp(view.updatedAt),
  };
}

export function grpcNetwork(view: NetworkView): Network {
  return {
    ...view,
    createdAt: grpcTimestamp(view.createdAt),
    updatedAt: grpcTimestamp(view.updatedAt),
  };
}

export function grpcInstance(view: InstanceView): Instance {
  const powerState = {
    running: DesiredPowerState.DESIRED_POWER_STATE_RUNNING,
    stopped: DesiredPowerState.DESIRED_POWER_STATE_STOPPED,
    unchanged: DesiredPowerState.DESIRED_POWER_STATE_UNCHANGED,
  }[view.desired.powerState];
  const observedPower = view.observed
    ? {
        running: ObservedPowerState.OBSERVED_POWER_STATE_RUNNING,
        stopped: ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
        suspended: ObservedPowerState.OBSERVED_POWER_STATE_SUSPENDED,
        unknown: ObservedPowerState.OBSERVED_POWER_STATE_UNKNOWN,
      }[view.observed.powerState]
    : undefined;
  const drift = {
    none: DriftClassification.DRIFT_CLASSIFICATION_NONE,
    missing_resource: DriftClassification.DRIFT_CLASSIFICATION_MISSING_RESOURCE,
    identity_mismatch: DriftClassification.DRIFT_CLASSIFICATION_IDENTITY_MISMATCH,
    stale_task: DriftClassification.DRIFT_CLASSIFICATION_STALE_TASK,
    late_success: DriftClassification.DRIFT_CLASSIFICATION_LATE_SUCCESS,
    power_drift: DriftClassification.DRIFT_CLASSIFICATION_POWER,
    network_drift: DriftClassification.DRIFT_CLASSIFICATION_NETWORK,
    ambiguous: DriftClassification.DRIFT_CLASSIFICATION_AMBIGUOUS,
  }[view.drift];

  return {
    id: view.id,
    projectId: view.projectId,
    lifecycleState: lifecycleStates[view.lifecycleState],
    desired: {
      imageId: view.desired.imageId,
      flavorId: view.desired.flavorId,
      networkId: view.desired.networkId,
      hostname: view.desired.hostname,
      powerState,
      retentionRequested: view.desired.retentionRequested,
    },
    ...(view.observed && observedPower
      ? {
          observed: {
            exists: view.observed.exists,
            powerState: observedPower,
            ...(view.observed.cpuCount === null ? {} : { cpuCount: view.observed.cpuCount }),
            ...(view.observed.memoryMiB === null
              ? {}
              : { memoryMib: String(view.observed.memoryMiB) }),
            ...(view.observed.diskGiB === null ? {} : { diskGib: String(view.observed.diskGiB) }),
            markerMatch: view.observed.markerMatch,
            observedAt: grpcTimestamp(view.observed.observedAt),
          },
        }
      : {}),
    ...(view.ipv4Lease ? { ipv4Lease: view.ipv4Lease } : {}),
    ...(view.activeOperationId ? { activeOperationId: view.activeOperationId } : {}),
    drift,
    ...(view.lastReconciledAt ? { lastReconciledAt: grpcTimestamp(view.lastReconciledAt) } : {}),
    ...(view.retentionDeadline ? { retentionDeadline: grpcTimestamp(view.retentionDeadline) } : {}),
    purgeEligible: view.purgeEligible,
    createdAt: grpcTimestamp(view.createdAt),
    updatedAt: grpcTimestamp(view.updatedAt),
  };
}

export function grpcOperation(view: OperationView): Operation {
  return {
    id: view.id,
    projectId: view.projectId,
    action: view.action,
    targetType: view.targetType,
    targetId: view.targetId,
    state: operationStates[view.state],
    stage: view.stage,
    progressPercent: view.progressPercent,
    acceptedAt: grpcTimestamp(view.acceptedAt),
    ...(view.startedAt ? { startedAt: grpcTimestamp(view.startedAt) } : {}),
    updatedAt: grpcTimestamp(view.updatedAt),
    ...(view.completedAt ? { completedAt: grpcTimestamp(view.completedAt) } : {}),
    ...(view.errorCategory ? { errorCategory: failureCategories[view.errorCategory] } : {}),
    ...(view.errorCode ? { errorCode: view.errorCode } : {}),
    ...(view.errorMessage ? { errorMessage: view.errorMessage } : {}),
    manualReviewRequired: view.manualReviewRequired,
  };
}

export function grpcAdministrativeOperation(
  view: AdministrativeOperationView,
): AdministrativeOperation {
  return {
    operation: grpcOperation(view),
    // Protobuf cannot distinguish an unset string from an empty one, so an absent correlation
    // is sent as `''` here only because the field is non-optional in the message. Every other
    // field is `optional` and is omitted instead.
    correlationId: view.correlationId ?? '',
    ...(view.causationId ? { causationId: view.causationId } : {}),
    ...(view.traceId ? { traceId: view.traceId } : {}),
    retryCount: view.retryCount ?? 0,
    ...(view.checkpoint ? { checkpoint: view.checkpoint } : {}),
    ...(view.deadLetterEventId ? { deadLetterEventId: view.deadLetterEventId } : {}),
    ...(view.providerTaskReference ? { providerTaskReference: view.providerTaskReference } : {}),
  };
}

export function grpcDeadLetter(view: DeadLetterView): DeadLetter {
  return {
    eventId: view.eventId,
    schemaName: view.schemaName,
    schemaVersion: view.schemaVersion,
    aggregateId: view.aggregateId,
    projectId: view.projectId,
    operationId: view.operationId,
    category: failureCategories[view.category],
    ...(view.safeMessage ? { safeMessage: view.safeMessage } : {}),
    attempts: view.attempts,
    deadLetteredAt: grpcTimestamp(view.deadLetteredAt),
    replayAllowed: view.replayAllowed,
    ...(view.lastReplayAt ? { lastReplayAt: grpcTimestamp(view.lastReplayAt) } : {}),
  };
}

export function grpcAuditEvent(view: AuditEventView): AuditEvent {
  return {
    id: view.id,
    actorId: view.actorId,
    actorRole: view.actorRole,
    ...(view.projectId ? { projectId: view.projectId } : {}),
    action: view.action,
    targetType: view.targetType,
    targetId: view.targetId,
    ...(view.operationId ? { operationId: view.operationId } : {}),
    outcome: view.outcome,
    ...(view.reason ? { reason: view.reason } : {}),
    occurredAt: grpcTimestamp(view.occurredAt),
  };
}

/**
 * Maps a `202 Accepted` acceptance onto its protobuf form.
 *
 * Shared by every RPC that accepts a mutation, so the `statusUrl` to `status_uri` rename and
 * the timestamp conversion cannot drift between transports.
 */
export function grpcMutationAccepted(accepted: AcceptedMutation): MutationAccepted {
  return {
    operationId: accepted.operationId,
    targetId: accepted.targetId,
    acceptedAt: grpcTimestamp(accepted.acceptedAt),
    statusUri: accepted.statusUrl,
    replayed: accepted.replayed,
  };
}
