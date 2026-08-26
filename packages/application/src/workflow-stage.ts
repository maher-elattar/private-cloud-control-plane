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
 */
export const WORKFLOW_STAGES = [
  'accepted',
  'submitting_create',
  'polling_create',
  'configuring',
  'polling_configuration',
  'starting',
  'polling_start',
  'observing',
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
