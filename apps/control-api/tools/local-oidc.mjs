import { createServer } from 'node:http';
import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { importJWK, SignJWT } from 'jose';

const scrypt = promisify(scryptCallback);

const hostname = process.env.LOCAL_OIDC_HOST?.trim() || '127.0.0.1';
const port = Number.parseInt(process.env.LOCAL_OIDC_PORT ?? '18080', 10);
const issuer = process.env.LOCAL_OIDC_ISSUER?.trim() || `http://${hostname}:${port}`;
const audience = process.env.LOCAL_OIDC_AUDIENCE ?? 'private-cloud-control-plane';
const defaultProject = '00000000-0000-4000-8000-000000000001';
const keyId = 'phase4-local-verification';

// This fixed key is intentionally limited to the local integration issuer. Stable signing material
// makes tokens reproducible across container restarts; production trusts an external OIDC provider.
const signingJwk = {
  kty: 'RSA',
  n: 'tfkyXeFN_bKmA45u-EwzcX9cPoEe24XVQEDYgwwndA0cVwgZcUiI0KR7I_GHBQPqbsoMH71xI6uyAfEksGJhJ-WbJX9YxEW_1iPXCIoO-dsGOIBoOeQcSwFQoSKemz6EuLwxfUMTQp2JEcQMBedEbv2ZuEG3nOYZoL7HpWiSWIQ5jQ8tPB1WZl5fQG54Bp-Yn9NffQ1F39y2w6jq4nrTTU-luRaAAWMtx9C6XULxUgxirGXRApjdafBrGtKQMhKEFQFJVd925yxrXwG-Rvvz2DNZ6poVHwhdy119BMkpacTrzIXZjm2DPeyGa9BC-wzFiny88aP6NWGFS7G-E3K9kw',
  e: 'AQAB',
  d: 'R5iRKYCwx8VXLgUHQifxAZHDgFAbDPHeElaxGPZaO33BDbkBEaIhOj3MuTqZDe8ZeJeEJ6TIc-lkswDml4NNiH39CcbN7QMoVB9rxk9TTxjOnMJgv44xV41f5NYTIy941posuoT-efIzcMr6lAQG18hth6JLlK6vnKATOtAm7C4Fxq2S1spZSPt0WAs0TYVxzeiJTfboDrZNhtQNoPC3d5unCGRW_wZFD4gP9KoysRqsG-04KOF-xZAVORvnUEOyL4XOBhrYP7J80Ey7Usd0fGoWuQMgK_V9oSdPmqAZX1VcY6UoxT_WZQYwSAYKDp9K2wv0Ipr_RL0lU8DWXYoNWQ',
  p: '_dSk9LIOWpP8dDJSRWyLEwJe-51NOuT1_mN5xVmmmhwJ62Jxgib-AtJpEVVn3RMNJ319GvePE0bvcaEz0AGl_v0sOdh77yYhQvm0zmHGIr6ywu5pEi48jdTVQQ5ypPCLB1SOhymJHEijxwcnxdWT98uLCYh_0jlq8XV16q_pq1c',
  q: 't4dWCqCfozgCu5fW4AqPUj4mZEQkfyoOj1dIXqlmcVLWrxbcmI0wwXaFSAZBfEf_kQ6Ch1bxcu-yL58ygjw1aeMz48bPPQdWlmw3EaLr5fhYngXz0mP_PB_7s8RhxrDRLAgKGhtWcQ557d2AbXQCxZnxhTL2IUuS4JfaVED4liU',
  dp: 'fqFyNd0Kiief33wnTRksfKxHJHHCUKpfCq0n18u08NciH7r587tuJ4w-_HXGHiVd_6B8JFLynuRZmi-YwKHB5Wb6hFU65wD3wQkAKaHfjf_jAJqd8oL8lKlkRlNl4GFciqilfkq7a0_V3Pn13p2BdzKlR3lAg2k_r_wweoeOJHs',
  dq: 'dRemoK8sSsGQlMlicZyrJki6y9viATP_CBsi9CpWTtUQXbNTWQ0z3yrUDEjZfQaempjMVLb242Lkp5eFbSwm1AD-eUO9su08pEo0tE7i_N1_BIs9razZCi5Js78GtvLW8aXLdC6e7xDSYB2jM7IBlrsKKfaCrGmAM0UPKhQtxfU',
  qi: 'Pv9YFk9iOr_d0fDrjJul1GgOME00y6CNfK3eTbihm12d31FGcTGEIQ_QhFCLaYyj15_JGIHXStDunjf31cx-NiyVQE1DiSClP4ACLmQw2GEixprHcl89TRGoQl9eREhhQUzSbF_wqUh_HV7l7YLGRjs_zRQV1opT7j_yA1B45rY',
  alg: 'RS256',
  kid: keyId,
  use: 'sig',
};
const privateKey = await importJWK(signingJwk, 'RS256');
const publicJwk = {
  kty: signingJwk.kty,
  n: signingJwk.n,
  e: signingJwk.e,
  alg: signingJwk.alg,
  kid: signingJwk.kid,
  use: signingJwk.use,
};

