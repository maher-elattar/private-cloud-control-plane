import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { DomainError, type DomainErrorCode } from '@private-cloud/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

const statusByCode: Readonly<Record<DomainErrorCode, number>> = {
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  INSTANCE_BUSY: HttpStatus.CONFLICT,
  INSTANCE_NOT_FOUND: HttpStatus.NOT_FOUND,
  OPERATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  PROFILE_DISABLED: HttpStatus.UNPROCESSABLE_ENTITY,
  PROJECT_ACCESS_DENIED: HttpStatus.FORBIDDEN,
  PROJECT_NOT_FOUND: HttpStatus.NOT_FOUND,
  QUOTA_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
};

const codeByStatus: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'AUTHENTICATION_REQUIRED',
  [HttpStatus.FORBIDDEN]: 'AUTHORIZATION_FAILED',
  [HttpStatus.NOT_FOUND]: 'RESOURCE_NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const domain = exception instanceof DomainError ? exception : null;
    const http = exception instanceof HttpException ? exception : null;
    const status = domain ? statusByCode[domain.code] : (http?.getStatus() ?? 500);
    const code = domain?.code ?? codeByStatus[status] ?? 'INTERNAL_ERROR';
    const detail =
      domain?.message ??
      (status < 500 ? 'The request could not be completed.' : 'An internal error occurred.');

    void response.status(status).send({
      type: `https://private-cloud.invalid/problems/${code.toLowerCase()}`,
      title: code.replaceAll('_', ' '),
      status,
      detail,
      code,
      instance: request.url,
    });
  }
}
