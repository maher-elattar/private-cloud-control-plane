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
import { ReplayRequestDto } from './replay-request.dto';

/** Restricted operational recovery surface for governed dead letters. */
@Controller('v1/admin/dead-letters')
@UseGuards(OidcAuthGuard)
export class DeadLettersController {
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) private readonly application: ControlPlaneApplication,
  ) {}

  /** Lists sanitised evidence only; original command payloads remain workflow-owned. */
  @Get()
  public list(
    @CurrentActor() actor: Actor,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.application.listDeadLetters(actor, limit);
  }

  /** Accepts attributed replay intent into the transactional outbox. */
  @Post(':eventId/replays')
  @HttpCode(202)
  public replay(
    @CurrentActor() actor: Actor,
    @Param('eventId', new ParseUUIDPipe()) originalEventId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Headers('tracestate') tracestate: string | undefined,
    @Body() body: ReplayRequestDto,
  ) {
    const validatedTracestate = requestTracestate(tracestate, traceparent);
    return this.application.requestDeadLetterReplay({
      actor,
      originalEventId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: correlationId(correlation),
      traceparent: requestTraceparent(traceparent),
      ...(validatedTracestate ? { tracestate: validatedTracestate } : {}),
      reason: body.reason,
    });
  }
}
