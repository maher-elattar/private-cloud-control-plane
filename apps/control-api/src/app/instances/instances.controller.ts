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
