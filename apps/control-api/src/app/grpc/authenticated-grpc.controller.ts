/**
 * Shared base for the public gRPC controllers.
 *
 * The three controllers under this directory each expose one gRPC service, and all three need
 * the same two dependencies and the same authenticate-then-translate-errors wrapper. That
 * shared shape lives here rather than being repeated three times.
 *
 * WHY authentication is a method call rather than a `@UseGuards` guard: the REST controllers
 * use `OidcAuthGuard`, but a guard rejecting a gRPC call throws an `HttpException`, which the
 * gRPC transport reports as an opaque `UNKNOWN`. Authenticating inside
 * {@link AuthenticatedGrpcController.handleAuthenticated} keeps the failure inside the same
 * try/catch that maps it to `UNAUTHENTICATED`.
 *
 * @see docs/contracts/grpc-api.md
 */
import { Inject } from '@nestjs/common';
import { ControlPlaneApplication, type Actor, type Page } from '@private-cloud/application';
import type { Metadata } from '@grpc/grpc-js';
import { OidcAuthService } from '../auth/oidc-auth.service';
import { CONTROL_PLANE_APPLICATION } from '../tokens';
import { metadataValue, rpcError } from './grpc-errors';

/** Protobuf page envelope returned alongside every list response. */
interface GrpcPage {
  readonly limit: number;
  readonly nextCursor?: string;
}

/**
 * Maps an application page envelope onto its protobuf form.
 *
 * `nextCursor` is omitted rather than sent as `''` when absent, because protobuf cannot
 * distinguish an empty string from an unset field — an explicit `''` would read to a client
 * as "there is a next page, at cursor empty-string".
 */
export function grpcPage<T>(page: Page<T>): GrpcPage {
  return {
    limit: page.page.limit,
    ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
  };
}

/**
 * Authenticates gRPC calls and translates thrown errors into gRPC statuses.
 *
 * Subclasses supply `@GrpcMethod` handlers and delegate to the application service. They must
 * not contain business logic — this is a transport adapter, exactly like the REST controllers.
 */
export abstract class AuthenticatedGrpcController {
  /**
   * @param application The application service. Injected by token because it is deliberately
   *   not a NestJS provider — see `packages/application/src/control-plane.ts`.
   * @param auth Verifies the bearer token carried in call metadata.
   */
  public constructor(
    @Inject(CONTROL_PLANE_APPLICATION) protected readonly application: ControlPlaneApplication,
    protected readonly auth: OidcAuthService,
  ) {}

  /**
   * Authenticates the caller, runs the handler, and maps any failure to a gRPC status.
   *
   * Every RPC in every subclass goes through here, so no handler can accidentally skip
   * authentication or leak an unmapped internal error.
   */
  protected async handleAuthenticated<T>(
    metadata: Metadata,
    handler: (actor: Actor) => Promise<T>,
  ): Promise<T> {
    try {
      const actor = await this.auth.authenticate(metadataValue(metadata, 'authorization'));
      return await handler(actor);
    } catch (error: unknown) {
      throw rpcError(error);
    }
  }
}
