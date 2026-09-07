/**
 * `CatalogService` — project, quota, and catalog reads over public gRPC.
 *
 * Transport adapter only: authenticate, unpack the request, delegate to
 * `ControlPlaneApplication`, map the result onto protobuf. The REST equivalent is
 * `catalog/catalog.controller.ts`, and both call exactly the same application methods.
 *
 * @see docs/contracts/grpc-api.md
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type {
  GetProjectQuotaRequest,
  GetProjectQuotaResponse,
  GetProjectRequest,
  GetProjectResponse,
  ListFlavorsRequest,
  ListFlavorsResponse,
  ListImagesRequest,
  ListImagesResponse,
  ListNetworksRequest,
  ListNetworksResponse,
} from '@private-cloud/contracts/control-plane';
import { AuthenticatedGrpcController, grpcPage } from './authenticated-grpc.controller';
import { requireField } from './grpc-errors';
import { grpcFlavor, grpcImage, grpcNetwork, grpcProject, grpcQuota } from './grpc-mappers.js';

/** Serves the `CatalogService` RPCs. */
@Controller()
export class CatalogGrpcController extends AuthenticatedGrpcController {
  /** Reads a project. */
  @GrpcMethod('CatalogService', 'GetProject')
  public async getProject(
    request: GetProjectRequest,
    metadata: Metadata,
  ): Promise<GetProjectResponse> {
    return this.handleAuthenticated(metadata, async (actor) => ({
      project: grpcProject(
        await this.application.getProject(
          actor,
          requireField(request.context?.projectId, 'project_id'),
        ),
      ),
    }));
  }

  /** Reads quota limits and current usage. */
  @GrpcMethod('CatalogService', 'GetProjectQuota')
  public async getProjectQuota(
    request: GetProjectQuotaRequest,
    metadata: Metadata,
  ): Promise<GetProjectQuotaResponse> {
    return this.handleAuthenticated(metadata, async (actor) => ({
      quota: grpcQuota(
        await this.application.getQuota(
          actor,
          requireField(request.context?.projectId, 'project_id'),
        ),
      ),
    }));
  }

  /** Lists bootable images. */
  @GrpcMethod('CatalogService', 'ListImages')
  public async listImages(
    request: ListImagesRequest,
    metadata: Metadata,
  ): Promise<ListImagesResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listImages(
        actor,
        requireField(request.context?.projectId, 'project_id'),
        request.page?.limit,
        request.page?.cursor,
      );
      return { items: page.items.map(grpcImage), page: grpcPage(page) };
    });
  }

  /** Lists sizing templates. */
  @GrpcMethod('CatalogService', 'ListFlavors')
  public async listFlavors(
    request: ListFlavorsRequest,
    metadata: Metadata,
  ): Promise<ListFlavorsResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listFlavors(
        actor,
        requireField(request.context?.projectId, 'project_id'),
        request.page?.limit,
        request.page?.cursor,
      );
      return { items: page.items.map(grpcFlavor), page: grpcPage(page) };
    });
  }

  /** Lists networks an instance may attach to. */
  @GrpcMethod('CatalogService', 'ListNetworks')
  public async listNetworks(
    request: ListNetworksRequest,
    metadata: Metadata,
  ): Promise<ListNetworksResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listNetworks(
        actor,
        requireField(request.context?.projectId, 'project_id'),
        request.page?.limit,
        request.page?.cursor,
      );
      return { items: page.items.map(grpcNetwork), page: grpcPage(page) };
    });
  }
}
