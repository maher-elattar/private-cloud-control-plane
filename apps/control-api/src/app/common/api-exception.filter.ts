/**
 * Translates every thrown error into an RFC 9457 problem document.
 *
 * The REST counterpart of `grpc/grpc-errors.ts`; both map the same `DomainError` codes onto
 * their transport's vocabulary, so a REST and a gRPC caller get equivalent outcomes.
 *
 * WHY `@Catch()` with no argument: it catches everything. A leaked stack trace or database
 * error message is an information-disclosure bug, so the safe default is that nothing reaches
 * a client unless it has been deliberately mapped below.
 *
 * @see docs/contracts/errors.md
 */
import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { DomainError, type DomainErrorCode } from '@private-cloud/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * HTTP status for each domain error code.
 *
 * `QUOTA_EXCEEDED` and `PROFILE_DISABLED` are `422` rather than `400`: the request was
 * well-formed and understood, but the system's current state cannot satisfy it.
 */
const statusByCode: Readonly<Record<DomainErrorCode, number>> = {
  ADMIN_REQUIRED: HttpStatus.FORBIDDEN,
  DEAD_LETTER_NOT_FOUND: HttpStatus.NOT_FOUND,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  INSTANCE_BUSY: HttpStatus.CONFLICT,
  INSTANCE_NOT_FOUND: HttpStatus.NOT_FOUND,
  OPERATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  PROFILE_DISABLED: HttpStatus.UNPROCESSABLE_ENTITY,
  PROJECT_ACCESS_DENIED: HttpStatus.FORBIDDEN,
  PROJECT_NOT_FOUND: HttpStatus.NOT_FOUND,
  QUOTA_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  REPLAY_NOT_ALLOWED: HttpStatus.CONFLICT,
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** Stable machine-readable code for framework errors that carry no domain code. */
const codeByStatus: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'AUTHENTICATION_REQUIRED',
  [HttpStatus.FORBIDDEN]: 'AUTHORIZATION_FAILED',
  [HttpStatus.NOT_FOUND]: 'RESOURCE_NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
};

/** Renders any error as a problem document with a stable `code` for automation. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  /**
   * Maps the error and sends the problem document.
   *
   * Note the `detail` fallback: anything `5xx` gets a fixed generic string, because an
   * unmapped server-side failure may carry internal detail in its message. Client errors keep
   * their message, since those are written for tenants by construction.
   */
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
