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

type UnaryMethod<Request, Response> = (
  request: Request,
  metadata: Metadata,
  options: CallOptions,
  callback: (error: ServiceError | null, response: Response) => void,
) => ClientUnaryCall;

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

type Phase3ProviderClientConstructor = new (
  address: string,
  channelCredentials: ReturnType<typeof credentials.createInsecure>,
) => Phase3ProviderClient;

interface WireTimestamp {
  readonly seconds?: string | number;
  readonly nanos?: number;
}

function timestamp(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wire = value as WireTimestamp;
  const milliseconds = Number(wire.seconds ?? 0) * 1_000 + Number(wire.nanos ?? 0) / 1_000_000;
  return new Date(milliseconds).toISOString();
}

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

export class GrpcProviderClient implements CreateInstanceProviderPort {
  private readonly client: Phase3ProviderClient;

  public constructor(
    address: string,
    private readonly deadlineMs = 10_000,
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
    this.client = new Constructor(address, credentials.createInsecure());
  }

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

  public submitCreateInstance(
    request: SubmitCreateInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<SubmitCreateInstanceResponse> {
    return this.call(this.client.submitCreateInstance.bind(this.client), request, options);
  }

  public applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
    options?: ProviderCallOptions,
  ): Promise<ApplyInstanceConfigurationResponse> {
    return this.call(this.client.applyInstanceConfiguration.bind(this.client), request, options);
  }

  public async getTask(
    request: GetTaskRequest,
    options?: ProviderCallOptions,
  ): Promise<GetTaskResponse> {
    const response = await this.call(this.client.getTask.bind(this.client), request, options);
    return { ...response, observedAt: timestamp(response.observedAt) };
  }

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

  public startInstance(
    request: StartInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StartInstanceResponse> {
    return this.call(this.client.startInstance.bind(this.client), request, options);
  }

  public close(): void {
    this.client.close();
  }

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
