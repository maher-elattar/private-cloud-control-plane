/**
 * Routes a claimed workflow to the capability that knows how to execute it.
 *
 * PATTERN — Strategy lookup keyed by a persisted discriminator. Before Phase 5 the orchestrator
 * constructed exactly one `CreateInstanceWorkflow` and called it for whatever it claimed, which
 * was safe only because create was the sole capability. With nine, the claim has to reach the
 * right executor, and reaching the wrong one would mean running one capability's provider calls
 * against a workflow that asked for another.
 *
 * The registry deliberately does not claim on behalf of its members. Each executor claims for
 * itself and refuses a workflow whose action is not its own, so a routing mistake fails loudly at
 * the boundary rather than part-way through a provider interaction.
 *
 * @see docs/architecture/glossary.md#persisted-saga-workflow-state-machine
 */
import type { WorkflowAction } from './workflow-stage.js';

/** One capability's executor, as the registry sees it. */
export interface WorkflowExecutor {
  /** The capability this executor implements. */
  readonly action: WorkflowAction;
  /**
   * Claims one workflow of this executor's action and performs exactly one transition.
   *
   * @returns `true` when a workflow was claimed and advanced, `false` when none was ready.
   */
  runOne(leaseSeconds?: number): Promise<boolean>;
}

/**
 * Holds one executor per capability and offers them a turn in a fair rotation.
 *
 * WHY rotate rather than always start from the first: a capability that is always ready would
 * otherwise starve every capability registered after it. Reconciliation and purge sweeps in
 * particular can be continuously ready, and must not be able to block power or resize work.
 */
export class WorkflowRegistry {
  private readonly executors: readonly WorkflowExecutor[];
  private cursor = 0;

  /**
   * @param executors One executor per supported action.
   * @throws Error if two executors claim the same action, which would make routing ambiguous.
   */
  public constructor(executors: readonly WorkflowExecutor[]) {
    const actions = new Set<WorkflowAction>();
    for (const executor of executors) {
      if (actions.has(executor.action)) {
        throw new Error(`Duplicate workflow executor for action ${executor.action}.`);
      }
      actions.add(executor.action);
    }
    this.executors = executors;
  }

  /** The actions this deployment can execute, in registration order. */
  public get actions(): readonly WorkflowAction[] {
    return this.executors.map((executor) => executor.action);
  }

  /**
   * Gives each executor one chance to advance a workflow, stopping at the first that does.
   *
   * @param leaseSeconds Lease duration passed through to whichever executor claims.
   * @returns `true` when some capability advanced a workflow, `false` when all were idle.
   */
  public async runOne(leaseSeconds?: number): Promise<boolean> {
    for (let attempt = 0; attempt < this.executors.length; attempt += 1) {
      const executor = this.executors[(this.cursor + attempt) % this.executors.length];
      if (!executor) continue;
      if (await executor.runOne(leaseSeconds)) {
        // Advance past the executor that just worked, so the next tick starts with the one after
        // it. This is what keeps a continuously ready capability from starving the others.
        this.cursor = (this.cursor + attempt + 1) % this.executors.length;
        return true;
      }
    }
    return false;
  }
}
