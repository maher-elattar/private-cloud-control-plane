import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Actor } from '@private-cloud/application';
import type { FastifyRequest } from 'fastify';

export interface AuthenticatedRequest extends FastifyRequest {
  actor?: Actor;
}

export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const actor = context.switchToHttp().getRequest<AuthenticatedRequest>().actor;
    if (!actor) throw new Error('Authenticated actor was not attached to the request.');
    return actor;
  },
);
