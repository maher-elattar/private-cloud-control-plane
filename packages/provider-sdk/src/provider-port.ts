/**
 * The provider-neutral lifecycle port.
 *
 * PATTERN — Ports and adapters. This is the contract every provider must satisfy: the
 * deterministic `FakeProvider` used in tests, the allowlisted `ProxmoxProvider`, and any
 * future vendor. Nothing here names a vendor, and nothing may.
 *
 * WHY the abstraction is worth its cost: the workflow that decides whether a create is safe to
 * retry must be testable against every failure mode — timeout after the provider acted,
 * duplicate delivery, ambiguous task result. Reproducing those against real hardware is
 * impractical; against a fake that satisfies this interface it is a unit test.
 *
 * @see docs/architecture/contracts-and-provider-port.md
 * @see docs/adr/0011-provider-port-and-deterministic-fake.md
 */
import type {
  ApplyInstanceConfigurationRequest,
  ApplyInstanceConfigurationResponse,
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  DeleteSnapshotRequest,
  DeleteSnapshotResponse,
  GetCapabilitiesRequest,
  GetCapabilitiesResponse,
  GetTaskRequest,
  GetTaskResponse,
  ListSnapshotsRequest,
  ListSnapshotsResponse,
  MarkInstanceRetainedRequest,
  MarkInstanceRetainedResponse,
  ObserveInstanceRequest,
  ObserveInstanceResponse,
  PurgeInstanceRequest,
  PurgeInstanceResponse,
  RebootInstanceRequest,
  RebootInstanceResponse,
  ResizeInstanceRequest,
  ResizeInstanceResponse,
  RollbackSnapshotRequest,
  RollbackSnapshotResponse,
  ShutdownInstanceRequest,
  ShutdownInstanceResponse,
  StartInstanceRequest,
  StartInstanceResponse,
  StopInstanceRequest,
  StopInstanceResponse,
  SubmitCreateInstanceRequest,
  SubmitCreateInstanceResponse,
  ValidateProfileRequest,
  ValidateProfileResponse,
} from '@private-cloud/contracts/provider';

/**
 * Every method name on the port.
 *
 * Used by the fake to count logical calls per method when asserting that a retry did not
 * produce a second mutation.
 */
export type ProviderMethod =
  | 'validateProfile'
  | 'getCapabilities'
  | 'submitCreateInstance'
  | 'applyInstanceConfiguration'
  | 'getTask'
  | 'observeInstance'
  | 'startInstance'
  | 'shutdownInstance'
  | 'stopInstance'
  | 'rebootInstance'
  | 'resizeInstance'
  | 'listSnapshots'
  | 'createSnapshot'
  | 'rollbackSnapshot'
  | 'deleteSnapshot'
  | 'markInstanceRetained'
  | 'purgeInstance';

/** Per-call transport options. */
export interface ProviderCallOptions {
  /** Cancellation is local transport control; it must not be interpreted as provider rollback. */
  readonly signal?: AbortSignal;
}

/**
 * Provider-neutral lifecycle port. Adapters translate this contract into their own API and must
 * never expose vendor identifiers or errors outside the provider response fields.
 */
export interface ProviderPort {
  validateProfile(
    request: ValidateProfileRequest,
    options?: ProviderCallOptions,
  ): Promise<ValidateProfileResponse>;
  getCapabilities(
    request: GetCapabilitiesRequest,
    options?: ProviderCallOptions,
  ): Promise<GetCapabilitiesResponse>;
  submitCreateInstance(
    request: SubmitCreateInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<SubmitCreateInstanceResponse>;
  applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
    options?: ProviderCallOptions,
  ): Promise<ApplyInstanceConfigurationResponse>;
  getTask(request: GetTaskRequest, options?: ProviderCallOptions): Promise<GetTaskResponse>;
  observeInstance(
    request: ObserveInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ObserveInstanceResponse>;
  startInstance(
    request: StartInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StartInstanceResponse>;
  shutdownInstance(
    request: ShutdownInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ShutdownInstanceResponse>;
  stopInstance(
    request: StopInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StopInstanceResponse>;
  rebootInstance(
    request: RebootInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<RebootInstanceResponse>;
  resizeInstance(
    request: ResizeInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ResizeInstanceResponse>;
  listSnapshots(
    request: ListSnapshotsRequest,
    options?: ProviderCallOptions,
  ): Promise<ListSnapshotsResponse>;
  createSnapshot(
    request: CreateSnapshotRequest,
    options?: ProviderCallOptions,
  ): Promise<CreateSnapshotResponse>;
  rollbackSnapshot(
    request: RollbackSnapshotRequest,
    options?: ProviderCallOptions,
  ): Promise<RollbackSnapshotResponse>;
  deleteSnapshot(
    request: DeleteSnapshotRequest,
    options?: ProviderCallOptions,
  ): Promise<DeleteSnapshotResponse>;
  markInstanceRetained(
    request: MarkInstanceRetainedRequest,
    options?: ProviderCallOptions,
  ): Promise<MarkInstanceRetainedResponse>;
  purgeInstance(
    request: PurgeInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<PurgeInstanceResponse>;
}

/** The provider surface exercised by the Phase 3 create-instance vertical slice. */
export type CreateInstanceProviderPort = Pick<
  ProviderPort,
  | 'validateProfile'
  | 'getCapabilities'
  | 'submitCreateInstance'
  | 'applyInstanceConfiguration'
  | 'getTask'
  | 'observeInstance'
  | 'startInstance'
>;

/**
 * The provider surface every persisted lifecycle saga needs, regardless of capability.
 *
 * `getTask` polls an asynchronous provider task and `observeInstance` proves the intended result
 * actually happened. Both are reads, which is why they are safe for the shared engine to call on
 * any capability's behalf.
 */
export type LifecycleProviderPort = Pick<ProviderPort, 'getTask' | 'observeInstance'>;

/** The provider surface exercised by the power capability. */
export type PowerProviderPort = LifecycleProviderPort &
  Pick<ProviderPort, 'startInstance' | 'shutdownInstance' | 'stopInstance' | 'rebootInstance'>;

/** The provider surface exercised by the resize capability. */
export type ResizeProviderPort = LifecycleProviderPort & Pick<ProviderPort, 'resizeInstance'>;

/** The provider surface exercised by the snapshot capabilities. */
export type SnapshotProviderPort = LifecycleProviderPort &
  Pick<ProviderPort, 'listSnapshots' | 'createSnapshot' | 'rollbackSnapshot' | 'deleteSnapshot'>;

/** The provider surface exercised by the soft-deletion capability. */
export type RetentionProviderPort = LifecycleProviderPort &
  Pick<ProviderPort, 'markInstanceRetained'>;

/** The provider surface exercised by the administrative purge capability. */
export type PurgeProviderPort = LifecycleProviderPort & Pick<ProviderPort, 'purgeInstance'>;
