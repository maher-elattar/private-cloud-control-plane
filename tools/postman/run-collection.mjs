/**
 * Runs the generated Postman collection headlessly against the cluster.
 *
 * WHY this exists rather than a `newman` dependency: the collection has to be provably runnable in
 * continuous verification, and adding a Node dependency tree to run one JSON file is a poor trade
 * against a few hundred lines that execute exactly the Postman surface this collection uses. What
 * is executed here is the generated `.postman_collection.json` itself — not a parallel
 * reimplementation of it — so a run proves the artifact a person would import actually works.
 *
 * The supported Postman surface is deliberately small and is the whole vocabulary the generator
 * emits: `pm.response`, `pm.test`, `pm.expect` (`eql`, `oneOf`, `property`, `lengthOf`, `include`),
 * `pm.collectionVariables`, `pm.variables.replaceIn`, `pm.info.requestName`,
 * `pm.execution.skipRequest`, and `postman.setNextRequest`. A script reaching for anything else
 * fails loudly rather than being quietly skipped.
 *
 * It also manages the one piece of setup a person does by hand: the port-forward to the in-cluster
 * OIDC fixture. The fixture has no route through the Gateway on purpose, so without a forward every
 * request in the collection fails on a missing token, which reads as an API failure rather than a
 * missing tunnel.
 *
 * Usage:
 *   node tools/postman/run-collection.mjs              # run everything, manage the port-forward
 *   node tools/postman/run-collection.mjs --check      # verify the generated files are current
 *   node tools/postman/run-collection.mjs --folder=03  # run folders whose name starts with "03"
 *   node tools/postman/run-collection.mjs --no-forward # a forward is already running elsewhere
 *
 * Writes captured request/response pairs to `docs/verification/evidence/phase6-api-examples.json`,
 * which is what `docs/operations/phase-6-api-examples.md` is transcribed from.
 *
 * @see docs/operations/phase-6-api-examples.md
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { KUBE_CONTEXT } from '../kubernetes/kubectl.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const COLLECTION_PATH = join(HERE, 'private-cloud-control-plane.postman_collection.json');
const ENVIRONMENT_PATH = join(HERE, 'minikube.postman_environment.json');
const EVIDENCE_PATH = join(ROOT, 'docs', 'verification', 'evidence', 'phase6-api-examples.json');

/** Namespace and Service the identity fixture runs as. */
const OIDC_NAMESPACE = 'private-cloud';
const OIDC_SERVICE = 'local-oidc';
/** Local port for the forward. Not 18080: the Phase 4 Compose stack binds that, and a token from
 *  that issuer carries a different `iss` claim and is rejected by the cluster with a bare 401. */
const OIDC_LOCAL_PORT = 18085;
const OIDC_REMOTE_PORT = 18080;
/** How long a re-sent poll request waits before trying again. */
const POLL_DELAY_MS = 2000;
/** Hard cap on re-sends of a single request, so a never-settling operation ends the run. */
const MAX_RESENDS = 90;
/** Per-request network timeout. Generous: an accept may wait on a database under first load. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Attempts per request before a transport error is reported as that request's failure. */
const TRANSPORT_ATTEMPTS = 3;
/** Pause between transport attempts, long enough for a replacing pod to become routable. */
const TRANSPORT_RETRY_DELAY_MS = 3000;

/** Waits for a duration. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Performs one HTTP request.
 *
 * Uses `node:http` rather than `fetch` for one reason: `fetch` refuses to send a caller-supplied
 * `Host` header, and this collection reaches the Gateway by IP and selects the route with that
 * header. Under `fetch` every request would arrive without it and the Gateway would answer 404,
 * which looks exactly like an unrouted API.
 *
 * @param {string} method HTTP method.
 * @param {string} url Absolute URL.
 * @param {Record<string, string>} headers Request headers.
 * @param {string | undefined} body Raw request body.
 * @returns {Promise<{ status: number, headers: object, text: string }>} Captured response.
 */
