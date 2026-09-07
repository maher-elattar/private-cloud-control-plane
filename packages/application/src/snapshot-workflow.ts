/**
 * The snapshot capabilities: create, roll back, and delete.
 *
 * PATTERN — Persisted saga, sharing {@link LifecycleWorkflow}. One class serves all three actions
 * rather than three near-identical ones: they differ only in which provider call the submit stage
 * makes and what the confirming list is expected to show. The action is a constructor argument, so
 * the registry holds three instances of this class.
 *
 * The safety shape is the sharpest of any capability so far. A rollback discards everything
 * written since the snapshot, and a delete destroys the only copy of that state — neither is
 * reversible, so neither may be retried on an ambiguous outcome. Both are mutation stages.
 *
 * @see docs/architecture/safety-invariants.md
 */
import { randomUUID } from 'node:crypto';
import type {
  InstanceMutationCompletedV1,
  SnapshotCreateRequestedV1,
  SnapshotDeleteRequestedV1,
  SnapshotRollbackRequestedV1,
} from '@private-cloud/contracts';
import type { SnapshotProviderPort } from '@private-cloud/provider-sdk';
import { LifecycleWorkflow } from './lifecycle-workflow.js';
import type { ClaimedWorkflow } from './ports.js';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';

/** Any command this workflow executes. */
type SnapshotCommand =
  | SnapshotCreateRequestedV1
  | SnapshotRollbackRequestedV1
  | SnapshotDeleteRequestedV1;

/**
 * The one stage that changes provider state.
 *
 * Listing and polling are reads. Submitting is not, and for rollback and delete it is destructive:
 * an unknown outcome must reach an operator rather than be attempted twice.
 */
const SNAPSHOT_MUTATION_STAGES: readonly WorkflowStage[] = ['submitting_snapshot'];

/** The three actions this class can be instantiated for. */
export type SnapshotAction = 'create_snapshot' | 'rollback_snapshot' | 'delete_snapshot';

/** Executes one snapshot action per instance, one persisted checkpoint at a time. */
export class SnapshotWorkflow extends LifecycleWorkflow<SnapshotProviderPort, SnapshotCommand> {
  public readonly action: WorkflowAction;

  protected readonly mutationStages: readonly WorkflowStage[] = SNAPSHOT_MUTATION_STAGES;

  /**
   * @param action Which of the three snapshot actions this instance serves. The registry routes
   *   on it, and `runOne` refuses a workflow whose action is not this one.
   */
  public constructor(
    action: SnapshotAction,
    ...rest: ConstructorParameters<typeof LifecycleWorkflow<SnapshotProviderPort, SnapshotCommand>>
  ) {
    super(...rest);
    this.action = action;
  }

  /** The profile the request was accepted against. */
  protected providerProfileId(workflow: ClaimedWorkflow<SnapshotCommand>): string {
    return workflow.command.data.providerProfileId;
  }

  /** The create operation whose id is in the VM's ownership markers. */
  protected createOperationId(workflow: ClaimedWorkflow<SnapshotCommand>): string {
    return workflow.command.data.createOperationId;
  }

  /** Dispatches on the persisted stage. */
  protected async execute(workflow: ClaimedWorkflow<SnapshotCommand>): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        await this.progress(workflow, 'submitting_snapshot');
        return;
      case 'submitting_snapshot':
        await this.submitSnapshot(workflow);
        return;
      case 'polling_snapshot':
        await this.pollTask(workflow, 'observing_snapshot');
        return;
      case 'observing_snapshot':
        await this.observeSnapshot(workflow);
        return;
      default:
        await this.fail(workflow, {
          category: 'permanent',
          code: 'WORKFLOW_STAGE_INVALID',
          safeMessage: 'The persisted workflow stage is not supported by this capability.',
        });
    }
  }

  /** Issues the provider mutation for this instance's action. The only mutating stage. */
  private async submitSnapshot(workflow: ClaimedWorkflow<SnapshotCommand>): Promise<void> {
    const mutation = {
      context: this.context(workflow, this.action),
      providerResourceId: this.requiredResource(workflow),
      expectedOwnershipMarkers: this.ownership(workflow),
    };
    const data = workflow.command.data;

    let result;
    if (this.action === 'create_snapshot') {
      const create = data as SnapshotCreateRequestedV1['data'];
      result = (
        await this.provider.createSnapshot({
          request: mutation,
          snapshotId: create.snapshotId,
          name: create.name,
          ...(create.description ? { description: create.description } : {}),
        })
      ).result;
    } else {
      const target = data as SnapshotRollbackRequestedV1['data'];
      // `SnapshotMutationRequest` nests the instance mutation and adds the snapshot identity.
      const request = {
        request: {
          request: mutation,
          snapshotId: target.snapshotId,
          providerSnapshotReference: target.providerSnapshotReference,
        },
      };
      result =
        this.action === 'rollback_snapshot'
          ? (await this.provider.rollbackSnapshot(request)).result
          : (await this.provider.deleteSnapshot(request)).result;
    }

    await this.handleMutationResult(workflow, result, 'polling_snapshot', 'observing_snapshot');
  }

  /**
   * Confirms the provider's snapshot list matches what the action was supposed to achieve.
   *
   * A create must be present afterwards and a delete must be absent; the provider's own listing is
   * the only evidence that distinguishes "the task reported success" from "the snapshot exists".
   * Rollback is confirmed only by the task, because rolling back leaves the snapshot in place and
   * the listing therefore looks identical before and after.
   */
  private async observeSnapshot(workflow: ClaimedWorkflow<SnapshotCommand>): Promise<void> {
    const listing = await this.provider.listSnapshots({
      context: this.context(workflow, `${this.action}-observe`),
      providerResourceId: this.requiredResource(workflow),
      expectedOwnershipMarkers: this.ownership(workflow),
    });
    const names = new Set((listing.snapshots ?? []).map((snapshot) => snapshot.name));

    if (this.action !== 'rollback_snapshot') {
      const expectedName = this.expectedName(workflow);
      const present = names.has(expectedName);
      const satisfied = this.action === 'create_snapshot' ? present : !present;
      if (!satisfied) {
        await this.manualReview(workflow, {
          category: 'manual_review',
          code: 'SNAPSHOT_STATE_NOT_REACHED',
          safeMessage: 'The provider snapshot listing does not reflect the requested change.',
        });
        return;
      }
    }

    const event: InstanceMutationCompletedV1 = {
      ...this.envelope(workflow, 'instance.mutation.completed'),
      data: {
        action: this.action,
        // Snapshot actions do not move the instance off `active`.
        lifecycleState: 'active',
        providerResourceId: this.requiredResource(workflow),
        evidenceId: randomUUID(),
      },
    };
    await this.store.complete({
      operationId: workflow.command.operationId,
      workerId: this.workerId,
      fencingToken: workflow.fencingToken,
      status: 'succeeded',
      event,
    });
    this.telemetry.workflowTransition(workflow.stage, 'completed');
  }

  /** The provider-side snapshot name this action creates or removes. */
  private expectedName(workflow: ClaimedWorkflow<SnapshotCommand>): string {
    const data = workflow.command.data;
    return this.action === 'create_snapshot'
      ? (data as SnapshotCreateRequestedV1['data']).name
      : (data as SnapshotDeleteRequestedV1['data']).providerSnapshotReference;
  }
}
