import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import openapiTS, { astToString } from 'openapi-typescript';

const generatedDirectory = 'packages/contracts/src/generated';

await mkdir(generatedDirectory, { recursive: true });

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

run('node_modules/.bin/redocly', [
  'bundle',
  'control-plane@v1',
  '--output',
  `${generatedDirectory}/openapi.v1.json`,
]);
const openApiDocument = JSON.parse(await readFile(`${generatedDirectory}/openapi.v1.json`, 'utf8'));
const openApiTypes = await openapiTS(openApiDocument, {
  alphabetize: true,
  immutable: true,
});
await writeFile(`${generatedDirectory}/openapi.ts`, `${astToString(openApiTypes)}\n`, 'utf8');
run('node_modules/.bin/buf', ['generate']);
run('node_modules/.bin/json2ts', [
  '--input',
  'packages/contracts/asyncapi/schemas/control-plane-events.v1.schema.json',
  '--output',
  `${generatedDirectory}/events.ts`,
  '--no-additionalProperties',
  '--no-enableConstEnums',
]);
run('node_modules/.bin/prettier', [
  '--write',
  `${generatedDirectory}/openapi.v1.json`,
  `${generatedDirectory}/openapi.ts`,
  `${generatedDirectory}/events.ts`,
  `${generatedDirectory}/proto/google/protobuf/field_mask.pb.ts`,
  `${generatedDirectory}/proto/google/protobuf/timestamp.pb.ts`,
  `${generatedDirectory}/proto/privatecloud/common/v1/common.pb.ts`,
  `${generatedDirectory}/proto/privatecloud/controlplane/v1/control_plane.pb.ts`,
  `${generatedDirectory}/proto/privatecloud/provider/v1/provider.pb.ts`,
]);

console.log('Generated OpenAPI, protobuf, and event TypeScript contracts.');