function send(method, url, headers, body) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = { ...headers };
    if (body !== undefined) outgoing['content-length'] = String(Buffer.byteLength(body));
    const clientRequest = httpRequest(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers: outgoing,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, text }),
        );
      },
    );
    clientRequest.on('timeout', () => {
      clientRequest.destroy(
        new Error(`${method} ${url} timed out after ${REQUEST_TIMEOUT_MS} ms.`),
      );
    });
    clientRequest.on('error', reject);
    if (body !== undefined) clientRequest.write(body);
    clientRequest.end();
  });
}

/**
 * Starts the port-forward and waits until the fixture answers through it.
 *
 * @returns {Promise<{ stop: () => void }>} Handle that terminates the forward.
 * @throws Error when the fixture does not answer, which usually means the pod is not ready.
 */
async function startPortForward() {
  const child = spawn(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      'port-forward',
      '-n',
      OIDC_NAMESPACE,
      `svc/${OIDC_SERVICE}`,
      `${OIDC_LOCAL_PORT}:${OIDC_REMOTE_PORT}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let diagnostics = '';
  child.stdout.on('data', (chunk) => (diagnostics += chunk));
  child.stderr.on('data', (chunk) => (diagnostics += chunk));

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(500);
    try {
      const probe = await send(
        'GET',
        `http://127.0.0.1:${OIDC_LOCAL_PORT}/health/live`,
        {},
        undefined,
      );
      if (probe.status === 200) {
        process.stdout.write(`port-forward   ${OIDC_SERVICE} on 127.0.0.1:${OIDC_LOCAL_PORT}\n`);
        return { stop: () => child.kill('SIGTERM') };
      }
    } catch {
      // Not listening yet.
    }
  }
  child.kill('SIGTERM');
  throw new Error(
    `The OIDC fixture did not answer on 127.0.0.1:${OIDC_LOCAL_PORT}.\n` +
      `kubectl reported: ${diagnostics.trim() || '(nothing)'}\n` +
      `Check the pod: kubectl get pods -n ${OIDC_NAMESPACE} -l app.kubernetes.io/name=${OIDC_SERVICE}`,
  );
}

/**
 * Builds the minimal chai-like assertion object the generated scripts use.
 *
 * @param {unknown} actual Value under assertion.
 * @returns {object} Assertion chain.
 */
function expectation(actual) {
  const show = (value) => JSON.stringify(value) ?? String(value);

  /**
   * The predicates, expressed as "does this hold?" so `.not` can invert them uniformly.
   *
   * Written this way rather than as a set of throwing assertions because Postman's `.not` negates
   * the whole chain, and a collection that uses it in the GUI must behave identically here.
   */
  const predicates = {
    eql: [(expected) => JSON.stringify(actual) === JSON.stringify(expected), 'equal'],
    oneOf: [(options) => options.includes(actual), 'be one of'],
    property: [
      (name) => actual !== null && typeof actual === 'object' && name in actual,
      'have property',
    ],
    lengthOf: [(length) => actual?.length === length, 'have length'],
    include: [(member) => Array.isArray(actual) && actual.includes(member), 'include'],
  };

  const build = (negated) => {
    const chain = {};
    for (const [name, [holds, verb]] of Object.entries(predicates)) {
      chain[name] = (argument) => {
        if (holds(argument) === negated) {
          throw new Error(
            `expected ${show(actual)}${negated ? ' not' : ''} to ${verb} ${show(argument)}`,
          );
        }
      };
    }
    chain.to = chain;
    chain.be = chain;
    chain.have = chain;
    chain.not = negated ? chain : build(true);
    return chain;
  };

  return build(false);
}

/**
 * Substitutes `{{name}}` references, including Postman's `{{$guid}}` generator.
 *
 * @param {string} text Template text.
 * @param {Map<string, string>} variables Variable store.
 * @returns {string} Resolved text.
 * @throws Error on an unresolved reference, which is always a collection bug and never something
 *   to send to the server as a literal `{{name}}`.
 */
function substitute(text, variables) {
  return text.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
    if (name === '$guid') return randomUUID();
    if (variables.has(name)) return variables.get(name);
    throw new Error(`Unresolved collection variable '${name}' in: ${text}`);
  });
}

