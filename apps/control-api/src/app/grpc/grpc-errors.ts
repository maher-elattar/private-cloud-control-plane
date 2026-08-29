/**
 * Error and metadata translation for the public gRPC surface.
 *
 * The REST surface has `ApiExceptionFilter` for this job. gRPC needs its own because it maps
 * onto canonical gRPC status codes rather than HTTP statuses, and because NestJS microservice
 * exception filters do not see errors thrown before a handler is entered.
 *
 * WHY every path ends in a `RpcException`: an unmapped error would surface as a raw
 * `UNKNOWN` carrying whatever message the failure happened to hold — potentially a database
 * error or a provider hostname. Mapping every case keeps internal detail inside the process.
 *
 * @see docs/contracts/errors.md
 */
import { HttpException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status, type Metadata } from '@grpc/grpc-js';
import { DomainError } from '@private-cloud/domain';

/** gRPC status for each HTTP status the transport layer may raise. */
const STATUS_BY_HTTP_CODE: Readonly<Record<number, status>> = {
  400: status.INVALID_ARGUMENT,
  401: status.UNAUTHENTICATED,
  403: status.PERMISSION_DENIED,
  404: status.NOT_FOUND,
  409: status.ALREADY_EXISTS,
  422: status.FAILED_PRECONDITION,
};

/**
 * gRPC status for each domain error code.
 *
 * `QUOTA_EXCEEDED` maps to `RESOURCE_EXHAUSTED` and `INSTANCE_BUSY` to `ABORTED` because both
 * are retryable-after-a-change, which is what those codes signal to a generated client.
 */
const STATUS_BY_DOMAIN_CODE: Readonly<Record<DomainError['code'], status>> = {
  ADMIN_REQUIRED: status.PERMISSION_DENIED,
  DEAD_LETTER_NOT_FOUND: status.NOT_FOUND,
  IDEMPOTENCY_CONFLICT: status.ALREADY_EXISTS,
  INSTANCE_BUSY: status.ABORTED,
  INSTANCE_NOT_FOUND: status.NOT_FOUND,
  OPERATION_NOT_FOUND: status.NOT_FOUND,
  PROFILE_DISABLED: status.FAILED_PRECONDITION,
  PROJECT_ACCESS_DENIED: status.PERMISSION_DENIED,
  PROJECT_NOT_FOUND: status.NOT_FOUND,
  QUOTA_EXCEEDED: status.RESOURCE_EXHAUSTED,
  REPLAY_NOT_ALLOWED: status.FAILED_PRECONDITION,
  VALIDATION_FAILED: status.INVALID_ARGUMENT,
};

/** Reads a single string value from call metadata, or `undefined` when absent. */
export function metadataValue(metadata: Metadata, key: string): string | undefined {
  const value = metadata.get(key)[0];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Asserts a required request field is present.
 *
 * WHY this exists at all: protobuf scalar fields are never absent on the wire — an unset
 * string arrives as `''`. Validation therefore cannot be delegated to the message definition
 * the way `class-validator` handles it for REST, and has to be explicit here.
 *
 * @throws DomainError `VALIDATION_FAILED`, which becomes `INVALID_ARGUMENT`.
 */
export function requireField(value: string | undefined, field: string): string {
  if (!value) throw new DomainError('VALIDATION_FAILED', `${field} is required.`);
  return value;
}

/**
 * Converts any thrown value into an `RpcException` with a safe message.
 *
 * The `401` case is special-cased to a fixed string: `OidcAuthService` messages distinguish a
 * missing header from a failed signature check, which is useful in logs but tells an
 * unauthenticated caller more about the token check than it needs to know.
 *
 * Anything unrecognised becomes `INTERNAL` with a generic message — the original is left to
 * the process logs rather than sent to the caller.
 */
export function rpcError(error: unknown): RpcException {
  if (error instanceof RpcException) return error;
  if (error instanceof HttpException) {
    return new RpcException({
      code: STATUS_BY_HTTP_CODE[error.getStatus()] ?? status.UNKNOWN,
      message: error.getStatus() === 401 ? 'Bearer authentication failed.' : error.message,
    });
  }
  if (error instanceof DomainError) {
    // Domain messages are written for tenants and carry no internal detail by construction.
    return new RpcException({ code: STATUS_BY_DOMAIN_CODE[error.code], message: error.message });
  }
  return new RpcException({ code: status.INTERNAL, message: 'Internal service error.' });
}
