/**
 * Server-side sessions for the console.
 *
 * WHY the access token never reaches the browser. A tenant token carries `roles` and `projects`
 * claims and is a bearer credential for the whole control plane — anything holding it can create
 * and destroy servers. Storing it in `localStorage` or `sessionStorage` puts it within reach of
 * any script that runs on the page, which is exactly what the `react-router` advisories this
 * console shipped with were about. Keeping it here and handing the browser only an opaque,
 * httpOnly cookie means a cross-site scripting bug can act *through* the session but can never
 * exfiltrate the credential to be used later or elsewhere.
 *
 * The store is in-process on purpose. Sessions are short — a token from the local issuer lasts
 * fifteen minutes — and a restart signing everyone out is the correct behaviour for a console
 * whose credentials are not durable anyway. A shared store would be required for more than one
 * replica, and is the thing to add when there is more than one.
 */
import { randomBytes } from 'node:crypto';

/** How long a session may live regardless of the token's own expiry. */
const MAXIMUM_SESSION_MS = 12 * 60 * 60 * 1000;

/** What the console knows about a signed-in user. */
export interface SessionRecord {
  readonly subject: string;
  readonly displayName: string;
  readonly projectId: string;
  /** The bearer token. Never serialised to a response, never logged. */
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

/** What a session looks like to the browser: no credential at all. */
export interface PublicSession {
  readonly subject: string;
  readonly displayName: string;
  readonly projectId: string;
  readonly expiresAt: string;
}

/**
 * An in-process session store.
 *
 * Expiry is checked on read rather than swept on a timer: a session nobody asks about costs one
 * map entry, and a timer that has to be cancelled on shutdown is a more moving part than the
 * problem deserves.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  /**
   * Creates a session and returns its identifier.
   *
   * @param record Everything but the timestamps, which are set here so a caller cannot backdate one.
   * @returns The opaque session id to put in the cookie.
   */
  public create(record: Omit<SessionRecord, 'createdAt'>): string {
    // 32 bytes from the CSPRNG. This value is the credential as far as the browser is concerned,
    // so it has to be unguessable rather than merely unique — a UUID would be neither.
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...record, createdAt: Date.now() });
    return id;
  }

  /**
   * Reads a live session, dropping it if it has expired.
   *
   * @param id The session id from the cookie, if there was one.
   * @returns The session, or undefined when there is none or it is too old.
   */
  public read(id: string | undefined): SessionRecord | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const expired =
      Date.now() >= session.expiresAt || Date.now() - session.createdAt >= MAXIMUM_SESSION_MS;
    if (expired) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Ends a session. Idempotent, so a repeated sign-out is not an error. */
  public destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /** How many sessions are held, for the readiness payload. Never the sessions themselves. */
  public get size(): number {
    return this.sessions.size;
  }
}

/** Projects a session onto the shape the browser may see. */
export function publicView(session: SessionRecord): PublicSession {
  return {
    subject: session.subject,
    displayName: session.displayName,
    projectId: session.projectId,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}
