/**
 * `InstanceService` — instance creation and readback over public gRPC.
 *
 * Transport adapter only. The REST equivalent is `instances/instances.controller.ts`; both
 * call the same `ControlPlaneApplication` methods, which is where authorization, validation,
 * and idempotency actually live.
 *
 * @see docs/contracts/grpc-api.md
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type {
  CreateInstanceRequest,
  CreateInstanceResponse,
  GetInstanceRequest,
  GetInstanceResponse,
  ListInstancesRequest,
  ListInstancesResponse,
} from '@private-cloud/contracts/control-plane';
import { correlationId, requestTraceparent, requestTracestate } from '../common/request-context';
import { AuthenticatedGrpcController, grpcPage } from './authenticated-grpc.controller';
import { metadataValue, requireField } from './grpc-errors';
import { grpcInstance, grpcTimestamp } from './grpc-mappers.js';

/** Serves the `InstanceService` RPCs. */
@Controller()
export class InstanceGrpcController extends AuthenticatedGrpcController {
  /**
   * Accepts a create request and returns the operation to poll.
   *
   * The response describes an *acceptance*, not a created VM — provisioning happens
   * afterwards in the orchestrator. `replayed` tells a retrying client it is looking at the
   * original acceptance rather than a second one.
   *
   * WHY `idempotency_key` is required here but defaulted on REST: the REST controller can
   * send a `422` for a missing header via the DTO layer, whereas a gRPC client has no headers
   * and must put the key in the request context. Making it explicitly required produces a
   * clear `INVALID_ARGUMENT` instead of an obscure length-validation failure later.
   */
  @GrpcMethod('InstanceService', 'CreateInstance')
  public async createInstance(
    request: CreateInstanceRequest,
    metadata: Metadata,
  ): Promise<CreateInstanceResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const inboundTraceparent = metadataValue(metadata, 'traceparent');
      const inboundTracestate = requestTracestate(
        metadataValue(metadata, 'tracestate'),
        inboundTraceparent,
      );
      const accepted = await this.application.createInstance({
        actor,
        projectId: requireField(request.context?.projectId, 'project_id'),
        idempotencyKey: requireField(request.context?.idempotencyKey, 'idempotency_key'),
        correlationId: correlationId(request.context?.correlationId),
        // Trace context travels in call metadata, not the message body, matching the W3C
        // convention that REST callers follow with the `traceparent` header.
        traceparent: requestTraceparent(inboundTraceparent),
        ...(inboundTracestate ? { tracestate: inboundTracestate } : {}),
        imageId: requireField(request.imageId, 'image_id'),
        flavorId: requireField(request.flavorId, 'flavor_id'),
        networkId: requireField(request.networkId, 'network_id'),
        hostname: requireField(request.hostname, 'hostname'),
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

  /** Lists the project's instances, most recently updated first. */
  @GrpcMethod('InstanceService', 'ListInstances')
  public async listInstances(
    request: ListInstancesRequest,
    metadata: Metadata,
  ): Promise<ListInstancesResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listInstances(
        actor,
        requireField(request.context?.projectId, 'project_id'),
        request.page?.limit,
      );
      return { items: page.items.map(grpcInstance), page: grpcPage(page) };
    });
  }

  /** Reads one instance from the read projection. */
  @GrpcMethod('InstanceService', 'GetInstance')
  public async getInstance(
    request: GetInstanceRequest,
    metadata: Metadata,
  ): Promise<GetInstanceResponse> {
    return this.handleAuthenticated(metadata, async (actor) => ({
      instance: grpcInstance(
        await this.application.getInstance(
          actor,
          requireField(request.context?.projectId, 'project_id'),
          requireField(request.instanceId, 'instance_id'),
        ),
      ),
    }));
  }
}
