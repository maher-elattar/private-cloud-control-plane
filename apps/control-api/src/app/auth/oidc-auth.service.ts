import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '@private-cloud/application';
import { createRemoteJWKSet, jwtVerify } from 'jose';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function stringArray(value: unknown, claim: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new UnauthorizedException(`The ${claim} claim is invalid.`);
  }
  return [...value];
}

@Injectable()
export class OidcAuthService {
  private readonly issuer = requiredEnvironment('OIDC_ISSUER');
  private readonly audience = requiredEnvironment('OIDC_AUDIENCE');
  private readonly jwks = createRemoteJWKSet(new URL(requiredEnvironment('OIDC_JWKS_URI')));

  public async authenticate(authorization: string | undefined): Promise<Actor> {
    const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
    if (!match?.[1]) throw new UnauthorizedException('Bearer authentication is required.');

    try {
      const { payload } = await jwtVerify(match[1], this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
      });
      if (!payload.sub) throw new UnauthorizedException('The subject claim is required.');
      return {
        subject: payload.sub,
        roles: stringArray(payload.roles, 'roles'),
        projects: stringArray(payload.projects, 'projects'),
      };
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Bearer token validation failed.');
    }
  }
}
