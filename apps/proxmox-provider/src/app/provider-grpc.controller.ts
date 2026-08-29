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
  StartInstanceRequest,
  StartInstanceResponse,
  SubmitCreateInstanceRequest,
  SubmitCreateInstanceResponse,
  ValidateProfileRequest,
  ValidateProfileResponse,
} from '@private-cloud/contracts/provider';
import {
  ProviderTransportError,
  type CreateInstanceProviderPort,
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
@Controller()
export class ProviderGrpcController {
  /** @param provider The configured adapter — deterministic fake or Proxmox. */
  public constructor(
    @Inject(CREATE_INSTANCE_PROVIDER) private readonly provider: CreateInstanceProviderPort,
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
        handler,
      );
    } catch (error: unknown) {
      outcome = 'failed';
      throw rpcError(error);
    } finally {
      recordProviderDuration(operation, outcome, (performance.now() - started) / 1_000);
      structuredLog('info', 'provider_operation_completed', { operation, outcome });
    }
  }
}
