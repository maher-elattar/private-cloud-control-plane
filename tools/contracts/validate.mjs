import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Parser, fromFile } from '@asyncapi/parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const errors = [];
const requirementIds = new Set(
  (await readFile('docs/product/srs.md', 'utf8')).match(/SRS-(?:FR|NFR|ARC)-\d{3}/g) ?? [],
);

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

function invariant(condition, message) {
  if (!condition) errors.push(message);
}

function validateRequirements(owner, requirements) {
  for (const requirement of requirements ?? []) {
    invariant(
      requirementIds.has(requirement),
      `${owner} references unknown requirement '${requirement}'.`,
    );
  }
}

run('node_modules/.bin/redocly', ['lint', 'control-plane@v1']);
run('node_modules/.bin/buf', ['lint']);

const parser = new Parser();
const asyncResult = await fromFile(
  parser,
  'packages/contracts/asyncapi/control-plane.v1.yaml',
).parse();
const asyncErrors = asyncResult.diagnostics.filter((diagnostic) => diagnostic.severity === 0);
invariant(Boolean(asyncResult.document), 'AsyncAPI document did not parse.');
for (const diagnostic of asyncErrors) {
  errors.push(`AsyncAPI: ${diagnostic.message}`);
}

const openApi = parseYaml(
  await readFile('packages/contracts/openapi/control-plane.v1.yaml', 'utf8'),
);
let operationCount = 0;
for (const [path, pathItem] of Object.entries(openApi.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(method)) continue;
    operationCount += 1;
    const isHealth = path.startsWith('/health/');
    const responses = Object.keys(operation.responses ?? {});
    const hasClientError = responses.some((status) => /^4\d\d$/.test(status));
    const effectiveSecurity = operation.security ?? openApi.security;

    invariant(
      Boolean(operation.operationId),
      `${method.toUpperCase()} ${path} has no operationId.`,
    );
    invariant(
      Array.isArray(operation['x-requirements']),
      `${operation.operationId} has no requirement links.`,
    );
    invariant(
      operation['x-requirements']?.length > 0,
      `${operation.operationId} has an empty requirement list.`,
    );
    validateRequirements(operation.operationId, operation['x-requirements']);
    invariant(
      isHealth || effectiveSecurity?.length > 0,
      `${operation.operationId} has no effective security policy.`,
    );
    invariant(
      isHealth || hasClientError,
      `${operation.operationId} has no documented 4xx response.`,
    );

    if (MUTATION_METHODS.has(method)) {
      invariant(
        operation['x-idempotency'] === 'required',
        `${operation.operationId} must require idempotency.`,
      );
      if (operation.requestBody) {
        invariant(
          operation['x-max-body-bytes'] === 65_536,
          `${operation.operationId} must bound its body to 65,536 bytes.`,
        );
      }
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
      invariant(
        parameters.some((parameter) => parameter.$ref?.endsWith('/IdempotencyKey')),
        `${operation.operationId} does not declare the Idempotency-Key header.`,
      );
    } else {
      invariant(
        operation['x-idempotency'] === 'read-only',
        `${operation.operationId} must be marked read-only.`,
      );
    }
  }
}
invariant(operationCount === 39, `Expected 39 REST operations; found ${operationCount}.`);

const createSchemaText = JSON.stringify(
  parseYaml(await readFile('packages/contracts/openapi/components.v1.yaml', 'utf8')).components
    .schemas.CreateInstanceRequest,
);
for (const prohibitedField of ['node', 'storage', 'bridge', 'vmid', 'credential', 'endpoint']) {
  invariant(
    !createSchemaText.includes(`\"${prohibitedField}\"`),
    `Tenant create contract leaks provider field '${prohibitedField}'.`,
  );
}

const eventSchema = JSON.parse(
  await readFile('packages/contracts/asyncapi/schemas/control-plane-events.v1.schema.json', 'utf8'),
);
// Composed allOf event schemas establish object type through the envelope branch.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormats(ajv);
for (const keyword of [
  'x-classification',
  'x-compatibility',
  'x-max-payload-bytes',
  'x-telemetry',
]) {
  ajv.addKeyword({ keyword });
}
const validateEvent = ajv.compile(eventSchema);
const validEvent = JSON.parse(
  await readFile('packages/contracts/fixtures/events/instance-create-requested.valid.json', 'utf8'),
);
const invalidEvent = JSON.parse(
  await readFile('packages/contracts/fixtures/events/missing-identity.invalid.json', 'utf8'),
);
invariant(
  validateEvent(validEvent),
  `Valid event fixture failed: ${ajv.errorsText(validateEvent.errors)}`,
);
invariant(!validateEvent(invalidEvent), 'Invalid event fixture unexpectedly passed.');
invariant(
  Buffer.byteLength(JSON.stringify(validEvent)) <= 262_144,
  'Valid event exceeds the 262,144-byte event limit.',
);

const asyncApi = parseYaml(
  await readFile('packages/contracts/asyncapi/control-plane.v1.yaml', 'utf8'),
);
invariant(
  asyncApi['x-max-payload-bytes'] === 262_144,
  'AsyncAPI payload limit is not 262,144 bytes.',
);
for (const channel of Object.values(asyncApi.channels)) {
  invariant(
    channel.address.endsWith('.v1'),
    `Kafka topic '${channel.address}' lacks a major version.`,
  );
  invariant(
    channel['x-partition-key'] === 'partitionKey',
    `Kafka topic '${channel.address}' lacks the partition key contract.`,
  );
}
for (const [messageName, message] of Object.entries(asyncApi.components.messages)) {
  invariant(message['x-requirements']?.length > 0, `${messageName} has an empty requirement list.`);
  validateRequirements(messageName, message['x-requirements']);
}

const rpcPolicies = JSON.parse(
  await readFile('packages/contracts/proto/rpc-policies.v1.json', 'utf8'),
);
const protoSources = await Promise.all([
  readFile('packages/contracts/proto/privatecloud/controlplane/v1/control_plane.proto', 'utf8'),
  readFile('packages/contracts/proto/privatecloud/provider/v1/provider.proto', 'utf8'),
]);
const classifiedMethods = new Set(
  rpcPolicies.rules.flatMap((rule) => rule.methods.map((method) => `${rule.service}/${method}`)),
);
for (const rule of rpcPolicies.rules) {
  validateRequirements(`${rule.service} RPC policy`, rule.requirements);
}
let rpcCount = 0;
for (const source of protoSources) {
  let currentService;
  for (const line of source.split('\n')) {
    const serviceMatch = line.match(/^service\s+(\w+)/);
    const packageMatch = source.match(/^package\s+([\w.]+);/m);
    if (serviceMatch && packageMatch) currentService = `${packageMatch[1]}.${serviceMatch[1]}`;
    const rpcMatch = line.match(/^\s+rpc\s+(\w+)/);
    if (rpcMatch && currentService) {
      rpcCount += 1;
      invariant(
        classifiedMethods.has(`${currentService}/${rpcMatch[1]}`),
        `${currentService}/${rpcMatch[1]} has no RPC policy.`,
      );
    }
  }
}
invariant(rpcCount === 54, `Expected 54 gRPC methods; found ${rpcCount}.`);
invariant(
  classifiedMethods.size === rpcCount,
  'RPC policy contains missing or duplicate method classifications.',
);

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${operationCount} REST operations, ${rpcCount} gRPC methods, ${Object.keys(asyncApi.components.messages).length} event messages, and contract invariants.`,
  );
}
