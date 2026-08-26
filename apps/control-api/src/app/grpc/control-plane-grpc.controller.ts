import { Controller, HttpException, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { ControlPlaneApplication, type Actor } from '@private-cloud/application';
import type {
  CreateInstanceRequest,
  CreateInstanceResponse,
  GetInstanceRequest,
  GetInstanceResponse,
  GetOperationRequest,
  GetOperationResponse,
  GetProjectQuotaRequest,
  GetProjectQuotaResponse,
  GetProjectRequest,
  GetProjectResponse,
  ListFlavorsRequest,
  ListFlavorsResponse,
  ListImagesRequest,
  ListImagesResponse,
  ListInstancesRequest,
  ListInstancesResponse,
  ListNetworksRequest,
  ListNetworksResponse,
  ListOperationsRequest,
  ListOperationsResponse,
} from '@private-cloud/contracts/control-plane';
import { DomainError } from '@private-cloud/domain';
import { OidcAuthService } from '../auth/oidc-auth.service';
import { correlationId, requestTraceparent } from '../common/request-context';
import { CONTROL_PLANE_APPLICATION } from '../tokens';
import {
  grpcFlavor,
  grpcImage,
  grpcInstance,
  grpcNetwork,
  grpcOperation,
  grpcProject,
  grpcQuota,
  grpcTimestamp,
} from './grpc-mappers.js';

function metadataValue(metadata: Metadata, key: string): string | undefined {
  const value = metadata.get(key)[0];
  return typeof value === 'string' ? value : undefined;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new DomainError('VALIDATION_FAILED', `${field} is required.`);
  return value;
}

function rpcError(error: unknown): RpcException {
  if (error instanceof RpcException) return error;
  if (error instanceof HttpException) {
    const code = {
      400: status.INVALID_ARGUMENT,
      401: status.UNAUTHENTICATED,
      403: status.PERMISSION_DENIED,
      404: status.NOT_FOUND,
      409: status.ALREADY_EXISTS,
      422: status.FAILED_PRECONDITION,
    }[error.getStatus()];
    return new RpcException({
      code: code ?? status.UNKNOWN,
      message: error.getStatus() === 401 ? 'Bearer authentication failed.' : error.message,
    });
  }
  if (error instanceof DomainError) {
    const code = {
      IDEMPOTENCY_CONFLICT: status.ALREADY_EXISTS,
      INSTANCE_BUSY: status.ABORTED,
      INSTANCE_NOT_FOUND: status.NOT_FOUND,
      OPERATION_NOT_FOUND: status.NOT_FOUND,
      PROFILE_DISABLED: status.FAILED_PRECONDITION,
      PROJECT_ACCESS_DENIED: status.PERMISSION_DENIED,
      PROJECT_NOT_FOUND: status.NOT_FOUND,
      QUOTA_EXCEEDED: status.RESOURCE_EXHAUSTED,
      VALIDATION_FAILED: status.INVALID_ARGUMENT,
    }[error.code];
    return new RpcException({ code, message: error.message });
  }
  return new RpcException({ code: status.INTERNAL, message: 'Internal service error.' });
}

@Controller()
export class ControlPlaneGrpcController {
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) private readonly application: ControlPlaneApplication,
    private readonly auth: OidcAuthService,
  ) {}

  @GrpcMethod('CatalogService', 'GetProject')
  public async getProject(
    request: GetProjectRequest,
    metadata: Metadata,
  ): Promise<GetProjectResponse> {
    return this.call(metadata, async (actor) => ({
      project: grpcProject(
        await this.application.getProject(
          actor,
          required(request.context?.projectId, 'project_id'),
        ),
      ),
    }));
  }

  @GrpcMethod('CatalogService', 'GetProjectQuota')
  public async getProjectQuota(
    request: GetProjectQuotaRequest,
    metadata: Metadata,
  ): Promise<GetProjectQuotaResponse> {
    return this.call(metadata, async (actor) => ({
      quota: grpcQuota(
        await this.application.getQuota(actor, required(request.context?.projectId, 'project_id')),
      ),
    }));
  }

  @GrpcMethod('CatalogService', 'ListImages')
  public async listImages(
    request: ListImagesRequest,
    metadata: Metadata,
  ): Promise<ListImagesResponse> {
    return this.call(metadata, async (actor) => {
      const page = await this.application.listImages(
        actor,
        required(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return {
        items: page.items.map(grpcImage),
        page: {
          limit: page.page.limit,
          ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
        },
      };
    });
  }

  @GrpcMethod('CatalogService', 'ListFlavors')
  public async listFlavors(
    request: ListFlavorsRequest,
    metadata: Metadata,
  ): Promise<ListFlavorsResponse> {
    return this.call(metadata, async (actor) => {
      const page = await this.application.listFlavors(
        actor,
        required(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return {
        items: page.items.map(grpcFlavor),
        page: {
          limit: page.page.limit,
          ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
        },
      };
    });
  }

  @GrpcMethod('CatalogService', 'ListNetworks')
  public async listNetworks(
    request: ListNetworksRequest,
    metadata: Metadata,
  ): Promise<ListNetworksResponse> {
    return this.call(metadata, async (actor) => {
      const page = await this.application.listNetworks(
        actor,
        required(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return {
        items: page.items.map(grpcNetwork),
        page: {
          limit: page.page.limit,
          ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
        },
      };
    });
  }

  @GrpcMethod('InstanceService', 'CreateInstance')
  public async createInstance(
    request: CreateInstanceRequest,
    metadata: Metadata,
  ): Promise<CreateInstanceResponse> {
    return this.call(metadata, async (actor) => {
      const accepted = await this.application.createInstance({
        actor,
        projectId: required(request.context?.projectId, 'project_id'),
        idempotencyKey: required(request.context?.idempotencyKey, 'idempotency_key'),
        correlationId: correlationId(request.context?.correlationId),
        traceparent: requestTraceparent(metadataValue(metadata, 'traceparent')),
        imageId: required(request.imageId, 'image_id'),
        flavorId: required(request.flavorId, 'flavor_id'),
        networkId: required(request.networkId, 'network_id'),
        hostname: required(request.hostname, 'hostname'),
        sshPublicKeys: request.sshPublicKeys ?? [],
      });
      return {
        accepted: {
          operationId: accepted.operationId,
          targetId: accepted.targetId,
          acceptedAt: grpcTimestamp(accepted.acceptedAt),
          statusUri: accepted.statusUrl,
          replayed: accepted.replayed,
        },
      };
    });
  }

  @GrpcMethod('InstanceService', 'ListInstances')
  public async listInstances(
    request: ListInstancesRequest,
    metadata: Metadata,
  ): Promise<ListInstancesResponse> {
    return this.call(metadata, async (actor) => {
      const page = await this.application.listInstances(
        actor,
        required(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return {
        items: page.items.map(grpcInstance),
        page: {
          limit: page.page.limit,
          ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
        },
      };
    });
  }

  @GrpcMethod('InstanceService', 'GetInstance')
  public async getInstance(
    request: GetInstanceRequest,
    metadata: Metadata,
  ): Promise<GetInstanceResponse> {
    return this.call(metadata, async (actor) => ({
      instance: grpcInstance(
        await this.application.getInstance(
          actor,
          required(request.context?.projectId, 'project_id'),
          required(request.instanceId, 'instance_id'),
        ),
      ),
    }));
  }

  @GrpcMethod('OperationService', 'ListOperations')
  public async listOperations(
    request: ListOperationsRequest,
    metadata: Metadata,
  ): Promise<ListOperationsResponse> {
    return this.call(metadata, async (actor) => {
      const page = await this.application.listOperations(
        actor,
        required(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return {
        items: page.items.map(grpcOperation),
        page: {
          limit: page.page.limit,
          ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
        },
      };
    });
  }

  @GrpcMethod('OperationService', 'GetOperation')
  public async getOperation(
    request: GetOperationRequest,
    metadata: Metadata,
  ): Promise<GetOperationResponse> {
    return this.call(metadata, async (actor) => ({
      operation: grpcOperation(
        await this.application.getOperation(
          actor,
          required(request.context?.projectId, 'project_id'),
          required(request.operationId, 'operation_id'),
        ),
      ),
    }));
  }

  private async call<T>(metadata: Metadata, handler: (actor: Actor) => Promise<T>): Promise<T> {
    try {
      const actor = await this.auth.authenticate(metadataValue(metadata, 'authorization'));
      return await handler(actor);
    } catch (error: unknown) {
      throw rpcError(error);
    }
  }
}
