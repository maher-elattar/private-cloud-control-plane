import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { OidcAuthService } from './oidc-auth.service';
import type { AuthenticatedRequest } from './actor.decorator';

@Injectable()
export class OidcAuthGuard implements CanActivate {
  public constructor(private readonly auth: OidcAuthService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.actor = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
