/**
 * The internal provider gRPC boundary.
 *
 * Exposes the provider-neutral RPCs that the orchestrator calls. This is a trust boundary,
 * not merely a network hop: only this service holds provider credentials, so the orchestrator
 * — which holds database credentials — never holds Proxmox ones as well.
 *
 * Only the seven RPCs Phase 3 actually needs are registered. The rest of the lifecycle
 * remains in the versioned contract but is deliberately not served, so an unimplemented call
 * fails as unimplemented rather than doing something partially defined.
 *
 * @see docs/security/trust-boundaries.md
 * @see docs/architecture/contracts-and-provider-port.md
 */
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type {
  ApplyInstanceConfigurationRequest,
  ApplyInstanceConfigurationResponse,
  GetCapabilitiesRequest,
  GetCapabilitiesResponse,
  GetTaskRequest,
  GetTaskResponse,
  ObserveInstanceRequest,
  ObserveInstanceResponse,
  RebootInstanceRequest,
  RebootInstanceResponse,
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  DeleteSnapshotRequest,
  DeleteSnapshotResponse,
  ListSnapshotsRequest,
  ListSnapshotsResponse,
  MarkInstanceRetainedRequest,
  MarkInstanceRetainedResponse,
  PurgeInstanceRequest,
  PurgeInstanceResponse,
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
import {
  ProviderTransportError,
  type CreateInstanceProviderPort,
  type PowerProviderPort,
  type ResizeProviderPort,
  type PurgeProviderPort,
  type RetentionProviderPort,
  type SnapshotProviderPort,
} from '@private-cloud/provider-sdk';
import { recordProviderDuration, structuredLog, withSpan } from '@private-cloud/observability';
import { CREATE_INSTANCE_PROVIDER } from './tokens';

/**
 * Converts an ISO timestamp into a protobuf `Timestamp`.
 *
 * The cast is a workaround: the generated request types declare timestamp fields as `string`
 * because that is their JSON form, but the wire encoder needs the `{seconds, nanos}` object.
 */
function wireTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Provider returned an invalid timestamp.');
  return {
    seconds: String(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000,
  } as unknown as string;
}

/**
 * Maps a provider failure onto a gRPC status.
 *
 * WHY the codes are chosen so carefully: the orchestrator reads them to decide whether a
 * mutation may be safely retried. `DEADLINE_EXCEEDED` and `UNAVAILABLE` mean the outcome is
 * unknown and the workflow must go to manual review; `FAILED_PRECONDITION` means the request
 * was rejected before any action and is safe to fail outright. A mis-mapped code here could
 * cause a duplicate VM.
 *
 * Unrecognised errors become a generic `INTERNAL`, so no Proxmox hostname, token, or stack
 * trace crosses this boundary.
 */
function rpcError(error: unknown): RpcException {
  if (error instanceof RpcException) return error;
  if (error instanceof ProviderTransportError) {
    const code = {
      aborted: status.CANCELLED,
      deadline_exceeded: status.DEADLINE_EXCEEDED,
      protocol_error: status.FAILED_PRECONDITION,
      unavailable: status.UNAVAILABLE,
    }[error.code];
    return new RpcException({ code, message: error.message });
  }
  return new RpcException({ code: status.INTERNAL, message: 'Internal provider error.' });
}

/** Serves the Phase 3 subset of `ProviderService` over internal gRPC. */
/** Protobuf `Timestamp` as decoded by proto-loader. */
interface WireTimestamp {
  readonly seconds?: string | number;
  readonly nanos?: number;
}

/**
 * Converts a protobuf `Timestamp` into the ISO string every provider adapter expects.
 *
 * The wire carries `{ seconds, nanos }`; `ProviderPort` is declared in ISO strings, and the Proxmox
 * adapter writes the value straight into the VM's description. Without this the description would
 * read `retained-until=[object Object]` — a silent corruption of the one field that records when a
 * retained machine may be destroyed, and one no type would catch, because the RPC layer types the
 * field as a string on both sides while the wire hands over an object.
 */
function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const wire = value as WireTimestamp;
  const milliseconds = Number(wire.seconds ?? 0) * 1_000 + Number(wire.nanos ?? 0) / 1_000_000;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

@Controller()
export class ProviderGrpcController {
  /** @param provider The configured adapter — deterministic fake or Proxmox. */
  public constructor(
    @Inject(CREATE_INSTANCE_PROVIDER)
    private readonly provider: CreateInstanceProviderPort &
      PowerProviderPort &
      ResizeProviderPort &
      SnapshotProviderPort &
      RetentionProviderPort &
      PurgeProviderPort,
  ) {}

  /** Probes that the configured profile and its allowlists are usable. Activation evidence. */
  @GrpcMethod('ProviderService', 'ValidateProfile')
  public async validateProfile(request: ValidateProfileRequest): Promise<ValidateProfileResponse> {
    return this.call('validate_profile', async () => {
      const response = await this.provider.validateProfile(request);
      return { ...response, validatedAt: wireTimestamp(response.validatedAt) };
    });
  }

  /** Reports what this adapter can do, so the control plane never assumes a capability. */
  @GrpcMethod('ProviderService', 'GetCapabilities')
  public async getCapabilities(request: GetCapabilitiesRequest): Promise<GetCapabilitiesResponse> {
    return this.call('get_capabilities', async () => {
      const response = await this.provider.getCapabilities(request);
      return { ...response, observedAt: wireTimestamp(response.observedAt) };
    });
  }

  /** Creates the VM. The first call that changes provider state. */
  @GrpcMethod('ProviderService', 'SubmitCreateInstance')
  public submitCreateInstance(
    request: SubmitCreateInstanceRequest,
  ): Promise<SubmitCreateInstanceResponse> {
    return this.call('submit_create_instance', () => this.provider.submitCreateInstance(request));
  }

  /** Applies CPU, memory, network, and cloud-init configuration to the created VM. */
  @GrpcMethod('ProviderService', 'ApplyInstanceConfiguration')
  public applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
  ): Promise<ApplyInstanceConfigurationResponse> {
    return this.call('apply_instance_configuration', () =>
      this.provider.applyInstanceConfiguration(request),
    );
  }

  /** Reads an asynchronous task's state. Read-only, so safe to call repeatedly. */
  @GrpcMethod('ProviderService', 'GetTask')
  public async getTask(request: GetTaskRequest): Promise<GetTaskResponse> {
    return this.call('get_task', async () => {
      const response = await this.provider.getTask(request);
      return { ...response, observedAt: wireTimestamp(response.observedAt) };
    });
  }

  /**
   * Reports the VM's real state and whether its ownership markers match.
   *
   * The workflow's proof of completion: nothing is reported as `active` until this confirms
   * an owned, running instance.
   */
  @GrpcMethod('ProviderService', 'ObserveInstance')
  public async observeInstance(request: ObserveInstanceRequest): Promise<ObserveInstanceResponse> {
    return this.call('observe_instance', async () => {
      const response = await this.provider.observeInstance(request);
      return response.observation
        ? {
            observation: {
              ...response.observation,
              observedAt: wireTimestamp(response.observation.observedAt),
            },
          }
        : response;
    });
  }

  /** Powers on an owned VM. */
  @GrpcMethod('ProviderService', 'StartInstance')
  public startInstance(request: StartInstanceRequest): Promise<StartInstanceResponse> {
    return this.call('start_instance', () => this.provider.startInstance(request));
  }

  /** Asks the guest to shut itself down, waiting for it rather than cutting power. */
  @GrpcMethod('ProviderService', 'ShutdownInstance')
  public shutdownInstance(request: ShutdownInstanceRequest): Promise<ShutdownInstanceResponse> {
    return this.call('shutdown_instance', () => this.provider.shutdownInstance(request));
  }

  /** Cuts power without waiting for the guest. */
  @GrpcMethod('ProviderService', 'StopInstance')
  public stopInstance(request: StopInstanceRequest): Promise<StopInstanceResponse> {
    return this.call('stop_instance', () => this.provider.stopInstance(request));
  }

  /** Restarts the guest, leaving it running. */
  @GrpcMethod('ProviderService', 'RebootInstance')
  public rebootInstance(request: RebootInstanceRequest): Promise<RebootInstanceResponse> {
    return this.call('reboot_instance', () => this.provider.rebootInstance(request));
  }

  /** Applies new CPU, memory, and disk sizing. */
  @GrpcMethod('ProviderService', 'ResizeInstance')
  public resizeInstance(request: ResizeInstanceRequest): Promise<ResizeInstanceResponse> {
    return this.call('resize_instance', () => this.provider.resizeInstance(request));
  }

  /** Snapshot surface: list snapshots. */
  @GrpcMethod('ProviderService', 'ListSnapshots')
  public async listSnapshots(request: ListSnapshotsRequest): Promise<ListSnapshotsResponse> {
    const response = await this.call('list_snapshots', () => this.provider.listSnapshots(request));
    // Every timestamp in this response needs encoding, including the one inside each snapshot.
    //
    // WHY this is worth a comment: an unencoded timestamp does not fail here. The handler returns
    // successfully and logs success, and grpc-js then fails to serialize the response and answers
    // `INTERNAL`. The caller classifies that as a `protocol_error` and fails the workflow, while
    // this service's logs show the call succeeding — so the failure appears to come from nowhere.
    // That is exactly how snapshot creation failed at its observation stage while the provider
    // reported both `create_snapshot` and `list_snapshots` as successful.
    return {
      ...response,
      snapshots: (response.snapshots ?? []).map((snapshot) => ({
        ...snapshot,
        createdAt: wireTimestamp(snapshot.createdAt),
      })),
      observedAt: wireTimestamp(response.observedAt),
    };
  }

  /** Snapshot surface: create snapshot. */
  @GrpcMethod('ProviderService', 'CreateSnapshot')
  public createSnapshot(request: CreateSnapshotRequest): Promise<CreateSnapshotResponse> {
    return this.call('create_snapshot', () => this.provider.createSnapshot(request));
  }

  /** Snapshot surface: rollback snapshot. */
  @GrpcMethod('ProviderService', 'RollbackSnapshot')
  public rollbackSnapshot(request: RollbackSnapshotRequest): Promise<RollbackSnapshotResponse> {
    return this.call('rollback_snapshot', () => this.provider.rollbackSnapshot(request));
  }

  /** Snapshot surface: delete snapshot. */
  @GrpcMethod('ProviderService', 'DeleteSnapshot')
  public deleteSnapshot(request: DeleteSnapshotRequest): Promise<DeleteSnapshotResponse> {
    return this.call('delete_snapshot', () => this.provider.deleteSnapshot(request));
  }

  /** Detaches tenant access and marks the VM retained, destroying nothing. */
  @GrpcMethod('ProviderService', 'MarkInstanceRetained')
  public markInstanceRetained(
    request: MarkInstanceRetainedRequest,
  ): Promise<MarkInstanceRetainedResponse> {
    return this.call('mark_instance_retained', () =>
      this.provider.markInstanceRetained({
        ...request,
        retentionDeadline: isoTimestamp(request.retentionDeadline) ?? request.retentionDeadline,
      }),
    );
  }

  /** Destroys the VM. The only irreversible RPC this service exposes. */
  @GrpcMethod('ProviderService', 'PurgeInstance')
  public purgeInstance(request: PurgeInstanceRequest): Promise<PurgeInstanceResponse> {
    return this.call('purge_instance', () =>
      this.provider.purgeInstance({
        ...request,
        retentionDeadline: isoTimestamp(request.retentionDeadline) ?? request.retentionDeadline,
      }),
    );
  }

  /**
   * Runs a handler and converts any failure into a mapped gRPC status.
   *
   * Every RPC routes through here, so no adapter exception can escape unmapped and carry
   * vendor detail across the trust boundary.
   */
  private async call<T>(operation: string, handler: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome = 'succeeded';
    try {
      return await withSpan(
        'controlplane.provider.adapter',
        { 'provider.operation': operation },
        async () => {
          try {
            return await handler();
          } catch (error: unknown) {
            outcome = 'failed';
            throw error;
          } finally {
            // Keep the measurement under the adapter span for trace-aware metric correlation.
            recordProviderDuration(operation, outcome, (performance.now() - started) / 1_000);
          }
        },
      );
    } catch (error: unknown) {
      throw rpcError(error);
    } finally {
      structuredLog('info', 'provider_operation_completed', { operation, outcome });
    }
  }
}
