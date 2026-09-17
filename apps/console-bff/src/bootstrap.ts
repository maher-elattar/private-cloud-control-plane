/**
 * The console's own server.
 *
 * It does four things, and the reason they live in one process rather than in nginx is that three
 * of them need to hold a secret the browser must not.
 *
 * 1. **Serves the built single-page app**, with a history fallback — the router uses real paths
 *    like `/servers/:id/networking`, so any unmatched GET has to return the document.
 * 2. **Signs a user in**, exchanging their credentials at the issuer and keeping the resulting
 *    token server-side behind an httpOnly cookie.
 * 3. **Proxies the API**, attaching that token. This also removes the cross-origin problem
 *    entirely: `control-api` sets no CORS headers at all, so a console served from anywhere else
 *    could not call it.
 * 4. **Answers liveness and readiness**, which both the Compose healthcheck convention and the
 *    Kubernetes probes policy require.
 *
 * @see apps/console-bff/src/app/session.ts
 * @see docs/architecture/safety-invariants.md
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { structuredLog, traceReference } from './app/log.js';
import { authenticate } from './app/identity.js';
import { problem } from './app/problem.js';
import { publicView, SessionStore } from './app/session.js';

/** The cookie the browser holds. Opaque, httpOnly, and the only credential it ever sees. */
const SESSION_COOKIE = 'console_session';

/**
 * The API's body limit, matched exactly.
 *
 * `control-api` sets `bodyLimit: 65_536`. A proxy that accepted more would turn a clean 413 from
 * this process into a truncated request the API rejects for a less obvious reason.
 */
const BODY_LIMIT = 65_536;

