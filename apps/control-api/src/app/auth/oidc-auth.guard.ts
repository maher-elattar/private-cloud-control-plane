/**
 * REST route guard: authenticates the caller and attaches the `Actor` to the request.
 *
 * The gRPC controllers deliberately do not use this. A guard rejection throws an
 * `HttpException`, which the gRPC transport would surface as an opaque `UNKNOWN`; those
 * controllers authenticate inside their own try/catch instead. Both paths call the same
 * `OidcAuthService`.
 */
import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { OidcAuthService } from './oidc-auth.service';
import type { AuthenticatedRequest } from './actor.decorator';

/** Verifies the bearer token on every REST route it guards. */
@Injectable()
export class OidcAuthGuard implements CanActivate {
  /** @param auth Shared token verifier. */
  public constructor(private readonly auth: OidcAuthService) {}

  /**
   * Authenticates and attaches the actor, or rejects the request.
   *
   * Always returns `true` — authorization is not decided here. Whether this actor may touch
   * the requested project is settled by `ControlPlaneApplication.authorize`, so the rule is
   * shared with gRPC rather than duplicated per transport.
   */
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.actor = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
