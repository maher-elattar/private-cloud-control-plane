/**
 * `@CurrentActor()` — injects the authenticated caller into a REST handler parameter.
 *
 * Reads what `OidcAuthGuard` attached, so it is only valid on routes that guard covers.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Actor } from '@private-cloud/application';
import type { FastifyRequest } from 'fastify';

/** A Fastify request after `OidcAuthGuard` has attached the verified actor. */
export interface AuthenticatedRequest extends FastifyRequest {
  actor?: Actor;
}

/**
 * Injects the verified actor.
 *
 * WHY a missing actor throws instead of returning `undefined`: reaching a handler without one
 * means the route was registered without `OidcAuthGuard`. Failing loudly turns that wiring
 * mistake into an immediate `500` rather than an unauthenticated request being served.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const actor = context.switchToHttp().getRequest<AuthenticatedRequest>().actor;
    if (!actor) throw new Error('Authenticated actor was not attached to the request.');
    return actor;
  },
);
