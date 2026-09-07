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
  Delete,
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
import { DomainError } from '@private-cloud/domain';
import { CurrentActor } from '../auth/actor.decorator';
import { OidcAuthGuard } from '../auth/oidc-auth.guard';
import { correlationId, requestTraceparent, requestTracestate } from '../common/request-context';
import { CONTROL_PLANE_APPLICATION } from '../tokens';
import { CreateInstanceDto } from './create-instance.dto';
import { InstanceActionDto } from './instance-action.dto';
import { CreateSnapshotDto, SnapshotRollbackDto } from './snapshot.dto';

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
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
    @Body() body: CreateInstanceDto,
  ) {
    const validatedTracestate = requestTracestate(tracestate, traceparent);
    return this.application.createInstance({
      actor,
      projectId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId(correlation),
      traceparent: requestTraceparent(traceparent),
      ...(validatedTracestate ? { tracestate: validatedTracestate } : {}),
      imageId: body.imageId,
      flavorId: body.flavorId,
      networkId: body.networkId,
      hostname: body.hostname,
      ...(body.sshPublicKeys ? { sshPublicKeys: body.sshPublicKeys } : {}),
    });
  }

  /**
   * Accepts a power transition on an existing instance.
   *
   * `202` for the same reason as create: nothing has changed on the provider yet. A `409` here
   * means the instance already has an operation in flight — the per-instance concurrency rule —
   * rather than a conflicting idempotency key.
   */
  @Post(':instanceId/actions')
  @HttpCode(202)
  public act(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
    @Body() body: InstanceActionDto,
  ) {
    const validatedTracestate = requestTracestate(tracestate, traceparent);
    const identity = {
      actor,
      projectId,
      instanceId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId(correlation),
      traceparent: requestTraceparent(traceparent),
      ...(validatedTracestate ? { tracestate: validatedTracestate } : {}),
    };
    if (body.action === 'resize') {
      // `flavorId` is defaulted to `''` rather than rejected here so a missing value produces the
      // same `VALIDATION_FAILED` a gRPC caller would get, from the same place.
      return this.application.resizeInstance({
        ...identity,
        flavorId: body.flavorId ?? '',
        ...(body.diskGiB === undefined ? {} : { diskGiB: body.diskGiB }),
      });
    }
    return this.application.mutateInstancePower({ ...identity, action: body.action });
  }

  /**
   * Soft-deletes an instance.
   *
   * `DELETE` here does not destroy anything: it detaches tenant access and retains the provider
   * resource for review until an administrator purges it. `202` because the detach happens
   * asynchronously; the retention deadline and address handling are decided at acceptance.
   *
   * @see docs/adr/0007-soft-delete-and-guarded-purge.md
   */
  @Delete(':instanceId')
  @HttpCode(202)
  public retain(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
  ) {
    return this.application.retainInstance(
      this.mutationIdentity(
        actor,
        projectId,
        instanceId,
        idempotencyKey,
        correlation,
        traceparent,
        tracestate,
      ),
    );
  }

  /** Lists an instance's snapshots. */
  @Get(':instanceId/snapshots')
  public listSnapshots(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.application.listSnapshots(actor, projectId, instanceId, limit, cursor);
  }

  /** Accepts a snapshot creation. */
  @Post(':instanceId/snapshots')
  @HttpCode(202)
  public createSnapshot(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
    @Body() body: CreateSnapshotDto,
  ) {
    return this.application.createSnapshot({
      ...this.mutationIdentity(
        actor,
        projectId,
        instanceId,
        idempotencyKey,
        correlation,
        traceparent,
        tracestate,
      ),
      name: body.name,
      ...(body.description ? { description: body.description } : {}),
    });
  }

  /**
   * Accepts a rollback to a snapshot.
   *
   * A rollback discards everything written since the snapshot. The contract models it as an
   * action rather than a bare POST so the intent is explicit in the request body.
   */
  @Post(':instanceId/snapshots/:snapshotId/actions')
  @HttpCode(202)
  public rollbackSnapshot(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Param('snapshotId', new ParseUUIDPipe()) snapshotId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
    @Body() body: SnapshotRollbackDto,
  ) {
    if (body.action !== 'rollback') {
      throw new DomainError('VALIDATION_FAILED', 'The only supported snapshot action is rollback.');
    }
    return this.application.rollbackSnapshot({
      ...this.mutationIdentity(
        actor,
        projectId,
        instanceId,
        idempotencyKey,
        correlation,
        traceparent,
        tracestate,
      ),
      snapshotId,
    });
  }

  /** Accepts the deletion of a snapshot. */
  @Delete(':instanceId/snapshots/:snapshotId')
  @HttpCode(202)
  public deleteSnapshot(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('instanceId', new ParseUUIDPipe()) instanceId: string,
    @Param('snapshotId', new ParseUUIDPipe()) snapshotId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
  ) {
    return this.application.deleteSnapshot({
      ...this.mutationIdentity(
        actor,
        projectId,
        instanceId,
        idempotencyKey,
        correlation,
        traceparent,
        tracestate,
      ),
      snapshotId,
    });
  }

  /** The mutation identity every instance-scoped route builds the same way. */
  private mutationIdentity(
    actor: Actor,
    projectId: string,
    instanceId: string,
    idempotencyKey: string | undefined,
    correlation: string | undefined,
    traceparent: string | undefined,
    tracestate: string | undefined,
  ) {
    const validatedTracestate = requestTracestate(tracestate, traceparent);
    return {
      actor,
      projectId,
      instanceId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId(correlation),
      traceparent: requestTraceparent(traceparent),
      ...(validatedTracestate ? { tracestate: validatedTracestate } : {}),
    };
  }

  @Get()
  public list(
    @CurrentActor() actor: Actor,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.application.listInstances(actor, projectId, limit, cursor);
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
