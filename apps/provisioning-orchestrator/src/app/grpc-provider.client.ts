/**
 * gRPC client implementing the provider port for the orchestrator.
 *
 * PATTERN — Adapter. `CreateInstanceWorkflow` depends only on `CreateInstanceProviderPort`;
 * this class satisfies it by calling the provider service over gRPC. The workflow has no idea
 * a network hop is involved, which is exactly why it can be unit-tested against an in-memory
 * fake.
 *
 * Its most important job is error classification: {@link transportError} decides whether a
 * failure is retryable, and the workflow uses that to decide whether a mutation may be safely
 * repeated. See `handleProviderError` in `create-instance-workflow.ts`.
 *
 * @see docs/architecture/contracts-and-provider-port.md
 */
import { join } from 'node:path';
import {
  credentials,
  makeGenericClientConstructor,
  Metadata,
  status,
  type CallOptions,
  type Client,
  type ClientUnaryCall,
  type ServiceDefinition,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
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
  type ProviderCallOptions,
} from '@private-cloud/provider-sdk';

/** Signature of a generated unary gRPC method. */
type UnaryMethod<Request, Response> = (
  request: Request,
  metadata: Metadata,
  options: CallOptions,
  callback: (error: ServiceError | null, response: Response) => void,
) => ClientUnaryCall;

/** The seven RPCs Phase 3 uses, out of the full provider contract. */
interface Phase3ProviderClient extends Client {
  validateProfile: UnaryMethod<ValidateProfileRequest, ValidateProfileResponse>;
  getCapabilities: UnaryMethod<GetCapabilitiesRequest, GetCapabilitiesResponse>;
  submitCreateInstance: UnaryMethod<SubmitCreateInstanceRequest, SubmitCreateInstanceResponse>;
  applyInstanceConfiguration: UnaryMethod<
    ApplyInstanceConfigurationRequest,
    ApplyInstanceConfigurationResponse
  >;
  getTask: UnaryMethod<GetTaskRequest, GetTaskResponse>;
  observeInstance: UnaryMethod<ObserveInstanceRequest, ObserveInstanceResponse>;
  startInstance: UnaryMethod<StartInstanceRequest, StartInstanceResponse>;
}

/** Constructor shape produced by `makeGenericClientConstructor`. */
type Phase3ProviderClientConstructor = new (
  address: string,
  channelCredentials: ReturnType<typeof credentials.createInsecure>,
) => Phase3ProviderClient;

/** Protobuf `Timestamp` as decoded by proto-loader. */
interface WireTimestamp {
  readonly seconds?: string | number;
  readonly nanos?: number;
}

/** Converts a protobuf `Timestamp` back into the ISO string the contract types declare. */
function timestamp(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wire = value as WireTimestamp;
  const milliseconds = Number(wire.seconds ?? 0) * 1_000 + Number(wire.nanos ?? 0) / 1_000_000;
  return new Date(milliseconds).toISOString();
}

/**
 * Classifies a gRPC failure, deciding whether the call may be safely retried.
 *
 * **The most safety-critical function in this file.** `retryable` propagates to the workflow,
 * which uses it to choose between backing off and escalating to manual review.
 *
 * WHY only `protocol_error` is non-retryable: it means the request was malformed and rejected
 * before the provider acted. Every other code — deadline, cancellation, unavailable — leaves
 * the outcome genuinely unknown. The workflow refuses to retry those on a *mutation* stage
 * regardless of this flag, because an unknown mutation could already have built a VM.
 */
function transportError(error: ServiceError): ProviderTransportError {
  const code =
    error.code === status.DEADLINE_EXCEEDED
      ? 'deadline_exceeded'
      : error.code === status.CANCELLED
        ? 'aborted'
        : error.code === status.UNAVAILABLE
          ? 'unavailable'
          : 'protocol_error';
  return new ProviderTransportError(code, error.details || 'Provider gRPC call failed.', {
    cause: error,
    retryable: code !== 'protocol_error',
  });
}

/** Calls the provider service over gRPC, satisfying the provider port. */
/** Fallback per-call deadline when the caller does not supply one. */
const DEFAULT_DEADLINE_MS = 10_000;

export class GrpcProviderClient implements CreateInstanceProviderPort {
  private readonly client: Phase3ProviderClient;

