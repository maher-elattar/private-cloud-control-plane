/**
 * Shared Proxmox credential loading and API session helpers.
 *
 * WHY this is its own module: two tools need the same three things — read the gitignored
 * credentials file, open an administrator session for the handful of operations a scoped token is
 * deliberately not allowed to perform, and make a request that reports its status instead of
 * throwing so a caller can treat "already exists" as success. Duplicating that would mean two
 * places where a credential is parsed, and the second copy is where the redaction rule gets
 * forgotten.
 *
 * Nothing here ever prints, logs, or returns a secret. SAFE-036 governs what enters history and
 * SAFE-031 what enters logs; a helper that echoed the password it just used would defeat both.
 *
 * @see tools/proxmox/create-api-token.mjs
 * @see tools/proxmox/build-qcow2-template.mjs
 * @see docs/architecture/safety-invariants.md
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The gitignored credentials file every Proxmox tool reads from. */
export const CREDENTIALS_PATH = resolve('terraformProxServerTestCredntails.txt');

/**
 * Reads the credentials file in either of the two shapes it has had.
 *
 * The current shape is `KEY=value` lines. The original was three bare lines — endpoint, user,
 * password — and files in that shape still exist on developer machines, so both are accepted
 * rather than failing on a file that is perfectly usable.
 *
 * @param {string} text Raw file contents.
 * @returns {{endpoint?: string, rootUsername?: string, rootPassword?: string, tokenId?: string, tokenSecret?: string}} Parsed values.
 */
export function parseCredentials(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (lines.some((line) => /^[A-Z][A-Z0-9_]*=/.test(line))) {
    const values = Object.fromEntries(
      lines
        .filter((line) => line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    return {
      endpoint: values.PROXMOX_ENDPOINT?.replace(/\/$/, ''),
      rootUsername: values.PROXMOX_ROOT_USERNAME,
      rootPassword: values.PROXMOX_ROOT_PASSWORD,
      tokenId: values.PROXMOX_API_TOKEN_ID,
      tokenSecret: values.PROXMOX_API_TOKEN_SECRET,
    };
  }
  const [endpoint, user, password] = lines;
  return {
    endpoint: endpoint?.replace(/\/$/, ''),
    rootUsername: user?.includes('@') ? user : `${user}@pam`,
    rootPassword: password,
  };
}

/**
 * Loads and validates the credentials file.
 *
 * @returns {Promise<ReturnType<typeof parseCredentials>>} Parsed credentials with an endpoint.
 * @throws {Error} If the file carries no endpoint, which means it is unusable rather than partial.
 */
export async function loadCredentials() {
  const credentials = parseCredentials(await readFile(CREDENTIALS_PATH, 'utf8'));
  if (!credentials.endpoint) throw new Error(`${CREDENTIALS_PATH}: no endpoint found.`);
  return credentials;
}

/**
 * Authenticates as the administrator.
 *
 * Used only for operations a scoped token is deliberately unable to perform — creating a role,
 * granting an ACL, allocating a VMID outside the token's allowlist. Everything the control plane
 * does at runtime goes through the token instead.
 *
 * @param {ReturnType<typeof parseCredentials>} credentials Loaded credentials.
 * @returns {Promise<{cookie: string, csrf: string}>} Session material for `administer`.
 * @throws {Error} If no password is present, or the login is refused.
 */
export async function administratorSession(credentials) {
  if (!credentials.rootPassword) {
    throw new Error('Administrator credentials are required for this operation.');
  }
  const response = await fetch(`${credentials.endpoint}/api2/json/access/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: credentials.rootUsername,
      password: credentials.rootPassword,
    }),
  });
  if (!response.ok) throw new Error(`Administrator login failed: ${response.status}`);
  const { data } = await response.json();
  return { cookie: `PVEAuthCookie=${data.ticket}`, csrf: data.CSRFPreventionToken };
}

/**
 * One administrative call.
 *
 * Returns `{ ok, status, data, raw }` rather than throwing, because "already exists" is a success
 * for an idempotent tool and distinguishing it needs the response body.
 *
 * @param {{cookie: string, csrf: string}} session From `administratorSession`.
 * @param {string} endpoint Base endpoint, without a trailing slash.
 * @param {string} method HTTP method.
 * @param {string} path Path below `/api2/json`.
 * @param {Record<string, string|number>} [body] Form body, when the call takes one.
 * @returns {Promise<{ok: boolean, status: number, data: unknown, raw: string}>} The outcome.
 */
export async function administer(session, endpoint, method, path, body) {
  const response = await fetch(`${endpoint}/api2/json${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      CSRFPreventionToken: session.csrf,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { ok: response.ok, status: response.status, data: parsed?.data, raw: text };
}

/**
 * Reports what an administrative step did, without ever echoing a secret.
 *
 * @param {string} step Human-readable step name.
 * @param {{ok: boolean, status: number, raw: string}} result From `administer`.
 * @param {string} [alreadyExists] Parenthetical used when the step was a no-op.
 * @returns {boolean} Whether the step succeeded or was already satisfied.
 */
export function report(step, result, alreadyExists = 'already present') {
  if (result.ok) {
    process.stdout.write(`  created  ${step}\n`);
    return true;
  }
  if (result.status === 500 && /already exists/i.test(result.raw)) {
    process.stdout.write(`  reused   ${step} (${alreadyExists})\n`);
    return true;
  }
  process.stdout.write(`  FAILED   ${step}: ${result.status} ${result.raw.slice(0, 160)}\n`);
  return false;
}

/**
 * Waits for a Proxmox task (UPID) to leave the running state.
 *
 * WHY poll rather than assume: clone and disk conversion are long asynchronous tasks, and the
 * calls that start them return as soon as the task is queued. Treating that as completion is how
 * a script ends up converting a disk that is still being copied.
 *
 * @param {{cookie: string, csrf: string}} session From `administratorSession`.
 * @param {string} endpoint Base endpoint.
 * @param {string} node Node the task runs on.
 * @param {string} upid Task identifier returned by the call that started it.
 * @param {number} [timeoutMs] How long to wait before calling the outcome unknown.
 * @returns {Promise<string>} The task's exit status, which is `OK` on success.
 * @throws {Error} If the task does not settle within the timeout.
 */
export async function awaitTask(session, endpoint, node, upid, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await administer(
      session,
      endpoint,
      'GET',
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    );
    if (status.ok && status.data?.status !== 'running') return status.data?.exitstatus ?? 'unknown';
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Task did not settle within ${Math.round(timeoutMs / 1000)}s: ${upid}`);
}
