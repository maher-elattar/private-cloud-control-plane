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

@Controller('v1/projects/:projectId')
@UseGuards(OidcAuthGuard)
export class CatalogController {
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) private readonly application: ControlPlaneApplication,
  ) {}

  @Get()
  public getProject(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.application.getProject(actor, projectId);
  }

  @Get('quota')
  public getQuota(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.application.getQuota(actor, projectId);
  }

  @Get('catalog/images')
  public listImages(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.application.listImages(actor, projectId, limit);
  }

  @Get('catalog/flavors')
  public listFlavors(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.application.listFlavors(actor, projectId, limit);
  }

  @Get('catalog/networks')
  public listNetworks(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.application.listNetworks(actor, projectId, limit);
  }
}
