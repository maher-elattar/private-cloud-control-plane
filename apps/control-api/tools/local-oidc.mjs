import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const hostname = '127.0.0.1';
const port = Number.parseInt(process.env.LOCAL_OIDC_PORT ?? '18080', 10);
const issuer = `http://${hostname}:${port}`;
const audience = process.env.LOCAL_OIDC_AUDIENCE ?? 'private-cloud-control-plane';
const defaultProject = '00000000-0000-4000-8000-000000000001';
const keyId = 'phase4-local-verification';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: keyId, use: 'sig' };

/** Sends a JSON response without exposing signing material. */
function respond(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

/** Issues a short-lived token for the seeded local project. */
async function token(searchParams) {
  const roles = (searchParams.get('roles') ?? 'tenant_developer').split(',').filter(Boolean);
  const projects = (searchParams.get('projects') ?? defaultProject).split(',').filter(Boolean);
  return new SignJWT({ roles, projects })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(searchParams.get('subject') ?? 'phase4-local-user')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', issuer);
  if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
    respond(response, 200, { keys: [publicJwk] });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/token') {
    void token(url.searchParams)
      .then((accessToken) => respond(response, 200, { access_token: accessToken, expires_in: 900 }))
      .catch(() => respond(response, 500, { error: 'token_issuance_failed' }));
    return;
  }
  respond(response, 404, { error: 'not_found' });
});

server.listen(port, hostname, () => {
  process.stdout.write(
    `${JSON.stringify({ event: 'local_oidc_ready', issuer, audience, jwks: `${issuer}/.well-known/jwks.json` })}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
