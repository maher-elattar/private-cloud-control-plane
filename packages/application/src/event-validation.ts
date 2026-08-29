import type {
  EventEnvelope,
  InstanceCreateRequestedV1,
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  ProvisioningDeadLetteredV1,
  ProvisioningReplayResolvedV1,
  ProvisioningReplayRequestedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrows an unknown JSON value to a non-null object. */
function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Checks a contract string without coercion. */
function stringInRange(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

/** Checks an optional field with a supplied value predicate. */
function optional(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === undefined || predicate(value);
}

/** Rejects payload extensions until this deployment's versioned contract explicitly accepts them. */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

/** Checks the timestamp syntax used on durable event fields. */
function dateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Checks dotted-decimal IPv4 without accepting coercion or out-of-range octets. */
function ipv4Address(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    )
  );
}

/** Checks the shared, tenant-safe failure shape. */
function failureValue(value: unknown): boolean {
  if (
    !objectValue(value) ||
    !onlyKeys(value, ['category', 'code', 'safeMessage', 'retryAfterMilliseconds'])
  ) {
    return false;
  }
  return (
    [
      'validation',
      'authorization',
      'conflict',
      'transient',
      'permanent',
      'unknown_outcome',
      'compensation_failure',
      'manual_review',
    ].includes(String(value.category)) &&
    stringInRange(value.code, 1, 80) &&
    stringInRange(value.safeMessage, 0, 512) &&
    optional(value.retryAfterMilliseconds, (candidate) => integerInRange(candidate, 1, 86_400_000))
  );
}

/** Checks the complete create-command payload understood by this deployment. */
export function isInstanceCreateRequestedV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is InstanceCreateRequestedV1 {
  const data = value.data;
  if (
    value.schemaName !== 'instance.create.requested' ||
    value.schemaVersion !== 1 ||
    value.aggregateType !== 'instance' ||
    !objectValue(data) ||
    !onlyKeys(data, [
      'imageId',
      'flavorId',
      'networkId',
      'providerProfileId',
      'hostname',
      'resources',
      'ipv4',
      'sshPublicKeys',
    ]) ||
    !stringInRange(data.imageId, 1, 63) ||
    !stringInRange(data.flavorId, 1, 63) ||
    !stringInRange(data.networkId, 1, 63) ||
    !stringInRange(data.providerProfileId, 1, 63) ||
    !stringInRange(data.hostname, 1, 63) ||
    !objectValue(data.resources) ||
    !objectValue(data.ipv4)
  ) {
    return false;
  }

  const resources = data.resources;
  const ipv4 = data.ipv4;
  const sshPublicKeys = data.sshPublicKeys;
  return (
    onlyKeys(resources, ['cpuCount', 'memoryMiB', 'diskGiB']) &&
    integerInRange(resources.cpuCount, 1, 64) &&
    integerInRange(resources.memoryMiB, 512, 262_144) &&
    integerInRange(resources.diskGiB, 8, 2_048) &&
    onlyKeys(ipv4, ['address', 'prefixLength', 'gateway', 'dnsServers']) &&
    ipv4Address(ipv4.address) &&
    integerInRange(ipv4.prefixLength, 1, 32) &&
    ipv4Address(ipv4.gateway) &&
    Array.isArray(ipv4.dnsServers) &&
    ipv4.dnsServers.length >= 1 &&
    ipv4.dnsServers.length <= 4 &&
    ipv4.dnsServers.every(ipv4Address) &&
    new Set(ipv4.dnsServers).size === ipv4.dnsServers.length &&
    (sshPublicKeys === undefined ||
      (Array.isArray(sshPublicKeys) &&
        sshPublicKeys.length <= 5 &&
        sshPublicKeys.every((key) => stringInRange(key, 32, 8_192)) &&
        new Set(sshPublicKeys).size === sshPublicKeys.length))
  );
}

/** Checks the replay-resolution fact before it can update administrator-visible state. */
export function isProvisioningReplayResolvedV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is ProvisioningReplayResolvedV1 {
  const data = value.data;
  return (
    value.schemaName === 'provisioning.replay.resolved' &&
    value.schemaVersion === 1 &&
    value.aggregateType === 'instance' &&
    objectValue(data) &&
    onlyKeys(data, [
      'replayRequestId',
      'originalEventId',
      'outcome',
      'replayGeneration',
      'resolvedAt',
    ]) &&
    typeof data.replayRequestId === 'string' &&
    uuidPattern.test(data.replayRequestId) &&
    typeof data.originalEventId === 'string' &&
    uuidPattern.test(data.originalEventId) &&
    (data.outcome === 'completed' || data.outcome === 'rejected') &&
    Number.isSafeInteger(data.replayGeneration) &&
    Number(data.replayGeneration) >= 0 &&
    dateTime(data.resolvedAt)
  );
}