/**
 * Runs one collection item and records the outcome.
 *
 * @param {object} entry Flattened item with its folder name.
 * @param {Map<string, string>} variables Variable store, mutated by scripts.
 * @param {object[]} captured Evidence accumulator.
 * @returns {Promise<{ skipped: boolean, resend: boolean, failures: string[], passed: string[] }>} Outcome.
 */
async function runItem(entry, variables, captured) {
  const { item } = entry;
  const failures = [];
  const passed = [];
  let skipped = false;
  let nextRequest;

  const pm = {
    info: { requestName: item.name },
    collectionVariables: {
      get: (name) => variables.get(name) ?? '',
      set: (name, value) => variables.set(name, String(value)),
    },
    environment: {
      get: (name) => variables.get(name) ?? '',
      set: (name, value) => variables.set(name, String(value)),
    },
    variables: { replaceIn: (text) => substitute(text, variables) },
    execution: { skipRequest: () => (skipped = true) },
    expect: expectation,
    test: (name, body) => {
      try {
        body();
        passed.push(name);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    },
    response: undefined,
  };
  const sandbox = createContext({
    pm,
    postman: { setNextRequest: (name) => (nextRequest = name) },
    setTimeout,
    console,
    JSON,
    Date,
    Number,
    Array,
    Object,
    String,
    Boolean,
  });

  const script = (listen) =>
    item.event?.find((event) => event.listen === listen)?.script?.exec?.join('\n') ?? '';

  const before = script('prerequest');
  if (before) runInContext(before, sandbox, { filename: `${item.name} (pre-request)` });
  if (skipped) return { skipped: true, resend: false, failures, passed };

  const url = substitute(item.request.url, variables);
  const headers = {};
  for (const header of item.request.header ?? []) {
    headers[header.key] = substitute(header.value, variables);
  }
  const body = item.request.body?.raw ? substitute(item.request.body.raw, variables) : undefined;

  // WHY transport errors are retried rather than propagated: a rolling pod, a promotion moving the
  // active Service, or a re-established port-forward all produce a reset connection that is not a
  // finding about the API. Retrying twice distinguishes a moment of turbulence from a real outage,
  // and reporting it as this request's failure keeps the rest of the run — including the folders
  // that prove refusals still work — from being lost to one dropped socket.
  if (process.env.PHASE6_POSTMAN_TRACE)
    process.stderr.write(`    → ${item.request.method} ${url}\n`);
  let response;
  let transportError;
  for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      response = await send(item.request.method, url, headers, body);
      transportError = undefined;
      break;
    } catch (error) {
      transportError = error;
      if (attempt < TRANSPORT_ATTEMPTS - 1) await sleep(TRANSPORT_RETRY_DELAY_MS);
    }
  }
  if (transportError) {
    failures.push(`transport: ${transportError.message}`);
    return { skipped: false, resend: false, failures, passed };
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    parsed = undefined;
  }
  pm.response = {
    code: response.status,
    status: String(response.status),
    text: () => response.text,
    json: () => {
      if (parsed === undefined)
        throw new Error(`Response body is not JSON: ${response.text.slice(0, 200)}`);
      return parsed;
    },
    headers: { get: (name) => response.headers[name.toLowerCase()] },
  };

  if (process.env.PHASE6_POSTMAN_TRACE)
    process.stderr.write(`    ← ${response.status} ${response.text.slice(0, 160)}\n`);
  const after = script('test');
  if (after) runInContext(after, sandbox, { filename: `${item.name} (test)` });

  const resend = nextRequest === item.name;
  if (!resend) {
    // Redact the bearer token before the exchange is written to an evidence file that is committed.
    const recordedHeaders = { ...headers };
    if (recordedHeaders.Authorization) recordedHeaders.Authorization = 'Bearer <redacted>';
    captured.push({
      folder: entry.folder,
      name: item.name,
      method: item.request.method,
      url,
      requestHeaders: recordedHeaders,
      requestBody: body ? JSON.parse(body) : undefined,
      status: response.status,
      responseBody: redactTokens(parsed ?? response.text),
    });
  }
  return { skipped: false, resend, failures, passed };
}

