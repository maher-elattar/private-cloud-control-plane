/**
 * Generates the importable Postman collection and environment from {@link FOLDERS}.
 *
 * The collection is a derived artifact, the same way `packages/contracts/src/generated` is: edit
 * `tools/postman/requests.mjs` and regenerate. Hand-editing the JSON is how a collection ends up
 * asserting something the contract no longer says.
 *
 * Generation also *checks* coverage. Every request that names an `operationId` must name one the
 * OpenAPI document actually declares, and every declared operation must appear in the collection at
 * least once. A REST operation added to the contract with no collection entry fails this check,
 * which is the only mechanism that keeps a hand-run collection honest as the API grows.
 *
 * Usage:
 *   node tools/postman/generate-collection.mjs          # write both files
 *   node tools/postman/generate-collection.mjs --check  # verify coverage and that files are current
 *
 * @see docs/operations/phase-6-api-examples.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  ABSENT_INSTANCE,
  FOREIGN_PROJECT,
  FOLDERS,
  SEEDED_PROJECT,
  allRequests,
} from './requests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const COLLECTION_PATH = join(HERE, 'private-cloud-control-plane.postman_collection.json');
const ENVIRONMENT_PATH = join(HERE, 'minikube.postman_environment.json');
const OPENAPI_PATH = join(ROOT, 'packages', 'contracts', 'openapi', 'control-plane.v1.yaml');

/** Postman's schema identifier for a v2.1 collection. */
const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
/** Stable ids so regenerating produces no diff beyond real content changes. */
const COLLECTION_ID = 'b6f1d3a2-5c9e-4e17-9a3f-2d0c6e5f1a44';
const ENVIRONMENT_ID = 'f0c2a713-9d4b-4a6e-8f21-7b5c3e9d0a18';

/** Host header the Gateway routes on. Overridable, but this is what the HTTPRoute declares. */
const GATEWAY_HOSTNAME = 'control-plane.test';

/**
 * Reads the operation ids the REST contract declares.
 *
 * @returns {Set<string>} Every `operationId` in the OpenAPI document.
 */
function declaredOperations() {
  const document = parseYaml(readFileSync(OPENAPI_PATH, 'utf8'));
  const operations = new Set();
  for (const item of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method) && operation?.operationId) {
        operations.add(operation.operationId);
      }
    }
  }
  return operations;
}

/**
 * Builds the pre-request script for one request.
 *
 * Idempotency keys are generated here rather than stored as environment values: a key reused across
 * runs would replay the previous run's stored response, and the collection would silently stop
 * exercising the path it claims to test.
 *
 * @param {object} request Request specification.
 * @returns {string[]} Script lines, empty when the request needs no preamble.
 */
function preRequestScript(request) {
  const lines = [];
  if (request.newIdempotencyKey) {
    lines.push(
      '// A fresh key per run. Reusing one would replay the stored response from a previous run',
      '// and this request would stop testing anything.',
      `pm.collectionVariables.set('${request.newIdempotencyKey}', pm.variables.replaceIn('{{$guid}}'));`,
      `pm.collectionVariables.set('idempotencyKey', pm.collectionVariables.get('${request.newIdempotencyKey}'));`,
    );
  } else if (request.idempotencyKeyFrom) {
    lines.push(
      `// Deliberately the *same* key as "${request.idempotencyKeyFrom}", to exercise the replay path.`,
      `pm.collectionVariables.set('idempotencyKey', pm.collectionVariables.get('${request.idempotencyKeyFrom}'));`,
    );
  } else if (request.idempotent) {
    lines.push(
      "pm.collectionVariables.set('idempotencyKey', pm.variables.replaceIn('{{$guid}}'));",
    );
  }
  if (request.newIdempotencyKey === 'createKey') {
    lines.push(
      '// A hostname unique to this run, so repeated runs do not collide on a name.',
      "pm.collectionVariables.set('hostname', 'postman-' + Date.now().toString(36));",
      "pm.collectionVariables.set('snapshotName', 'postman-snap-' + Date.now().toString(36));",
    );
  }
  if (request.skipWhenUnset) {
    lines.push(
      `if (!pm.collectionVariables.get('${request.skipWhenUnset}')) {`,
      `  // Nothing to act on. Skipping is the correct outcome, not a silent pass.`,
      `  pm.execution.skipRequest();`,
      '}',
    );
  }
  return lines;
}

/**
 * Builds the test script for one request.
 *
 * @param {object} request Request specification.
 * @returns {string[]} Script lines.
 */
