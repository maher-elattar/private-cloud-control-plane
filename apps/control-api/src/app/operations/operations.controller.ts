import {
  Controller,
  DefaultValuePipe,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ControlPlaneApplication, type Actor } from '@private-cloud/application';
import { CurrentActor } from '../auth/actor.decorator';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { CONTROL_PLANE_APPLICATION } from '../tokens';

@Controller('v1/projects/:projectId/operations')
@UseGuards(OidcAuthGuard)
export class OperationsController {
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) private readonly application: ControlPlaneApplication,
  ) {}

  @Get()
  public list(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.application.listOperations(actor, projectId, limit);
  }

  @Get(':operationId')
  public get(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
  ) {
    return this.application.getOperation(actor, projectId, operationId);
  }
}
