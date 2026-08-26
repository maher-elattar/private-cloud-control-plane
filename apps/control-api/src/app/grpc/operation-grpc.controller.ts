/**
 * `OperationService` — asynchronous operation readback over public gRPC.
 *
 * This is the polling surface. A client that receives an acceptance from `CreateInstance`
 * polls `GetOperation` until the operation reaches a terminal state. The REST equivalent is
 * `operations/operations.controller.ts`.
 *
 * @see docs/architecture/state-machines.md
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type {
  GetOperationRequest,
  GetOperationResponse,
  ListOperationsRequest,
  ListOperationsResponse,
} from '@private-cloud/contracts/control-plane';
import { AuthenticatedGrpcController, grpcPage } from './authenticated-grpc.controller';
import { requireField } from './grpc-errors';
import { grpcOperation } from './grpc-mappers.js';

/** Serves the `OperationService` RPCs. */
@Controller()
export class OperationGrpcController extends AuthenticatedGrpcController {
  /** Lists the project's operations, most recently updated first. */
  @GrpcMethod('OperationService', 'ListOperations')
  public async listOperations(
    request: ListOperationsRequest,
    metadata: Metadata,
  ): Promise<ListOperationsResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listOperations(
        actor,
        requireField(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return { items: page.items.map(grpcOperation), page: grpcPage(page) };
    });
  }

  /**
   * Reads one operation — the progress record for an accepted mutation.
   *
   * Served from the read projection, so its stage and progress reflect the last workflow
   * event the projection worker has applied.
   */
  @GrpcMethod('OperationService', 'GetOperation')
  public async getOperation(
    request: GetOperationRequest,
    metadata: Metadata,
  ): Promise<GetOperationResponse> {
    return this.handleAuthenticated(metadata, async (actor) => ({
      operation: grpcOperation(
        await this.application.getOperation(
          actor,
          requireField(request.context?.projectId, 'project_id'),
          requireField(request.operationId, 'operation_id'),
        ),
      ),
    }));
  }
}