function testScript(request) {
  const lines = [];
  const statuses = Array.isArray(request.expect.status)
    ? request.expect.status
    : [request.expect.status];

  if (request.pollUntil) {
    const { jsonPath, anyOf, attempts, delayMs } = request.pollUntil;
    lines.push(
      `// Re-sends itself until '${jsonPath}' settles, up to ${attempts} attempts.`,
      "const attempt = Number(pm.collectionVariables.get('pollAttempt') || 0) + 1;",
      '// An error response will never settle, so it ends the poll immediately. Without this a',
      '// mistyped id polls a 400 until the attempt cap, and a two-second bug takes four minutes',
      '// to report itself.',
      'const readable = pm.response.code >= 200 && pm.response.code < 300;',
      `const settled = readable && ${JSON.stringify(anyOf)}.includes(pm.response.json().${jsonPath});`,
      `if (readable && !settled && attempt < ${attempts}) {`,
      "  pm.collectionVariables.set('pollAttempt', attempt);",
      `  setTimeout(() => {}, ${delayMs});`,
      '  postman.setNextRequest(pm.info.requestName);',
      '} else {',
      "  pm.collectionVariables.set('pollAttempt', 0);",
      `  pm.test('settles within ${attempts} attempts', () => pm.expect(settled).to.eql(true));`,
      '}',
      'if (settled) {',
    );
  }

  const indent = request.pollUntil ? '  ' : '';
  lines.push(
    `${indent}pm.test('responds ${statuses.join(' or ')}', () => pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(statuses)}));`,
  );
  for (const capture of request.capture ?? []) lines.push(`${indent}${capture}`);
  if (request.pollUntil) lines.push('}');
  return lines;
}

/**
 * Builds one Postman item.
 *
 * @param {object} request Request specification.
 * @returns {object} Postman collection item.
 */
function item(request) {
  const headers = [];
  if (request.auth === 'tenant')
    headers.push({ key: 'Authorization', value: 'Bearer {{tenantToken}}' });
  if (request.auth === 'admin')
    headers.push({ key: 'Authorization', value: 'Bearer {{adminToken}}' });
  if (request.auth === 'foreign')
    headers.push({ key: 'Authorization', value: 'Bearer {{foreignToken}}' });
  if (request.throughGateway !== false) headers.push({ key: 'Host', value: '{{gatewayHost}}' });
  if (request.idempotent || request.newIdempotencyKey || request.idempotencyKeyFrom) {
    headers.push({ key: 'Idempotency-Key', value: '{{idempotencyKey}}' });
  }
  if (request.correlated) headers.push({ key: 'X-Correlation-Id', value: '{{$guid}}' });
  if (request.body) headers.push({ key: 'Content-Type', value: 'application/json' });
  for (const [key, value] of Object.entries(request.headers ?? {})) headers.push({ key, value });

  const events = [];
  const preRequest = preRequestScript(request);
  if (preRequest.length > 0) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: preRequest } });
  }
  events.push({ listen: 'test', script: { type: 'text/javascript', exec: testScript(request) } });

  return {
    name: request.name,
    event: events,
    request: {
      method: request.method,
      header: headers,
      ...(request.body
        ? {
            body: {
              mode: 'raw',
              raw: JSON.stringify(request.body, null, 2),
              options: { raw: { language: 'json' } },
            },
          }
        : {}),
      url: request.url,
      description: request.description ?? '',
    },
    response: [],
  };
}

/**
 * Assembles the collection document.
 *
 * @returns {object} Postman v2.1 collection.
 */
function collection() {
  return {
    info: {
      _postman_id: COLLECTION_ID,
      name: 'Private Cloud Control Plane — Phase 6 (minikube)',
      description:
        'Exercises the control plane running on the minikube cluster, through the Gateway, in ' +
        'lifecycle order.\n\n' +
        '**Run the `00 Identity` folder first.** It mints the bearer tokens every other request ' +
        'carries, from the in-cluster OIDC fixture reached over a port-forward:\n\n' +
        '```bash\nkubectl port-forward -n private-cloud svc/local-oidc 18085:18080\n```\n\n' +
        'Then run the whole collection top to bottom. Requests that expect a refusal — a 403 for ' +
        'a foreign project, a 409 for a purge inside the retention window — assert the refusal: ' +
        'those are safety rules, and a run in which they stopped failing would be a regression.\n\n' +
        'Generated from `tools/postman/requests.mjs`; do not hand-edit. Regenerate with ' +
        '`node tools/postman/generate-collection.mjs`.',
      schema: SCHEMA,
    },
    item: FOLDERS.map((folder) => ({
      name: folder.name,
      description: folder.description,
      item: folder.requests.map((request) =>
        item({
          ...request,
          expect:
            request.expect ?? (folder.expectUnimplemented ? { status: 404 } : { status: 200 }),
        }),
      ),
    })),
    variable: [
      { key: 'idempotencyKey', value: '' },
      { key: 'tenantToken', value: '' },
      { key: 'adminToken', value: '' },
      { key: 'foreignToken', value: '' },
      { key: 'instanceId', value: '' },
      { key: 'operationId', value: '' },
      { key: 'snapshotId', value: '' },
      { key: 'statusUrl', value: '' },
      { key: 'deadLetterEventId', value: '' },
      { key: 'createKey', value: '' },
      { key: 'hostname', value: 'postman-demo-01' },
      { key: 'snapshotName', value: 'postman-snap-01' },
      { key: 'pollAttempt', value: '0' },
    ],
  };
}

