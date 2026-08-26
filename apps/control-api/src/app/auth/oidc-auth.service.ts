/**
 * Verifies OIDC bearer tokens and turns them into an `Actor`.
 *
 * Used by `OidcAuthGuard` for REST and called directly by the gRPC controllers. This is the
 * only place a token is validated, so both transports authenticate identically.
 *
 * WHY every failure collapses to a generic message: distinguishing "expired" from "wrong
 * audience" from "bad signature" tells an attacker which part of a forged token to change.
 * The specific reason stays in the process logs.
 *
 * @see docs/security/trust-boundaries.md
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '@private-cloud/application';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Reads required OIDC configuration, failing at startup rather than at first request. */
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/**
 * Reads a claim that must be an array of strings.
 *
 * A malformed claim is treated as an authentication failure rather than an empty list. An
 * empty `projects` claim would silently deny every request, which is much harder to diagnose
 * than an explicit rejection.
 */
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

  /**
   * Verifies a bearer token and extracts the caller's identity and claims.
   *
   * `RS256` is pinned explicitly: accepting whatever algorithm the token declares would allow
   * an `alg: none` or HMAC-substitution attack against the JWKS public key.
   *
   * Note this establishes *who* the caller is, not what they may do. Project access is decided
   * by `ControlPlaneApplication.authorize`, so both transports share one rule.
   *
   * @throws UnauthorizedException for any missing, malformed, or unverifiable token.
   */
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
