/**
 * Redacts a `terraform show -json` plan capture so it can be committed as a gate fixture.
 *
 * WHY this exists: `terraform show -json` includes sensitive values in `before`/`after` in
 * cleartext, marking them only in the parallel `before_sensitive`/`after_sensitive` trees. The
 * cloud-init password is therefore in every raw capture. The plan gate only ever reads
 * `resource_changes[].change.actions` and `action_reason`, so the fixtures keep the structure and
 * discard the attribute values entirely.
 *
 * Usage: node capture-fixture.mjs runs/plan-create.json fixtures/plan-create.json
 */
import { readFile, writeFile } from 'node:fs/promises';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('usage: capture-fixture.mjs <source> <destination>');

const plan = JSON.parse(await readFile(source, 'utf8'));

/** Replaces every leaf value with a type marker, keeping only the shape. */
function shapeOnly(value) {
  if (Array.isArray(value)) return value.map(shapeOnly);
  if (value === null) return null;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, shapeOnly(member)]),
    );
  }
  return `<${typeof value}>`;
}

const fixture = {
  format_version: plan.format_version,
  terraform_version: plan.terraform_version,
  errored: plan.errored ?? false,
  resource_changes: (plan.resource_changes ?? []).map((entry) => ({
    address: entry.address,
    mode: entry.mode,
    type: entry.type,
    name: entry.name,
    provider_name: entry.provider_name,
    ...(entry.action_reason ? { action_reason: entry.action_reason } : {}),
    change: {
      actions: entry.change.actions,
      // Values are discarded; only the presence of before/after is structurally meaningful.
      before: entry.change.before === null ? null : '<object>',
      after: entry.change.after === null ? null : '<object>',
      ...(entry.change.replace_paths ? { replace_paths: entry.change.replace_paths } : {}),
    },
  })),
};

await writeFile(destination, `${JSON.stringify(fixture, undefined, 2)}\n`);
console.log(
  `${destination}: ${fixture.resource_changes.length} change(s) — ` +
    fixture.resource_changes
      .map((c) => `${c.change.actions.join('+')}${c.action_reason ? ` (${c.action_reason})` : ''}`)
      .join(', '),
);
