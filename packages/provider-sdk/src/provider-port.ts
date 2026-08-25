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
