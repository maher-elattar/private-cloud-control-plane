/**
 * The plan gate, tested against plans this provider actually emitted.
 *
 * Every fixture under `terraform-state/fixtures` was captured with `terraform show -json` during
 * the manual walkthrough, against the real server, and redacted to structure only. That matters:
 * a gate tested against invented plan JSON proves the fixtures match the parser, whereas these
 * prove the gate refuses what bpg 0.113.1 on PVE 9.2.11 genuinely produces.
 *
 * The three replacement fixtures are not variations on a theme. They carry different
 * `action_reason` values and imply different operator responses — one is cleared by `untaint`
 * without touching the VM, one means a module bug, one is a real configuration conflict — and
 * the gate has to keep them distinguishable.
 *
 * @see docs/architecture/terraform-manual-walkthrough.md
 * @see packages/provider-adapters/src/terraform/plan-gate.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePlan, isRecoverableByUntaint, type TerraformPlan } from './plan-gate.js';

/** Where the captured plans live, relative to the repository root. */
const FIXTURE_DIRECTORY = join(process.cwd(), '..', '..', 'terraform-state', 'fixtures');

/** Loads one captured plan. */
function fixture(name: string): TerraformPlan {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, `${name}.json`), 'utf8')) as TerraformPlan;
}

/** The VM resource address every fixture uses. */
const ADDRESS = 'proxmox_virtual_environment_vm.instance';

describe('plans the gate allows', () => {
  it('allows a create', () => {
    const result = evaluatePlan(fixture('plan-create'));
    expect(result.decision).toBe('allowed');
    expect(result.actionCounts.create).toBe(1);
    expect(result.actionCounts.delete).toBe(0);
    expect(result.objections).toEqual([]);
  });

  it('allows an in-place update', () => {
    const result = evaluatePlan(fixture('plan-update'));
    expect(result.decision).toBe('allowed');
    expect(result.actionCounts.update).toBe(1);
  });

  it('allows a no-op, which is what the convergence assertion depends on', () => {
    const result = evaluatePlan(fixture('plan-noop'));
    expect(result.decision).toBe('allowed');
    expect(result.actionCounts['no-op']).toBe(1);
  });

  it('allows an empty plan', () => {
    const result = evaluatePlan({ format_version: '1.2', resource_changes: [] });
    expect(result.decision).toBe('allowed');
    expect(result.summary).toBe('No changes.');
  });
});

describe('plans the gate refuses', () => {
  it('refuses a plain delete', () => {
    const result = evaluatePlan(fixture('plan-destroy'));
    expect(result.decision).toBe('refused_destructive');
    expect(result.actionCounts.delete).toBe(1);
    expect(result.objections).toHaveLength(1);
    expect(result.objections[0]?.address).toBe(ADDRESS);
  });

  it('refuses a replacement forced by a vm_id change, and says which path forced it', () => {
    const result = evaluatePlan(fixture('plan-replace-vmid'));
    expect(result.decision).toBe('refused_destructive');
    expect(result.rule).toBe('replace_because_cannot_update');
    expect(result.actionCounts.replace).toBe(1);
    expect(result.objections[0]?.replacePaths).toEqual(['vm_id']);
  });

  it('refuses a replacement caused by a tainted resource', () => {
    const result = evaluatePlan(fixture('plan-replace-tainted'));
    expect(result.decision).toBe('refused_destructive');
    expect(result.rule).toBe('replace_because_tainted');
  });

  it('refuses the replacement an import proposes without ignore_changes on clone', () => {
    const result = evaluatePlan(fixture('plan-replace-after-import'));
    expect(result.decision).toBe('refused_destructive');
    expect(result.rule).toBe('replace_because_cannot_update');
  });

  it('counts a replacement as one replacement and as its two parts', () => {
    // A reader of the run record must be able to tell one replaced resource from one deleted and
    // one created, because those are very different situations.
    const result = evaluatePlan(fixture('plan-replace-vmid'));
    expect(result.actionCounts).toMatchObject({ delete: 1, create: 1, replace: 1 });
  });

  it('refuses a multi-resource plan where only one resource is destructive', () => {
    const result = evaluatePlan({
      format_version: '1.2',
      resource_changes: [
        { address: 'a.one', change: { actions: ['update'] } },
        { address: 'a.two', change: { actions: ['no-op'] } },
        { address: 'a.three', change: { actions: ['delete', 'create'] } },
        { address: 'a.four', change: { actions: ['create'] } },
      ],
    });
    expect(result.decision).toBe('refused_destructive');
    // Only the offending resource is named. The other three are not the problem.
    expect(result.objections).toHaveLength(1);
    expect(result.objections[0]?.address).toBe('a.three');
  });

  it('refuses both orderings of a replacement', () => {
    // `create_before_destroy` reverses the pair. Both contain a delete, which is why the gate
    // tests membership rather than matching a shape.
    for (const actions of [
      ['delete', 'create'],
      ['create', 'delete'],
    ]) {
      const result = evaluatePlan({
        resource_changes: [{ address: ADDRESS, change: { actions } }],
      });
      expect(result.decision).toBe('refused_destructive');
    }
  });
});

