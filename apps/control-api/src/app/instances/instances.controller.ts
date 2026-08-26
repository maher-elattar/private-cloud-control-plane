/**
 * REST surface for instance creation and readback.
 *
 * Transport adapter only. Every method unpacks the request and delegates to
 * `ControlPlaneApplication`; authorization, validation, idempotency, and persistence all live
 * behind that call. `InstanceGrpcController` is the gRPC equivalent and calls the same methods.
 *
 * WHY there is no `InstancesService` next to this file: the service layer already exists, in
 * `packages/application/src/control-plane.ts`. It lives there so it can be tested and reused
 * without NestJS. A local service that only forwarded to it would add a hop and no behaviour.
 *
 * @see docs/contracts/rest-api.md
 * @see docs/architecture/code-reading-guide.md
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
import { correlationId, requestTraceparent } from '../common/request-context';
import { CONTROL_PLANE_APPLICATION } from '../tokens';
import { CreateInstanceDto } from './create-instance.dto';

@Controller('v1/projects/:projectId/instances')
@UseGuards(OidcAuthGuard)
export class InstancesController {
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) private readonly application: ControlPlaneApplication,
  ) {}

  /**
   * Accepts a create request.
   *
   * WHY `202 Accepted` rather than `201 Created`: nothing has been created at this point. The
   * response records that intent was committed durably; the VM is built afterwards by the
   * orchestrator. Clients poll the returned operation for the outcome.
   *
   * `Idempotency-Key` is defaulted to `''` here rather than rejected, so the length rule in
   * the application service produces the same `VALIDATION_FAILED` for a missing key as for a
   * malformed one — and the same error a gRPC caller would receive.
   */
  @Post()
  @HttpCode(202)
  public create(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Body() body: CreateInstanceDto,
  ) {
    return this.application.createInstance({
      actor,
      projectId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId(correlation),
      traceparent: requestTraceparent(traceparent),
      imageId: body.imageId,
      flavorId: body.flavorId,
      networkId: body.networkId,
      hostname: body.hostname,
      ...(body.sshPublicKeys ? { sshPublicKeys: body.sshPublicKeys } : {}),
    });
  }

  @Get()
  public list(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.application.listInstances(actor, projectId, limit);
  }

  @Get(':instanceId')
  public get(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
  ) {
    return this.application.getInstance(actor, projectId, instanceId);
  }
}
