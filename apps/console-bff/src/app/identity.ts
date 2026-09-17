/**
 * Exchanging a username and password for an access token.
 *
 * WHY a password grant, when it is deprecated in OAuth 2.1. The console needs its own login
 * screen, which rules out an authorization-code redirect to the issuer's page — there is no such
 * page here anyway. The local issuer is a development stand-in for a real provider, and this is
 * the grant that lets the console own the credential prompt while the *verification* still happens
 * at the issuer rather than in the console.
 *
 * What this replaces matters more than what it is. The issuer previously had a single endpoint,
 * `GET /token?roles=…&projects=…`, which minted a signed token for whatever was asked with no
 * credential at all. A login page in front of that would have been theatre: type anything, get
 * administrator. That endpoint still exists for the verification scripts that depend on it, and is
 * documented as development-only.
 *
 * In a real deployment `OIDC_ISSUER` points at a real provider and this module points with it.
 */
import { structuredLog } from './log.js';

/** What a successful exchange yields. */
export interface Identity {
  readonly accessToken: string;
  readonly subject: string;
  readonly displayName: string;
  readonly projectId: string;
  readonly expiresAt: number;
}

/** Why an exchange failed, in terms the caller can act on. */
export type IdentityFailure =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'unavailable'; readonly detail: string };

/** Seconds-to-milliseconds, for the issuer's `expires_in`. */
const MS_PER_SECOND = 1000;

/**
 * Reads the `projects` and `sub` claims from a token without verifying it.
 *
 * WHY not verifying is acceptable here: this process received the token from the issuer it just
 * authenticated against, over the connection it opened, and it is only reading the claims to know
 * which project to show. The **control plane** verifies the signature, issuer, audience and
 * algorithm on every request — that is the check that matters, and duplicating it here would mean
 * two verifiers that could disagree about what a valid token is.
 *
 * @param token A JWT.
 * @returns The subject and first project, when present.
 */
function claims(token: string): { subject?: string; projectId?: string } {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return {};
    const record = decoded as Record<string, unknown>;
    const projects = Array.isArray(record['projects']) ? record['projects'] : [];
    const first = projects.find((entry): entry is string => typeof entry === 'string');
    return {
      ...(typeof record['sub'] === 'string' ? { subject: record['sub'] } : {}),
      ...(first === undefined ? {} : { projectId: first }),
    };
  } catch {
    return {};
  }
}

/**
 * Exchanges credentials for a token at the configured issuer.
 *
 * @param issuer Base URL of the OIDC issuer.
 * @param credentials The username and password as typed.
 * @returns The identity, or why it could not be established.
 */
export async function authenticate(
  issuer: string,
  credentials: { readonly username: string; readonly password: string },
): Promise<Identity | IdentityFailure> {
  let response: Response;
  try {
    response = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        username: credentials.username,
        password: credentials.password,
      }),
      // A login that hangs is a login that fails. The issuer is on the same network.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return {
      kind: 'unavailable',
      detail: error instanceof Error ? error.message : 'The identity provider did not answer.',
    };
  }

  if (response.status === 401 || response.status === 400) {
    // Deliberately not distinguishing "no such user" from "wrong password". Telling them apart
    // for the caller also tells them apart for someone enumerating accounts.
    structuredLog('info', 'console_login_rejected', {
      username_length: credentials.username.length,
    });
    return { kind: 'rejected' };
  }
  if (response.status !== 200) {
    return {
      kind: 'unavailable',
      detail: `The identity provider answered ${response.status}.`,
    };
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  const token = body.access_token;
  if (!token) return { kind: 'unavailable', detail: 'The identity provider returned no token.' };

  const { subject, projectId } = claims(token);
  if (!projectId) {
    // A token with no project is an administrator's, and the customer console has nothing to show
    // one. Refusing here is clearer than rendering an empty project and every request 403-ing.
    return { kind: 'rejected' };
  }

  return {
    accessToken: token,
    subject: subject ?? credentials.username,
    displayName: credentials.username,
    projectId,
    expiresAt: Date.now() + (body.expires_in ?? 900) * MS_PER_SECOND,
  };
}