/** Checks an attributed replay command before it reaches workflow-owned recovery state. */
export function isProvisioningReplayRequestedV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is ProvisioningReplayRequestedV1 {
  const data = value.data;
  return (
    value.schemaName === 'provisioning.replay.requested' &&
    value.schemaVersion === 1 &&
    value.aggregateType === 'instance' &&
    objectValue(data) &&
    onlyKeys(data, ['replayRequestId', 'originalEventId', 'requestedAt']) &&
    typeof data.replayRequestId === 'string' &&
    uuidPattern.test(data.replayRequestId) &&
    typeof data.originalEventId === 'string' &&
    uuidPattern.test(data.originalEventId) &&
    dateTime(data.requestedAt)
  );
}

/** Checks a workflow progress fact before it may mutate the API read projection. */
export function isWorkflowProgressedV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is WorkflowProgressedV1 {
  const data = value.data;
  return (
    value.schemaName === 'workflow.progressed' &&
    value.schemaVersion === 1 &&
    value.aggregateType === 'instance' &&
    objectValue(data) &&
    onlyKeys(data, [
      'stage',
      'attempt',
      'operationState',
      'providerTaskReference',
      'nextActionAt',
    ]) &&
    stringInRange(data.stage, 1, 80) &&
    positiveInteger(data.attempt) &&
    ['running', 'retry_wait', 'compensating', 'unknown_outcome'].includes(
      String(data.operationState),
    ) &&
    optional(data.providerTaskReference, (candidate) => stringInRange(candidate, 0, 256)) &&
    optional(data.nextActionAt, dateTime)
  );
}

/** Checks a successful mutation fact before it may complete projected state. */
export function isInstanceMutationCompletedV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is InstanceMutationCompletedV1 {
  const data = value.data;
  return (
    value.schemaName === 'instance.mutation.completed' &&
    value.schemaVersion === 1 &&
    value.aggregateType === 'instance' &&
    objectValue(data) &&
    onlyKeys(data, ['action', 'lifecycleState', 'providerResourceId', 'evidenceId']) &&
    data.action === 'create_instance' &&
    data.lifecycleState === 'active' &&
    stringInRange(data.providerResourceId, 1, 128) &&
    typeof data.evidenceId === 'string' &&
    uuidPattern.test(data.evidenceId)
  );
}

/** Checks a failed mutation fact, including its bounded failure and compensation classification. */
export function isInstanceMutationFailedV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is InstanceMutationFailedV1 {
  const data = value.data;
  return (
    value.schemaName === 'instance.mutation.failed' &&
    value.schemaVersion === 1 &&
    value.aggregateType === 'instance' &&
    objectValue(data) &&
    onlyKeys(data, ['action', 'failure', 'compensationState']) &&
    data.action === 'create_instance' &&
    failureValue(data.failure) &&
    ['not_required', 'pending', 'succeeded', 'failed', 'unsafe'].includes(
      String(data.compensationState),
    )
  );
}

/** Checks a DLQ fact before administrator-visible evidence is projected. */
export function isProvisioningDeadLetteredV1(
  value: EventEnvelope & { readonly data?: unknown },
): value is ProvisioningDeadLetteredV1 {
  const data = value.data;
  return (
    value.schemaName === 'provisioning.dead_lettered' &&
    value.schemaVersion === 1 &&
    value.aggregateType === 'instance' &&
    objectValue(data) &&
    onlyKeys(data, [
      'originalEventId',
      'originalSchemaName',
      'originalSchemaVersion',
      'failure',
      'attempts',
      'replayAllowed',
      'deadLetteredAt',
    ]) &&
    typeof data.originalEventId === 'string' &&
    uuidPattern.test(data.originalEventId) &&
    stringInRange(data.originalSchemaName, 1, 120) &&
    positiveInteger(data.originalSchemaVersion) &&
    failureValue(data.failure) &&
    positiveInteger(data.attempts) &&
    typeof data.replayAllowed === 'boolean' &&
    dateTime(data.deadLetteredAt)
  );
}

/** Checks a positive integer resource quantity. */
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Checks a bounded integer such as an IPv4 prefix length. */
function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
