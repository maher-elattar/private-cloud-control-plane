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
import {
  PowerAction,
  type CreateInstanceRequest,
  type CreateInstanceResponse,
  type GetInstanceRequest,
  type GetInstanceResponse,
  type ListInstancesRequest,
  type ListInstancesResponse,
  type MutateInstanceRequest,
  type MutateInstanceResponse,
} from '@private-cloud/contracts/control-plane';
import { correlationId, requestTraceparent, requestTracestate } from '../common/request-context';
import { AuthenticatedGrpcController, grpcPage } from './authenticated-grpc.controller';
import { metadataValue, requireField } from './grpc-errors';
import { grpcInstance, grpcMutationAccepted } from './grpc-mappers.js';

/**
 * Maps the protobuf power enum onto the domain's action vocabulary.
 *
 * Unknown and unspecified values are passed through as-is so the domain validator produces the
 * same `VALIDATION_FAILED` a REST caller would get, rather than this layer inventing an error.
 */
function powerActionName(value: PowerAction | undefined): string {
  switch (value) {
    case PowerAction.POWER_ACTION_START:
      return 'start';
    case PowerAction.POWER_ACTION_SHUTDOWN:
      return 'shutdown';
    case PowerAction.POWER_ACTION_STOP:
      return 'stop';
    case PowerAction.POWER_ACTION_REBOOT:
      return 'reboot';
    default:
      return String(value ?? '');
  }
}

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
        accepted: grpcMutationAccepted(accepted),
      };
    });
  }

  /**
   * Accepts a power transition on an existing instance.
   *
   * The proto models the action as a `oneof`, so a request carrying neither branch is a client
   * error rather than a default. Resize is declared here and lands with its own capability;
   * until then it is refused explicitly instead of being silently ignored.
   */
  @GrpcMethod('InstanceService', 'MutateInstance')
  public async mutateInstance(
    request: MutateInstanceRequest,
    metadata: Metadata,
  ): Promise<MutateInstanceResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const traceparent = requestTraceparent(metadataValue(metadata, 'traceparent'));
      const tracestate = requestTracestate(metadataValue(metadata, 'tracestate'), traceparent);
      const identity = {
        actor,
        projectId: requireField(request.context?.projectId, 'project_id'),
        instanceId: requireField(request.instanceId, 'instance_id'),
        idempotencyKey: request.context?.idempotencyKey ?? '',
        correlationId: correlationId(request.context?.correlationId),
        traceparent,
        ...(tracestate ? { tracestate } : {}),
      };
      // The proto models the action as a `oneof`, so exactly one branch should be set. Resize wins
      // when both are, because sending both is a client error and silently applying the power half
      // would be the more surprising of the two outcomes.
      const accepted = request.resize
        ? await this.application.resizeInstance({
            ...identity,
            flavorId: request.resize.flavorId ?? '',
            ...(request.resize.diskGib === undefined
              ? {}
              : { diskGiB: Number(request.resize.diskGib) }),
          })
        : await this.application.mutateInstancePower({
            ...identity,
            action: powerActionName(request.power),
          });
      return { accepted: grpcMutationAccepted(accepted) };
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
        request.page?.cursor,
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
