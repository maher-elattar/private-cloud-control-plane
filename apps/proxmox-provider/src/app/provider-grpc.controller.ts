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
import { CREATE_INSTANCE_PROVIDER } from './tokens';

function wireTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Provider returned an invalid timestamp.');
  return {
    seconds: String(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000,
  } as unknown as string;
}

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

@Controller()
export class ProviderGrpcController {
  public constructor(
    @Inject(CREATE_INSTANCE_PROVIDER) private readonly provider: CreateInstanceProviderPort,
  ) {}

  @GrpcMethod('ProviderService', 'ValidateProfile')
  public async validateProfile(request: ValidateProfileRequest): Promise<ValidateProfileResponse> {
    return this.call(async () => {
      const response = await this.provider.validateProfile(request);
      return { ...response, validatedAt: wireTimestamp(response.validatedAt) };
    });
  }

  @GrpcMethod('ProviderService', 'GetCapabilities')
  public async getCapabilities(request: GetCapabilitiesRequest): Promise<GetCapabilitiesResponse> {
    return this.call(async () => {
      const response = await this.provider.getCapabilities(request);
      return { ...response, observedAt: wireTimestamp(response.observedAt) };
    });
  }

  @GrpcMethod('ProviderService', 'SubmitCreateInstance')
  public submitCreateInstance(
    request: SubmitCreateInstanceRequest,
  ): Promise<SubmitCreateInstanceResponse> {
    return this.call(() => this.provider.submitCreateInstance(request));
  }

  @GrpcMethod('ProviderService', 'ApplyInstanceConfiguration')
  public applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
  ): Promise<ApplyInstanceConfigurationResponse> {
    return this.call(() => this.provider.applyInstanceConfiguration(request));
  }

  @GrpcMethod('ProviderService', 'GetTask')
  public async getTask(request: GetTaskRequest): Promise<GetTaskResponse> {
    return this.call(async () => {
      const response = await this.provider.getTask(request);
      return { ...response, observedAt: wireTimestamp(response.observedAt) };
    });
  }

  @GrpcMethod('ProviderService', 'ObserveInstance')
  public async observeInstance(request: ObserveInstanceRequest): Promise<ObserveInstanceResponse> {
    return this.call(async () => {
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

  @GrpcMethod('ProviderService', 'StartInstance')
  public startInstance(request: StartInstanceRequest): Promise<StartInstanceResponse> {
    return this.call(() => this.provider.startInstance(request));
  }

  private async call<T>(handler: () => Promise<T>): Promise<T> {
    try {
      return await handler();
    } catch (error: unknown) {
      throw rpcError(error);
    }
  }
}
