/**
 * Administrative read surface: audit history and operation recovery detail.
 *
 * Both routes close holes Phase 4 opened. The audit *write* path — an `audit.entries` row plus
 * an `audit.events.v1` fact in the owner transaction — was completed without any way to read it
 * back. And the replay `202` returns a tenant-scoped `statusUrl`, which an administrator who is
 * not a member of the affected project cannot follow.
 *
 * Authorization is the administrator role check inside `ControlPlaneApplication`. Neither route
 * filters by project membership, deliberately: an administrator reads across projects by
 * design, and re-imposing membership here would recreate the hole the operation route exists to
 * close.
 *
 * @see docs/architecture/data-ownership.md
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ControlPlaneApplication, type Actor } from '@private-cloud/application';
import { CurrentActor } from '../auth/actor.decorator';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { correlationId, requestTraceparent, requestTracestate } from '../common/request-context';
import { CONTROL_PLANE_APPLICATION } from '../tokens';
import { PurgeRequestDto } from './purge-request.dto';

@Controller('v1/admin')
@UseGuards(OidcAuthGuard)
export class AdministrationController {
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) private readonly application: ControlPlaneApplication,
  ) {}

  /**
   * Reads one operation with its recovery metadata.
   *
   * Returns the tenant `Operation` fields plus correlation, causation, trace, retry count,
   * checkpoint, dead-letter link, and provider task reference — the last of which is
   * restricted-operational and never appears on a tenant route.
   */
  @Get('operations/:operationId')
  public getOperation(
    @CurrentActor() actor: Actor,
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
  ) {
    return this.application.getAdministrativeOperation(actor, operationId);
  }

  /**
   * Destroys a retained instance.
   *
   * The only route in the system that removes a provider resource. Four guards stand between this
   * request and destruction, and none of them is in this controller: the confirmation must match,
   * the instance must be retained, its retention deadline must have passed, and the workflow must
   * prove live provider ownership immediately before acting.
   *
   * @see docs/adr/0007-soft-delete-and-guarded-purge.md
   */
  @Post('instances/:instanceId/purges')
  @HttpCode(202)
  public purge(
    @CurrentActor() actor: Actor,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
    @Body() body: PurgeRequestDto,
  ) {
    const validatedTracestate = requestTracestate(tracestate, traceparent);
    return this.application.purgeInstance({
      actor,
      instanceId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId(correlation),
      traceparent: requestTraceparent(traceparent),
      ...(validatedTracestate ? { tracestate: validatedTracestate } : {}),
      reason: body.reason,
      confirmInstanceId: body.confirmInstanceId,
    });
  }

  /**
   * Marks an instance for reconciliation on the next sweep.
   *
   * `202` rather than `200`: nothing has been observed yet. The sweep owns the provider budget,
   * so an administrative request records intent rather than triggering an immediate provider call.
   */
  @Post('instances/:instanceId/reconciliations')
  @HttpCode(202)
  public async reconcile(
    @CurrentActor() actor: Actor,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
  ) {
    await this.application.requestReconciliation(actor, instanceId);
    return { instanceId, accepted: true };
  }

  /** Lists attributed audit facts, most recent first, optionally narrowed. */
  @Get('audit-events')
  public listAuditEvents(
    @CurrentActor() actor: Actor,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
    @Query('projectId') projectId?: string,
    @Query('operationId') operationId?: string,
  ) {
    return this.application.listAuditEvents(
      actor,
      {
        ...(projectId ? { projectId } : {}),
        ...(operationId ? { operationId } : {}),
      },
      limit,
      cursor,
    );
  }
}
