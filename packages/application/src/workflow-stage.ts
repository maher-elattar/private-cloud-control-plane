/**
 * The create-instance workflow's stage vocabulary.
 *
 * PATTERN — Persisted saga. Provisioning a VM is roughly eight provider interactions
 * spanning minutes. Rather than hold that in a call stack, the workflow's position is a
 * column in `workflow.workflows.stage`, so any worker can resume from the last committed
 * point after a restart. This module is the single definition of the stages that column may
 * hold.
 *
 * Before this existed the stage list lived in two places — the `switch` in
 * {@link CreateInstanceWorkflow.execute} and a progress map inside the projection store —
 * which could silently drift apart. Keeping one union here means the compiler catches a
 * stage added to one and forgotten in the other.
 *
 * @see docs/architecture/glossary.md#persisted-saga-workflow-state-machine
 * @see docs/architecture/phase-3-vertical-slice.md
 */

/**
 * Stages the create workflow actively transitions through, in execution order.
 *
 * Each stage names the position *before* its external action runs, so a worker that crashes
 * mid-stage retries that stage rather than skipping it. The `polling_*` stages exist because
 * a provider may answer a mutation asynchronously with a task reference; they re-enter
 * themselves until the task reaches a terminal state.
 *
 * | Stage | External action | Next on success |
 * | --- | --- | --- |
 * | `accepted` | none | `submitting_create` |
 * | `submitting_create` | `SubmitCreateInstance` | `polling_create` or `configuring` |
 * | `polling_create` | `GetTask` | `configuring` |
 * | `configuring` | `ApplyInstanceConfiguration` | `polling_configuration` or `starting` |
 * | `polling_configuration` | `GetTask` | `starting` |
 * | `starting` | `StartInstance` | `polling_start` or `observing` |
 * | `polling_start` | `GetTask` | `observing` |
 * | `observing` | `ObserveInstance` | terminal `completed` |
 *
 * Power adds three of its own:
 *
 * | Stage | External action | Next on success |
 * | --- | --- | --- |
 * | `submitting_power` | `StartInstance` / `ShutdownInstance` / `StopInstance` / `RebootInstance` | `polling_power` or `observing_power` |
 * | `polling_power` | `GetTask` | `observing_power` |
 * | `observing_power` | `ObserveInstance` | terminal `completed` |
 */
export const WORKFLOW_STAGES = [
  'accepted',
  // Create.
  'submitting_create',
  'polling_create',
  'configuring',
  'polling_configuration',
  'starting',
  'polling_start',
  'observing',
  // Power. Separate stage names rather than reusing create's `starting`/`polling_start`, because
  // `handleProviderError` classifies mutation stages per capability: a stage shared between two
  // capabilities could not be a mutation in one and not the other.
  'submitting_power',
  'polling_power',
  'observing_power',
  // Resize.
  'submitting_resize',
  'polling_resize',
  'observing_resize',
  // Snapshots. Shared by create, rollback, and delete: all three submit one provider mutation,
  // poll its task, and confirm the snapshot list afterwards.
  'submitting_snapshot',
  'polling_snapshot',
  'observing_snapshot',
  // Soft deletion.
  'submitting_retention',
  'polling_retention',
  'observing_retention',
  // Administrative purge. `verifying_purge` has no counterpart in any other capability: it proves
  // live provider ownership *before* the destructive call, which SAFE-006 requires.
  'verifying_purge',
  'submitting_purge',
  'polling_purge',
  'observing_purge',
] as const;

/** A stage the workflow can be claimed at and transition from. */
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/**
 * Stages written only when a workflow finishes.
 *
 * These are separate from {@link WorkflowStage} because the workflow never transitions
 * *through* them — they are set by `WorkflowStore.complete` and no worker ever claims one.
 * Keeping them out of the active union is what makes the `switch` in
 * {@link CreateInstanceWorkflow.execute} exhaustively checkable.
 *
 * `manual_review` is a terminal state, not a failure: it means the provider outcome could
 * not be proven either way, and no automated path may guess. See
 * docs/architecture/safety-invariants.md.
 */
export type TerminalStage = 'completed' | 'failed' | 'manual_review';

/** Any value the `workflow.workflows.stage` column may hold. */
export type PersistedStage = WorkflowStage | TerminalStage;

/**
 * Progress percentages surfaced on the `Operation` read model.
 *
 * These are presentation values for polling clients, not a measurement of provider work.
 * They rise monotonically so a UI progress bar never moves backwards; the exact numbers are
 * arbitrary beyond that ordering requirement.
 */
export const STAGE_PROGRESS_PERCENT: Readonly<Record<PersistedStage, number>> = {
  accepted: 0,
  submitting_create: 10,
  polling_create: 25,
  configuring: 40,
  polling_configuration: 55,
  starting: 70,
  polling_start: 82,
  observing: 92,
  submitting_power: 20,
  polling_power: 55,
  observing_power: 85,
  submitting_resize: 20,
  polling_resize: 55,
  observing_resize: 85,
  submitting_snapshot: 20,
  polling_snapshot: 55,
  observing_snapshot: 85,
  submitting_retention: 20,
  polling_retention: 55,
  observing_retention: 85,
  verifying_purge: 15,
  submitting_purge: 40,
  polling_purge: 65,
  observing_purge: 88,
  completed: 100,
  failed: 100,
  manual_review: 100,
};

/**
 * Narrows a stage value read from the database to the active workflow union.
 *
 * WHY this is a runtime check rather than a cast: the `stage` column is plain `text`, so a
 * hand-edited row or a rollback to an older schema could hold anything. Failing loudly here
 * localises the problem to the claim, instead of letting an unknown stage fall through to a
 * `default` branch that would terminate a perfectly healthy workflow.
 *
 * @throws Error if the value is not a stage the workflow can transition from.
 */
export function toWorkflowStage(value: string): WorkflowStage {
  if ((WORKFLOW_STAGES as readonly string[]).includes(value)) return value as WorkflowStage;
  throw new Error(`Unsupported workflow stage: ${value}`);
}

/**
 * Every lifecycle capability a workflow may execute.
 *
 * This is the discriminator the orchestrator dispatches on and the value stored in
 * `workflow.workflows.action`. It exists as a column rather than being derived from the stored
 * command's `schemaName` because the dispatcher selects on it, a `jsonb` extraction cannot be
 * indexed usefully, and a database CHECK constraint can only guard a real column.
 *
 * The order matches the roadmap's implementation order, which is also the order of increasing
 * blast radius: reads first, then reversible mutations, then deletion and purge.
 */
export const WORKFLOW_ACTIONS = [
  'create_instance',
  'power_instance',
  'resize_instance',
  'create_snapshot',
  'rollback_snapshot',
  'delete_snapshot',
  'retain_instance',
  'purge_instance',
  'reconcile_instance',
] as const;

/** A capability a workflow may execute. */
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/**
 * Narrows an action value read from the database to the supported union.
 *
 * WHY loudly rather than defaulting to `create_instance`: an unrecognised action means this
 * deployment does not know how to execute the workflow, and guessing would run the wrong provider
 * calls against a real VM. A rollback to an older build must fail to claim, not mis-execute.
 *
 * @throws Error if the value is not a capability this deployment implements.
 */
export function toWorkflowAction(value: string): WorkflowAction {
  if ((WORKFLOW_ACTIONS as readonly string[]).includes(value)) return value as WorkflowAction;
  throw new Error(`Unsupported workflow action: ${value}`);
}
