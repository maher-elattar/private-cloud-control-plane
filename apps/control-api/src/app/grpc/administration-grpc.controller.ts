/**
 * `AdministrationService` — the restricted operational surface over public gRPC.
 *
 * The contract has always declared this service, but until now it existed only on REST, so a
 * gRPC client had no way to inspect a dead letter or authorize a replay despite the published
 * contract promising transport parity. This controller closes that gap for the four
 * Phase 4 methods; the remaining sixteen belong to Phase 5 capabilities and land with them.
 *
 * Like the other gRPC controllers here, it is transport only: authorization is the
 * administrator role check inside `ControlPlaneApplication`, not something asserted here.
 *
 * @see docs/contracts/grpc-api.md
 * @see apps/control-api/src/app/administration/dead-letters.controller.ts
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type {
  GetAdministrativeOperationRequest,
  GetAdministrativeOperationResponse,
  ListAuditEventsRequest,
  ListAuditEventsResponse,
  ListDeadLettersRequest,
  ListDeadLettersResponse,
  ReplayDeadLetterRequest,
  ReplayDeadLetterResponse,
} from '@private-cloud/contracts/control-plane';
import { correlationId, requestTraceparent, requestTracestate } from '../common/request-context';
import { AuthenticatedGrpcController, grpcPage } from './authenticated-grpc.controller';
import { metadataValue, requireField } from './grpc-errors';
import {
  grpcAdministrativeOperation,
  grpcAuditEvent,
  grpcDeadLetter,
  grpcMutationAccepted,
} from './grpc-mappers.js';

/** Serves the Phase 4 `AdministrationService` RPCs. */
@Controller()
export class AdministrationGrpcController extends AuthenticatedGrpcController {
  /** Lists sanitised dead-letter evidence; original command payloads stay workflow-owned. */
  @GrpcMethod('AdministrationService', 'ListDeadLetters')
  public async listDeadLetters(
    request: ListDeadLettersRequest,
    metadata: Metadata,
  ): Promise<ListDeadLettersResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listDeadLetters(
        actor,
        request.page?.limit,
        request.page?.cursor,
      );
      return { items: page.items.map(grpcDeadLetter), page: grpcPage(page) };
    });
  }

  /**
   * Reads one operation with its recovery metadata, across every project.
   *
   * Unlike `OperationService.GetOperation` this takes no project context, because the
   * administrator authorizing a replay is routinely not a member of the affected project.
   */
  @GrpcMethod('AdministrationService', 'GetAdministrativeOperation')
  public async getAdministrativeOperation(
    request: GetAdministrativeOperationRequest,
    metadata: Metadata,
  ): Promise<GetAdministrativeOperationResponse> {
    return this.handleAuthenticated(metadata, async (actor) => ({
      operation: grpcAdministrativeOperation(
        await this.application.getAdministrativeOperation(
          actor,
          requireField(request.operationId, 'operation_id'),
        ),
      ),
    }));
  }

  /** Lists attributed audit facts, optionally narrowed to one project or operation. */
  @GrpcMethod('AdministrationService', 'ListAuditEvents')
  public async listAuditEvents(
    request: ListAuditEventsRequest,
    metadata: Metadata,
  ): Promise<ListAuditEventsResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const page = await this.application.listAuditEvents(
        actor,
        {
          ...(request.projectId ? { projectId: request.projectId } : {}),
          ...(request.operationId ? { operationId: request.operationId } : {}),
        },
        request.page?.limit,
        request.page?.cursor,
      );
      return { items: page.items.map(grpcAuditEvent), page: grpcPage(page) };
    });
  }

  /**
   * Accepts attributed replay intent into the transactional outbox.
   *
   * The trace carrier comes from call metadata rather than a request field, so a gRPC replay
   * links to the failed workflow trace exactly as the REST route does.
   */
  @GrpcMethod('AdministrationService', 'ReplayDeadLetter')
  public async replayDeadLetter(
    request: ReplayDeadLetterRequest,
    metadata: Metadata,
  ): Promise<ReplayDeadLetterResponse> {
    return this.handleAuthenticated(metadata, async (actor) => {
      const traceparent = requestTraceparent(metadataValue(metadata, 'traceparent'));
      const tracestate = requestTracestate(metadataValue(metadata, 'tracestate'), traceparent);
      return {
        accepted: grpcMutationAccepted(
          await this.application.requestDeadLetterReplay({
            actor,
            originalEventId: requireField(request.eventId, 'event_id'),
            idempotencyKey: request.context?.idempotencyKey ?? '',
            correlationId: correlationId(request.context?.correlationId),
            traceparent,
            ...(tracestate ? { tracestate } : {}),
            // The reason is required by the contract, so an absent one must fail validation
            // in the application rather than silently become an empty justification here.
            reason: requireField(request.reason, 'reason'),
          }),
        ),
      };
    });
  }
}
