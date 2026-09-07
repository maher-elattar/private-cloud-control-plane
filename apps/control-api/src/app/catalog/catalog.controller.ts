/**
 * REST surface for project, quota, and catalog reads.
 *
 * Transport adapter only — delegates every method to `ControlPlaneApplication`.
 * `CatalogGrpcController` is the gRPC equivalent and calls the same methods.
 *
 * These reads are served from `control.*` directly rather than a projection, because catalog
 * data is small and changes only through operator action. See the glossary on read projections
 * for why instances and operations are handled differently.
 *
 * @see docs/contracts/rest-api.md
 */
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
    @Query('cursor') cursor?: string,
  ) {
    return this.application.listImages(actor, projectId, limit, cursor);
  }

  @Get('catalog/flavors')
  public listFlavors(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.application.listFlavors(actor, projectId, limit, cursor);
  }

  @Get('catalog/networks')
  public listNetworks(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.application.listNetworks(actor, projectId, limit, cursor);
  }
}