/** Request headers the proxy forwards. Everything else is dropped rather than passed through. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'idempotency-key',
  'x-correlation-id',
  'traceparent',
  'tracestate',
];

/** Reads a required setting, failing at startup rather than on the first request. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function bootstrap(): Promise<void> {
  const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
  const apiBase = required('CONTROL_API_URL').replace(/\/$/, '');
  const issuer = required('OIDC_ISSUER').replace(/\/$/, '');
  const staticRoot = process.env['CONSOLE_STATIC_ROOT']?.trim() || join(process.cwd(), 'public');
  // `Secure` is omitted over plain HTTP because a browser silently drops a Secure cookie on an
  // insecure origin — which presents as "login appears to work but the session never sticks".
  const secureCookies = (process.env['CONSOLE_SECURE_COOKIES'] ?? 'false').trim() === 'true';

  const sessions = new SessionStore();
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: false });

  await app.register(cookie);
  await app.register(staticFiles, { root: staticRoot, prefix: '/', wildcard: false });

  const indexHtml = await readFile(join(staticRoot, 'index.html'), 'utf8').catch(() => undefined);

  // --- Health ---------------------------------------------------------------------------------
  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    // Readiness depends on the API being reachable, because a console that cannot reach it can
    // render nothing but an error. It deliberately does *not* depend on the issuer: an issuer
    // outage stops new sign-ins but leaves existing sessions working, and taking the console out
    // of rotation for that would turn a partial outage into a total one.
    try {
      const response = await fetch(`${apiBase}/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        return reply.code(503).send({ status: 'degraded', detail: 'control-api is not ready' });
      }
    } catch {
      return reply.code(503).send({ status: 'degraded', detail: 'control-api is unreachable' });
    }
    return { status: 'ok', sessions: sessions.size };
  });

  // --- Session --------------------------------------------------------------------------------
  app.post('/auth/login', async (httpRequest, reply) => {
    const body = httpRequest.body as { username?: unknown; password?: unknown } | undefined;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      return reply
        .code(422)
        .type('application/problem+json')
        .send(
          problem({
            status: 422,
            title: 'Sign-in details are incomplete',
            code: 'VALIDATION_FAILED',
            detail: 'Enter both a username and a password.',
            ...traceReference(httpRequest.headers['traceparent'] as string | undefined),
          }),
        );
    }

    const identity = await authenticate(issuer, { username, password });
    if ('kind' in identity) {
      if (identity.kind === 'rejected') {
        return reply
          .code(401)
          .type('application/problem+json')
          .send(
            problem({
              status: 401,
              title: 'Sign-in failed',
              code: 'AUTHENTICATION_REQUIRED',
              detail: 'That username and password combination was not accepted.',
              ...traceReference(httpRequest.headers['traceparent'] as string | undefined),
            }),
          );
      }
      return reply
        .code(503)
        .type('application/problem+json')
        .send(
          problem({
            status: 503,
            title: 'Sign-in is unavailable',
            code: 'DEPENDENCY_UNAVAILABLE',
            detail: identity.detail,
            ...traceReference(httpRequest.headers['traceparent'] as string | undefined),
          }),
        );
    }

    const id = sessions.create({
      subject: identity.subject,
      displayName: identity.displayName,
      projectId: identity.projectId,
      accessToken: identity.accessToken,
      expiresAt: identity.expiresAt,
    });
    structuredLog('info', 'console_login_succeeded', {
      subject: identity.subject,
      project_id: identity.projectId,
    });
    return reply
      .setCookie(SESSION_COOKIE, id, {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookies,
        path: '/',
      })
      .send(
        publicView({
          subject: identity.subject,
          displayName: identity.displayName,
          projectId: identity.projectId,
          accessToken: identity.accessToken,
          expiresAt: identity.expiresAt,
          createdAt: Date.now(),
        }),
      );
  });

  app.post('/auth/logout', async (httpRequest, reply) => {
    sessions.destroy(httpRequest.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/auth/session', async (httpRequest, reply) => {
    const session = sessions.read(httpRequest.cookies[SESSION_COOKIE]);
    if (!session) {
      return reply
        .code(401)
        .type('application/problem+json')
        .send(
          problem({
            status: 401,
            title: 'Not signed in',
            code: 'AUTHENTICATION_REQUIRED',
            detail: 'There is no active session.',
            ...traceReference(httpRequest.headers['traceparent'] as string | undefined),
          }),
        );
    }
    return publicView(session);
  });

  // --- API proxy ------------------------------------------------------------------------------
  app.all('/v1/*', async (httpRequest, reply) => {
    const session = sessions.read(httpRequest.cookies[SESSION_COOKIE]);
    if (!session) {
      // The same code the API uses, so the browser's single re-authentication path covers both.
      return reply
        .code(401)
        .type('application/problem+json')
        .send(
          problem({
            status: 401,
            title: 'Not signed in',
            code: 'AUTHENTICATION_REQUIRED',
            detail: 'Sign in again to continue.',
            instance: httpRequest.url,
            ...traceReference(httpRequest.headers['traceparent'] as string | undefined),
          }),
        );
    }

    const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = httpRequest.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    try {
      const upstream = await fetch(`${apiBase}${httpRequest.url}`, {
        method: httpRequest.method,
        headers,
        ...(httpRequest.method === 'GET' || httpRequest.method === 'HEAD'
          ? {}
          : { body: JSON.stringify(httpRequest.body ?? {}) }),
        // Generous, because a create on real hardware takes about a minute and the console polls
        // rather than holding the request open — but bounded, so a wedged upstream cannot pin a
        // connection here indefinitely.
        signal: AbortSignal.timeout(30_000),
      });
      const contentType = upstream.headers.get('content-type');
      return reply
        .code(upstream.status)
        .type(contentType ?? 'application/json')
        .send(await upstream.text());
    } catch (error) {
      return reply
        .code(502)
        .type('application/problem+json')
        .send(
          problem({
            status: 502,
            title: 'The control plane could not be reached',
            code: 'DEPENDENCY_UNAVAILABLE',
            detail: error instanceof Error ? error.message : 'The request did not complete.',
            instance: httpRequest.url,
            ...traceReference(httpRequest.headers['traceparent'] as string | undefined),
          }),
        );
    }
  });

  // --- History fallback -----------------------------------------------------------------------
  app.setNotFoundHandler(async (httpRequest, reply) => {
    // Only GETs get the document. A POST to an unknown path is a mistake, and answering it with
    // an HTML page would turn a 404 into a JSON parse error in the caller.
    if (httpRequest.method !== 'GET' || !indexHtml) {
      return reply
        .code(404)
        .type('application/problem+json')
        .send(
          problem({
            status: 404,
            title: 'Not found',
            code: 'VALIDATION_FAILED',
            detail: 'No such route.',
            instance: httpRequest.url,
          }),
        );
    }
    return reply.code(200).type('text/html; charset=utf-8').send(indexHtml);
  });

  const close = async (): Promise<void> => {
    await app.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void close().then(() => process.exit(0)));
  }

  await app.listen({ port, host: '0.0.0.0' });
  structuredLog('info', 'console_bff_ready', { port, api: apiBase, issuer });
}