/**
 * Field names whose value is signed credential material rather than an API result.
 *
 * WHY this exists as well as the `Authorization` header redaction below: the identity folder's
 * token endpoint returns the bearer token in its *response body*, so redacting only the request
 * header would still write three fully signed JWTs into an evidence file that is committed. The
 * fixture's tokens are short-lived and only valid against an in-cluster issuer, but SAFE-036 is
 * about what enters history, not about how exploitable a particular value happens to be.
 */
const CREDENTIAL_FIELDS = new Set(['access_token', 'id_token', 'refresh_token', 'client_secret']);

/**
 * Replaces credential-bearing fields anywhere in a captured response body.
 *
 * @param {unknown} value Parsed response body, or the raw text when it was not JSON.
 * @returns {unknown} The same shape with every credential field replaced by a marker.
 */
function redactTokens(value) {
  if (Array.isArray(value)) return value.map(redactTokens);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [
      key,
      CREDENTIAL_FIELDS.has(key) ? '<redacted>' : redactTokens(member),
    ]),
  );
}

/**
 * Runs the collection and reports.
 *
 * @returns {Promise<void>} Resolves when the run completes; exits non-zero on any failure.
 */
async function main() {
  const flags = process.argv.slice(2);
  if (flags.includes('--check')) {
    const { default: check } = await import('node:child_process');
    const result = check.spawnSync('node', [join(HERE, 'generate-collection.mjs'), '--check'], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }

  const folderFilter = flags
    .find((flag) => flag.startsWith('--folder='))
    ?.slice('--folder='.length);
  const manageForward = !flags.includes('--no-forward');

  const collection = JSON.parse(readFileSync(COLLECTION_PATH, 'utf8'));
  const environment = JSON.parse(readFileSync(ENVIRONMENT_PATH, 'utf8'));
  const variables = new Map();
  for (const value of environment.values) variables.set(value.key, value.value);
  for (const value of collection.variable ?? []) variables.set(value.key, value.value);

  const entries = collection.item
    .filter((folder) => !folderFilter || folder.name.startsWith(folderFilter))
    .flatMap((folder) => folder.item.map((item) => ({ folder: folder.name, item })));

  const forward = manageForward ? await startPortForward() : { stop: () => {} };
  const captured = [];
  const results = [];
  let currentFolder = '';

  try {
    for (const entry of entries) {
      if (entry.folder !== currentFolder) {
        currentFolder = entry.folder;
        process.stdout.write(`\n▶ ${currentFolder}\n`);
      }
      let attempt = 0;
      let outcome;
      const started = Date.now();
      do {
        if (attempt > 0) await sleep(POLL_DELAY_MS);
        outcome = await runItem(entry, variables, captured);
        attempt += 1;
      } while (outcome.resend && attempt < MAX_RESENDS);

      if (outcome.resend) {
        outcome.failures.push(`did not settle within ${MAX_RESENDS} attempts`);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const mark = outcome.skipped ? '−' : outcome.failures.length === 0 ? '✓' : '✗';
      const detail = attempt > 1 ? ` (${attempt} attempts, ${seconds}s)` : '';
      process.stdout.write(`  ${mark} ${entry.item.name}${detail}\n`);
      for (const failure of outcome.failures) process.stdout.write(`      ${failure}\n`);
      results.push({ folder: entry.folder, name: entry.item.name, ...outcome, attempts: attempt });
    }
  } finally {
    forward.stop();
  }

  const failed = results.filter((result) => result.failures.length > 0);
  const skippedCount = results.filter((result) => result.skipped).length;
  const assertions = results.reduce((total, result) => total + result.passed.length, 0);

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        collection: collection.info.name,
        gateway: variables.get('gatewayUrl'),
        gatewayHost: variables.get('gatewayHost'),
        summary: {
          requests: results.length,
          skipped: skippedCount,
          failedRequests: failed.length,
          assertionsPassed: assertions,
        },
        exchanges: captured,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `\n${'─'.repeat(78)}\n` +
      `${results.length - failed.length - skippedCount}/${results.length - skippedCount} requests passed, ` +
      `${assertions} assertions, ${skippedCount} skipped.\n` +
      `Evidence: ${EVIDENCE_PATH}\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(
      `\nFailed:\n${failed.map((f) => `  ${f.folder} / ${f.name}`).join('\n')}\n`,
    );
    process.exit(1);
  }
}

await main();