/**
 * Assembles the environment document.
 *
 * @returns {object} Postman environment.
 */
function environment() {
  const values = [
    {
      key: 'gatewayUrl',
      value: 'http://192.168.49.2:30000',
      description:
        'minikube IP and the Traefik NodePort for the Gateway `web` listener. Confirm with `minikube ip` and `kubectl get svc -n traefik traefik`.',
    },
    {
      key: 'gatewayHost',
      value: GATEWAY_HOSTNAME,
      description:
        'The hostname the HTTPRoute matches. Sent as the Host header so no /etc/hosts entry is needed.',
    },
    {
      key: 'oidcUrl',
      value: 'http://127.0.0.1:18085',
      description:
        'Local end of `kubectl port-forward -n private-cloud svc/local-oidc 18085:18080`. Port 18080 is deliberately avoided: the Phase 4 Compose stack binds it, and a token from that issuer is rejected by the cluster.',
    },
    {
      key: 'projectId',
      value: SEEDED_PROJECT,
      description: 'Seeded by db/seeds/0001_phase3_fake.sql.',
    },
    {
      key: 'foreignProjectId',
      value: FOREIGN_PROJECT,
      description: 'A project the tokens are not members of, used to prove the 403.',
    },
    {
      key: 'absentInstanceId',
      value: ABSENT_INSTANCE,
      description: 'An instance that does not exist, used to prove the 404.',
    },
    { key: 'imageId', value: 'ubuntu-24-04-cloud' },
    { key: 'flavorId', value: 'lab-small' },
    {
      key: 'flavorIdLarger',
      value: 'lab-medium',
      description:
        'The resize target. Larger in every dimension, so one resize covers compute and disk growth.',
    },
    { key: 'networkId', value: 'lab-primary' },
    {
      key: 'sshPublicKey',
      value:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForDocumentationOnly000000000000 lab@example.invalid',
      description:
        'A syntactically valid, non-functional key. Real key material must not be committed.',
    },
  ];
  return {
    id: ENVIRONMENT_ID,
    name: 'Phase 6 — minikube',
    values: values.map((value) => ({ ...value, type: 'default', enabled: true })),
    _postman_variable_scope: 'environment',
  };
}

/**
 * Verifies collection coverage against the REST contract.
 *
 * @returns {string[]} Human-readable problems; empty when coverage is complete.
 */
function coverageProblems() {
  const declared = declaredOperations();
  const covered = new Set(
    allRequests()
      .map((request) => request.operationId)
      .filter(Boolean),
  );
  const problems = [];
  for (const operation of covered) {
    if (!declared.has(operation)) {
      problems.push(
        `Collection references '${operation}', which the OpenAPI document does not declare.`,
      );
    }
  }
  for (const operation of declared) {
    if (!covered.has(operation)) {
      problems.push(`OpenAPI declares '${operation}', which no collection request exercises.`);
    }
  }
  return problems;
}

const checkOnly = process.argv.slice(2).includes('--check');
const problems = coverageProblems();
if (problems.length > 0) {
  process.stderr.write(
    `Postman collection coverage is incomplete:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
  );
  process.exit(1);
}

const collectionJson = `${JSON.stringify(collection(), null, 2)}\n`;
const environmentJson = `${JSON.stringify(environment(), null, 2)}\n`;

if (checkOnly) {
  const stale = [];
  for (const [path, expected] of [
    [COLLECTION_PATH, collectionJson],
    [ENVIRONMENT_PATH, environmentJson],
  ]) {
    let actual;
    try {
      actual = readFileSync(path, 'utf8');
    } catch {
      stale.push(`${path} does not exist.`);
      continue;
    }
    if (actual !== expected) stale.push(`${path} is out of date.`);
  }
  if (stale.length > 0) {
    process.stderr.write(`${stale.join('\n')}\nRun: node tools/postman/generate-collection.mjs\n`);
    process.exit(1);
  }
  const requests = allRequests().length;
  process.stdout.write(
    `Postman collection is current: ${requests} requests across ${FOLDERS.length} folders, ` +
      `covering all ${declaredOperations().size} declared REST operations.\n`,
  );
} else {
  writeFileSync(COLLECTION_PATH, collectionJson);
  writeFileSync(ENVIRONMENT_PATH, environmentJson);
  process.stdout.write(
    `Wrote ${COLLECTION_PATH}\nWrote ${ENVIRONMENT_PATH}\n` +
      `${allRequests().length} requests across ${FOLDERS.length} folders, ` +
      `covering all ${declaredOperations().size} declared REST operations.\n`,
  );
}
