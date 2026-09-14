/**
 * Asserts the purge module differs from the instance module only where it is allowed to.
 *
 * PATTERN — mechanically paid-down duplication. `prevent_destroy` is a `lifecycle` meta-argument
 * and takes literals only, so "destroy is permitted in the purge path" cannot be a variable. The
 * alternative to two modules would be one module with no provider-level protection at all,
 * relying entirely on the plan gate — so the duplication buys a real layer, and this check is
 * what stops it rotting.
 *
 * The resources must stay identical because a purge is a destroy of *the instance the ordinary
 * module built*. If the two drifted, the purge plan would compare the live VM against a different
 * desired state and could propose changes before destroying it — which is the one moment nothing
 * should be proposing changes.
 *
 * Usage: node tools/terraform/check-modules.mjs
 *
 * @see deploy/terraform/modules/instance/main.tf
 * @see deploy/terraform/modules/instance-purge/main.tf
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const INSTANCE = resolve('deploy/terraform/modules/instance');
const PURGE = resolve('deploy/terraform/modules/instance-purge');

/** Files that must be byte-identical between the two modules. */
const IDENTICAL_FILES = ['variables.tf', 'outputs.tf', 'versions.tf'];

/** The file allowed to differ, and only in the two places named below. */
const DIVERGENT_FILE = 'main.tf';

const failures = [];

// --- Files that must match exactly ---
for (const name of IDENTICAL_FILES) {
  const [instance, purge] = await Promise.all([
    readFile(resolve(INSTANCE, name), 'utf8'),
    readFile(resolve(PURGE, name), 'utf8'),
  ]);
  if (instance === purge) {
    process.stdout.write(`  identical  ${name}\n`);
  } else {
    failures.push(`${name} differs between the modules and must not.`);
    process.stdout.write(`  DIFFERS    ${name}\n`);
  }
}

// --- main.tf, compared with the header and the lifecycle block removed ---

/**
 * Strips the leading docblock and the `lifecycle` block, leaving the resource body.
 *
 * The lifecycle block is located by brace depth rather than by regex, because a nested list
 * containing `]` and a comment containing `}` both defeat a pattern match, and a check that can
 * be defeated by a comment is not a check.
 */
function comparableBody(source) {
  const withoutHeader = source.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');
  const lines = withoutHeader.split('\n');
  const kept = [];
  let depth = null;
  for (const line of lines) {
    if (depth === null && /^\s*lifecycle\s*\{/.test(line)) {
      depth = 1;
      continue;
    }
    if (depth !== null) {
      for (const character of line) {
        if (character === '{') depth += 1;
        if (character === '}') depth -= 1;
      }
      if (depth <= 0) depth = null;
      continue;
    }
    kept.push(line);
  }
  // Collapse blank runs, so removing a block does not register as a whitespace difference.
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const [instanceMain, purgeMain] = await Promise.all([
  readFile(resolve(INSTANCE, DIVERGENT_FILE), 'utf8'),
  readFile(resolve(PURGE, DIVERGENT_FILE), 'utf8'),
]);

const instanceBody = comparableBody(instanceMain);
const purgeBody = comparableBody(purgeMain);

if (instanceBody === purgeBody) {
  process.stdout.write(`  identical  ${DIVERGENT_FILE} outside its header and lifecycle block\n`);
} else {
  failures.push(
    `${DIVERGENT_FILE} differs outside its header and lifecycle block. Only those two may diverge.`,
  );
  process.stdout.write(`  DIFFERS    ${DIVERGENT_FILE} outside its header and lifecycle block\n`);
  // Name the first differing line, because a whole-file diff of two near-identical files is
  // unreadable and the divergence is almost always one line.
  const left = instanceBody.split('\n');
  const right = purgeBody.split('\n');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      process.stdout.write(`             first difference at line ${index + 1}:\n`);
      process.stdout.write(`               instance: ${left[index] ?? '(absent)'}\n`);
      process.stdout.write(`               purge   : ${right[index] ?? '(absent)'}\n`);
      break;
    }
  }
}

// --- And the difference that must exist ---

if (/^\s*prevent_destroy\s*=\s*true/m.test(instanceMain)) {
  process.stdout.write('  present    prevent_destroy in the instance module\n');
} else {
  failures.push('The instance module has lost prevent_destroy.');
  process.stdout.write('  MISSING    prevent_destroy in the instance module\n');
}

// Match the assignment, not the word. The purge module's lifecycle block *mentions*
// `prevent_destroy` in a comment explaining its absence, and a check defeated by an explanatory
// comment is worse than no check: it fails for a reason that has nothing to do with safety, and
// the fix is to delete the explanation.
if (/^\s*prevent_destroy\s*=/m.test(purgeMain)) {
  failures.push('The purge module declares prevent_destroy, which would make purge impossible.');
  process.stdout.write('  UNEXPECTED prevent_destroy assigned in the purge module\n');
} else {
  process.stdout.write(
    '  absent     prevent_destroy assignment in the purge module, as intended\n',
  );
}

// Both must ignore the clone block, or orphan recovery plans a replacement.
for (const [label, source] of [
  ['instance', instanceMain],
  ['purge', purgeMain],
]) {
  if (/ignore_changes\s*=\s*\[[\s\S]*?\bclone,/.test(source)) {
    process.stdout.write(`  present    ignore_changes on clone in the ${label} module\n`);
  } else {
    failures.push(`The ${label} module does not ignore the clone block; import would replace.`);
    process.stdout.write(`  MISSING    ignore_changes on clone in the ${label} module\n`);
  }
}

process.stdout.write(
  `\n${failures.length === 0 ? 'modules agree' : `${failures.length} problem(s)`}\n`,
);
for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
if (failures.length > 0) process.exitCode = 1;