describe('failing closed', () => {
  it('refuses an unparseable plan', () => {
    expect(evaluatePlan(undefined).decision).toBe('refused_destructive');
    expect(evaluatePlan(undefined).rule).toBe('unparseable_plan');
  });

  it('refuses a plan Terraform marked as errored', () => {
    const result = evaluatePlan({ errored: true, resource_changes: [] });
    expect(result.decision).toBe('refused_destructive');
    expect(result.rule).toBe('errored_plan');
  });

  it('refuses an action it does not recognise', () => {
    // A future Terraform verb must not pass merely because it is not spelled `delete`.
    const result = evaluatePlan({
      resource_changes: [{ address: ADDRESS, change: { actions: ['forget'] } }],
    });
    expect(result.decision).toBe('refused_destructive');
    expect(result.rule).toBe('unrecognised_action');
  });
});

describe('the purge capability', () => {
  it('permits a delete of exactly the address the caller named', () => {
    const result = evaluatePlan(fixture('plan-destroy'), { allowDestroyOf: ADDRESS });
    expect(result.decision).toBe('allowed');
  });

  it('still refuses a delete of a different address', () => {
    const result = evaluatePlan(fixture('plan-destroy'), {
      allowDestroyOf: 'proxmox_virtual_environment_vm.something_else',
    });
    expect(result.decision).toBe('refused_destructive');
  });

  it('refuses a purge plan that would also destroy something else', () => {
    // Naming one address is not "deletes are fine now". A purge that swept up a second resource
    // is exactly the accident this narrowness exists to prevent.
    const result = evaluatePlan(
      {
        resource_changes: [
          { address: ADDRESS, change: { actions: ['delete'] } },
          {
            address: 'proxmox_virtual_environment_vm.someone_elses',
            change: { actions: ['delete'] },
          },
        ],
      },
      { allowDestroyOf: ADDRESS },
    );
    expect(result.decision).toBe('refused_destructive');
    expect(result.objections).toHaveLength(1);
    expect(result.objections[0]?.address).toBe('proxmox_virtual_environment_vm.someone_elses');
  });

  it('refuses a destroy when no capability was passed at all', () => {
    expect(evaluatePlan(fixture('plan-destroy')).decision).toBe('refused_destructive');
  });
});

describe('recovery classification', () => {
  it('reports a tainted replacement as recoverable by untaint', () => {
    expect(isRecoverableByUntaint(evaluatePlan(fixture('plan-replace-tainted')))).toBe(true);
  });

  it('does not report a vm_id conflict as recoverable', () => {
    expect(isRecoverableByUntaint(evaluatePlan(fixture('plan-replace-vmid')))).toBe(false);
  });

  it('does not report an allowed plan as recoverable', () => {
    expect(isRecoverableByUntaint(evaluatePlan(fixture('plan-create')))).toBe(false);
  });

  it('does not report a mixed refusal as recoverable', () => {
    // One tainted resource alongside a genuine conflict is not an untaint-and-retry situation.
    const result = evaluatePlan({
      resource_changes: [
        {
          address: 'a.tainted',
          action_reason: 'replace_because_tainted',
          change: { actions: ['delete', 'create'] },
        },
        {
          address: 'a.conflicted',
          action_reason: 'replace_because_cannot_update',
          change: { actions: ['delete', 'create'] },
        },
      ],
    });
    expect(isRecoverableByUntaint(result)).toBe(false);
  });
});

describe('the summary is safe to log', () => {
  it('names addresses and actions but carries no attribute values', () => {
    for (const name of ['plan-create', 'plan-update', 'plan-destroy', 'plan-replace-vmid']) {
      const { summary } = evaluatePlan(fixture(name));
      // The fixtures redact values to `<object>` / `<string>` markers; the summary must not carry
      // even those, because on a real plan they would be the cloud-init password.
      expect(summary).not.toMatch(/<object>|<string>|password/);
    }
  });
});

describe('fixture coverage', () => {
  it('references every captured fixture', () => {
    // A fixture nobody asserts against is a plan shape nobody checked. Captured plans are
    // expensive — they need real hardware — so leaving one unused wastes the only evidence there
    // is that the gate handles it.
    const captured = readdirSync(FIXTURE_DIRECTORY)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();

    const asserted = readFileSync(new URL(import.meta.url), 'utf8');
    const unused = captured.filter((name) => !asserted.includes(`'${name}'`));
    expect(unused).toEqual([]);
    expect(captured.length).toBeGreaterThanOrEqual(7);
  });
});
