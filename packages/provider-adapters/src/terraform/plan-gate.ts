/**
 * Refuses any Terraform plan that would destroy a provider resource.
 *
 * PATTERN — the primary destructive-path control. Terraform's whole model is convergence to a
 * declared state, and its ordinary vocabulary for "this attribute cannot change in place" is
 * *destroy and recreate*. That is precisely what this codebase forbids: no failure branch may
 * automatically stop, delete, or purge a VM, and ambiguous outcomes go to `manual_review`.
 *
 * Three layers stand between a workflow and a destroyed instance. The module sets no ForceNew
 * attribute, so a replacement is not normally proposed at all. `prevent_destroy` on the resource
 * makes the provider itself refuse one. This function is the third and the only one that cannot
 * be bypassed by a configuration mistake — it reads what Terraform actually planned, not what the
 * configuration intended.
 *
 * WHY it is a pure function over parsed JSON: this is the code that decides whether a real VM
 * lives, and it must be testable exhaustively without a server. Its fixtures are real plans
 * captured from real hardware during the manual walkthrough, so a passing test proves the gate
 * refuses what this provider actually emits rather than what we imagined it would.
 *
 * @see docs/architecture/terraform-manual-walkthrough.md
 * @see terraform-state/fixtures
 * @see docs/architecture/safety-invariants.md
 */

/**
 * Actions a plan may propose for one resource.
 *
 * Terraform's JSON plan representation spells a replacement as two actions in one array, in
 * either order depending on whether `create_before_destroy` is set. Both orderings contain
 * `delete`, which is why this gate tests for membership rather than matching a shape.
 */
export type PlanAction = 'no-op' | 'create' | 'read' | 'update' | 'delete';

/** The actions this gate permits. Everything else, including any `delete`, is refused. */
const PERMITTED_ACTIONS: readonly PlanAction[] = ['no-op', 'create', 'read', 'update'];

/**
 * The action that is never permitted outside the purge path.
 *
 * Named rather than inlined because it is the single most important literal in this file.
 */
const DESTRUCTIVE_ACTION: PlanAction = 'delete';

/** One resource change, as the JSON plan representation describes it. */
export interface PlanResourceChange {
  readonly address?: string;
  readonly type?: string;
  readonly name?: string;
  readonly action_reason?: string;
  readonly change?: {
    readonly actions?: readonly string[];
    readonly replace_paths?: readonly (readonly (string | number)[])[];
  };
}

/** The subset of `terraform show -json` this gate reads. */
export interface TerraformPlan {
  readonly format_version?: string;
  readonly terraform_version?: string;
  readonly errored?: boolean;
  readonly resource_changes?: readonly PlanResourceChange[];
}

/** Why the gate refused, or that it did not. */
export type GateDecision = 'allowed' | 'refused_destructive';

/** One resource the gate objected to. */
export interface GateObjection {
  /** Resource address, or `unknown` when the plan omitted one. */
  readonly address: string;
  /** The actions proposed for it. */
  readonly actions: readonly string[];
  /**
   * Terraform's own explanation, when it gave one.
   *
   * This is the field that distinguishes a recoverable refusal from a real conflict.
   * `replace_because_tainted` means a previous apply failed partway and the resource can be
   * un-tainted without touching the VM. `replace_because_cannot_update` means the configuration
   * and the live resource genuinely disagree on an immutable attribute.
   */
  readonly actionReason?: string;
  /** Attribute paths Terraform named as forcing the replacement, when it named any. */
  readonly replacePaths?: readonly string[];
}

/** What the gate decided, and everything a run record or an operator needs to know why. */
export interface GateResult {
  readonly decision: GateDecision;
  /** The rule that refused, for `terraform.runs.gate_rule`. Absent when allowed. */
  readonly rule?: string;
  /** Aggregate action counts, for `terraform.runs.plan_actions`. */
  readonly actionCounts: Readonly<Record<string, number>>;
  /** Resources the gate objected to. Empty when allowed. */
  readonly objections: readonly GateObjection[];
  /** Human-readable summary, safe to log: it names addresses and actions, never attribute values. */
  readonly summary: string;
}

/** Options that widen what the gate permits. */
export interface GateOptions {
  /**
   * Permits a delete of exactly one resource, at exactly one address.
   *
   * The purge path is the only authorized destructive operation in the system, and it is not
   * enough to say "deletes are fine now": the caller must name the address it intends to destroy,
   * so a plan that would also delete something else is still refused. Purge additionally passes
   * through `verifying_purge`, which proves live provider ownership before the call (SAFE-006).
   */
  readonly allowDestroyOf?: string;
}

/**
 * Every key the action tally reports, always present so a reader never has to distinguish
 * "zero" from "this plan format did not mention it".
 */
const COUNTED_ACTIONS = ['no-op', 'create', 'read', 'update', 'delete', 'replace'] as const;