  /**
   * @param address `host:port` of the provider service.
   * @param deadlineMs Per-call deadline. Every call is bounded, because a hung call would
   *   hold the instance lease until it expired and block that instance's provisioning.
   */
  public constructor(
    address: string,
    private readonly deadlineMs = DEFAULT_DEADLINE_MS,
  ) {
    const protoRoot = join(__dirname, 'assets/proto');
    const definition = loadSync(join(protoRoot, 'privatecloud/provider/v1/provider.proto'), {
      includeDirs: [protoRoot],
      keepCase: false,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const service = definition['privatecloud.provider.v1.ProviderService'];
    if (!service || typeof service !== 'object') {
      throw new Error('ProviderService definition is unavailable.');
    }
    const Constructor = makeGenericClientConstructor(
      service as ServiceDefinition,
      'ProviderService',
    ) as unknown as Phase3ProviderClientConstructor;
    // WHY insecure credentials are acceptable: this hop is inside the cluster's mesh, which
    // supplies mTLS. No tenant data and no provider credentials traverse it in the clear
    // outside that boundary. See docs/security/trust-boundaries.md.
    this.client = new Constructor(address, credentials.createInsecure());
  }

  /** Probes the configured profile. Read-only. */
  public async validateProfile(
    request: ValidateProfileRequest,
    options?: ProviderCallOptions,
  ): Promise<ValidateProfileResponse> {
    const response = await this.call(
      this.client.validateProfile.bind(this.client),
      request,
      options,
    );
    return { ...response, validatedAt: timestamp(response.validatedAt) };
  }

  /** Reads adapter capabilities. Read-only. */
  public async getCapabilities(
    request: GetCapabilitiesRequest,
    options?: ProviderCallOptions,
  ): Promise<GetCapabilitiesResponse> {
    const response = await this.call(
      this.client.getCapabilities.bind(this.client),
      request,
      options,
    );
    return { ...response, observedAt: timestamp(response.observedAt) };
  }

  /** Creates the VM. Mutation — an unknown outcome here is never retried blindly. */
  public submitCreateInstance(
    request: SubmitCreateInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<SubmitCreateInstanceResponse> {
    return this.call(this.client.submitCreateInstance.bind(this.client), request, options);
  }

  /** Applies configuration to the created VM. Mutation. */
  public applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
    options?: ProviderCallOptions,
  ): Promise<ApplyInstanceConfigurationResponse> {
    return this.call(this.client.applyInstanceConfiguration.bind(this.client), request, options);
  }

  /** Polls an asynchronous task. Read-only, so safe to repeat. */
  public async getTask(
    request: GetTaskRequest,
    options?: ProviderCallOptions,
  ): Promise<GetTaskResponse> {
    const response = await this.call(this.client.getTask.bind(this.client), request, options);
    return { ...response, observedAt: timestamp(response.observedAt) };
  }

  /** Reads real VM state and ownership. Read-only; the workflow's proof of completion. */
  public async observeInstance(
    request: ObserveInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ObserveInstanceResponse> {
    const response = await this.call(
      this.client.observeInstance.bind(this.client),
      request,
      options,
    );
    return response.observation
      ? {
          observation: {
            ...response.observation,
            observedAt: timestamp(response.observation.observedAt),
          },
        }
      : response;
  }

  /** Powers on the VM. Mutation. */
  public startInstance(
    request: StartInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StartInstanceResponse> {
    return this.call(this.client.startInstance.bind(this.client), request, options);
  }

  /** Closes the channel on shutdown. */
  public close(): void {
    this.client.close();
  }

  /**
   * Invokes a unary RPC as a promise, applying the deadline and honouring cancellation.
   *
   * WHY the abort listener is removed in the callback: without it, a long-lived `AbortSignal`
   * would accumulate a listener per call and leak.
   *
   * Note that cancelling is local transport control only. It stops this process waiting; it
   * does not tell the provider to undo anything it may already have done.
   */
  private call<Request, Response>(
    method: UnaryMethod<Request, Response>,
    request: Request,
    options?: ProviderCallOptions,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const call = method(
        request,
        new Metadata(),
        { deadline: new Date(Date.now() + this.deadlineMs) },
        (error, response) => {
          options?.signal?.removeEventListener('abort', abort);
          if (error) reject(transportError(error));
          else resolve(response);
        },
      );
      const abort = () => call.cancel();
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