/**
 * The seeded development users, read from the environment.
 *
 * Format, one record per entry, semicolon-separated:
 *
 *     username:scrypt-hex:salt-hex:roles,comma,separated:projects,comma,separated
 *
 * WHY this exists at all. Until now the only way to obtain a token here was `GET /token`, which
 * mints one for whatever roles and projects are asked for, with **no credential of any kind**.
 * That is exactly right for the verification scripts, which need a token without a login flow, and
 * exactly wrong as the thing a login page talks to: a console in front of it would be theatre —
 * type anything, receive administrator.
 *
 * WHY a hash and not a password. The value reaches this process through an environment variable
 * that is generated into a gitignored file, and SAFE-036 governs what may enter history. A hash
 * means a leaked environment does not hand over a reusable credential, and it costs one line.
 *
 * This is still a development identity stub. Production points `OIDC_ISSUER` at a real provider
 * and none of this runs.
 */
const users = new Map(
  (process.env.LOCAL_OIDC_USERS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, hash, salt, roles, projects] = entry.split(':');
      return [
        username,
        {
          hash: hash ?? '',
          salt: salt ?? '',
          roles: (roles ?? 'tenant_developer').split(',').filter(Boolean),
          projects: (projects ?? '').split(',').filter(Boolean),
        },
      ];
    }),
);

/**
 * Verifies a password against a seeded user.
 *
 * Comparison is `timingSafeEqual` on the derived key rather than `===` on the hex, and an unknown
 * username still performs a derivation before failing — so the answer takes the same time whether
 * the user exists or not, and cannot be used to enumerate accounts.
 *
 * @param {string} username The username as typed.
 * @param {string} password The password as typed.
 * @returns {Promise<{roles: string[], projects: string[]} | null>} The user, or null.
 */
async function verify(username, password) {
  const user = users.get(username);
  const salt = user?.salt ?? 'absent';
  const expected = Buffer.from(user?.hash ?? '00'.repeat(32), 'hex');
  const derived = await scrypt(password, salt, expected.length);
  const matches = expected.length === derived.length && timingSafeEqual(expected, derived);
  return user && matches ? { roles: user.roles, projects: user.projects } : null;
}

/** Sends a JSON response without exposing signing material. */
function respond(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

/**
 * Issues a short-lived token for whatever was asked for, with no credential.
 *
 * **Development only.** `tools/verification/verify-*.mjs` depend on this, which is why it is still
 * here, but anything that can reach it can mint an administrator token for any project. It must
 * never be exposed outside a local stack, and a real deployment replaces this whole process.
 *
 * The credential-verifying path is `POST /token` below.
 */
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
  if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    respond(response, 200, {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      token_endpoint: `${issuer}/token`,
      grant_types_supported: ['password'],
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'],
    });
    return;
  }
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
  if (request.method === 'POST' && url.pathname === '/token') {
    // The OAuth 2.0 password grant. Deprecated in OAuth 2.1 and not what production should use —
    // but it is the only grant that lets the console own its own sign-in screen, which is the
    // point of having one here rather than redirecting to a page this stub does not have.
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      // A login body is a few hundred bytes. Anything larger is not a login.
      if (body.length > 4096) request.destroy();
    });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'password') {
        respond(response, 400, { error: 'unsupported_grant_type' });
        return;
      }
      void verify(form.get('username') ?? '', form.get('password') ?? '')
        .then(async (user) => {
          if (!user) {
            // One answer for an unknown user and a wrong password alike.
            respond(response, 401, { error: 'invalid_grant' });
            return;
          }
          const parameters = new URLSearchParams();
          parameters.set('roles', user.roles.join(','));
          parameters.set('projects', user.projects.join(','));
          parameters.set('subject', form.get('username') ?? 'local-user');
          respond(response, 200, {
            access_token: await token(parameters),
            token_type: 'Bearer',
            expires_in: 900,
          });
        })
        .catch(() => respond(response, 500, { error: 'token_issuance_failed' }));
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health/live') {
    respond(response, 200, { status: 'ok' });
    return;
  }
  respond(response, 404, { error: 'not_found' });
});

server.listen(port, hostname, () => {
  process.stdout.write(
    `${JSON.stringify({ event: 'local_oidc_ready', issuer, audience, users: users.size, jwks: `${issuer}/.well-known/jwks.json` })}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