/** Tallies actions across every resource change, for the run record. */
function countActions(changes: readonly PlanResourceChange[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    COUNTED_ACTIONS.map((action) => [action, 0]),
  );
  for (const change of changes) {
    const actions = change.change?.actions ?? [];
    // A replacement is two actions in one array; count it as one replacement *and* as its parts,
    // so a reader can tell `{delete: 1, create: 1, replace: 1}` from two separate resources.
    if (actions.includes('delete') && actions.includes('create')) {
      counts.replace = (counts.replace ?? 0) + 1;
    }
    for (const action of actions) {
      counts[action] = (counts[action] ?? 0) + 1;
    }
  }
  return counts;
}

/** Renders a replace path array as a dotted string, for logs and run records. */
function renderPath(path: readonly (string | number)[]): string {
  return path.map((segment) => String(segment)).join('.');
}

/**
 * Decides whether a plan may be applied.
 *
 * Fails closed in every ambiguous case: a plan that could not be parsed, one Terraform marked as
 * errored, and one carrying an action this gate does not recognise are all refused. A gate that
 * guesses is not a gate.
 *
 * @param plan Parsed `terraform show -json` output, or `undefined` when parsing failed.
 * @param options Purge capability, when the caller is the purge path.
 * @returns The decision, with counts and objections for the run record.
 */
export function evaluatePlan(
  plan: TerraformPlan | undefined,
  options: GateOptions = {},
): GateResult {
  if (!plan || typeof plan !== 'object') {
    return {
      decision: 'refused_destructive',
      rule: 'unparseable_plan',
      actionCounts: {},
      objections: [],
      summary: 'The plan could not be read. Refusing, because a gate that guesses is not a gate.',
    };
  }

  if (plan.errored === true) {
    return {
      decision: 'refused_destructive',
      rule: 'errored_plan',
      actionCounts: {},
      objections: [],
      summary: 'Terraform marked this plan as errored. Nothing is applied from an errored plan.',
    };
  }

  const changes = plan.resource_changes ?? [];
  const actionCounts = countActions(changes);

  const objections: GateObjection[] = [];
  let rule: string | undefined;

  for (const change of changes) {
    const address = change.address ?? 'unknown';
    const actions = change.change?.actions ?? [];

    // An unrecognised action is refused rather than ignored. A future Terraform verb this code
    // has never seen must not pass because it happens not to be spelled `delete`.
    const unrecognised = actions.filter(
      (action) =>
        !PERMITTED_ACTIONS.includes(action as PlanAction) && action !== DESTRUCTIVE_ACTION,
    );
    if (unrecognised.length > 0) {
      rule ??= 'unrecognised_action';
      objections.push({ address, actions });
      continue;
    }

    if (!actions.includes(DESTRUCTIVE_ACTION)) continue;

    // The purge path may destroy the one resource it named, and nothing else.
    if (options.allowDestroyOf !== undefined && address === options.allowDestroyOf) continue;

    rule ??= change.action_reason ?? 'delete_not_permitted';
    objections.push({
      address,
      actions,
      ...(change.action_reason ? { actionReason: change.action_reason } : {}),
      ...(change.change?.replace_paths
        ? { replacePaths: change.change.replace_paths.map(renderPath) }
        : {}),
    });
  }

  if (objections.length === 0) {
    const described = Object.entries(actionCounts)
      .filter(([, count]) => count > 0)
      .map(([action, count]) => `${action}=${count}`)
      .join(' ');
    return {
      decision: 'allowed',
      actionCounts,
      objections: [],
      summary: changes.length === 0 ? 'No changes.' : `Allowed: ${described || 'no-op'}.`,
    };
  }

  const detail = objections
    .map((objection) => {
      const reason = objection.actionReason ? ` (${objection.actionReason})` : '';
      const paths = objection.replacePaths?.length
        ? ` forced by ${objection.replacePaths.join(', ')}`
        : '';
      return `${objection.address}: ${objection.actions.join('+')}${reason}${paths}`;
    })
    .join('; ');

  return {
    decision: 'refused_destructive',
    ...(rule ? { rule } : {}),
    actionCounts,
    objections,
    summary: `Refused, this plan would destroy a provider resource. ${detail}`,
  };
}

/**
 * Whether a refusal can be cleared without destroying anything.
 *
 * `replace_because_tainted` means a previous apply failed partway; `terraform untaint` clears the
 * marking without touching the VM, and the following apply converges in place. Every other
 * refusal reason is a genuine disagreement that needs a decision, not a retry.
 *
 * Measured rather than inferred — the tainted case is how the first real apply in the manual
 * walkthrough failed, and untainting is what recovered it.
 *
 * @param result A gate result.
 * @returns `true` when untaint-then-converge is the correct recovery.
 */
export function isRecoverableByUntaint(result: GateResult): boolean {
  return (
    result.decision === 'refused_destructive' &&
    result.objections.length > 0 &&
    result.objections.every((objection) => objection.actionReason === 'replace_because_tainted')
  );
}
