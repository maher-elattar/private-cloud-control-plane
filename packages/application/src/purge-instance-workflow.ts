/**
 * The administrative purge capability: destroy a retained provider resource.
 *
 * PATTERN — Persisted saga with a verification stage, sharing {@link LifecycleWorkflow}.
 *
 * This is the only workflow in the system that destroys anything, and it is the only one with a
 * stage before its mutation whose sole job is to refuse. SAFE-006 requires both database ownership
 * *and* matching live provider ownership markers: the acceptance transaction proves the first, and
 * `verifying_purge` proves the second immediately before the destructive call, on the reasoning
 * that a resource whose markers no longer match is not the one that was authorized for
 * destruction — it may be a VMID that was recycled to someone else.
 *
 * There is deliberately no compensation path. Nothing can undo a purge, so the failure branches
 * are refuse-before-acting or escalate to manual review, never retry-and-hope.
 *
 * @see docs/architecture/safety-invariants.md
 * @see docs/adr/0007-soft-delete-and-guarded-purge.md
 */
import { randomUUID } from 'node:crypto';
import type {
  InstanceMutationCompletedV1,
  InstancePurgeRequestedV1,
} from '@private-cloud/contracts';
import type { PurgeProviderPort } from '@private-cloud/provider-sdk';
import { LifecycleWorkflow } from './lifecycle-workflow.js';
import type { ClaimedWorkflow } from './ports.js';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';

/**
 * The one stage that changes provider state.
 *
 * `verifying_purge` is a read and deliberately excluded: it must be safe to repeat, because a
 * transport failure while verifying should send the workflow round again rather than to manual
 * review. `submitting_purge` is the opposite — an unknown outcome there means a VM may or may not
 * still exist, which only an operator can establish.
 */
const PURGE_MUTATION_STAGES: readonly WorkflowStage[] = ['submitting_purge'];

/** Executes an authorized purge one persisted checkpoint at a time. */
export class PurgeInstanceWorkflow extends LifecycleWorkflow<
  PurgeProviderPort,
  InstancePurgeRequestedV1
> {
  public readonly action: WorkflowAction = 'purge_instance';

  protected readonly mutationStages: readonly WorkflowStage[] = PURGE_MUTATION_STAGES;

  /** The profile the request was accepted against. */
  protected providerProfileId(workflow: ClaimedWorkflow<InstancePurgeRequestedV1>): string {
    return workflow.command.data.providerProfileId;
  }

  /** The create operation whose id is in the VM's ownership markers. */
  protected createOperationId(workflow: ClaimedWorkflow<InstancePurgeRequestedV1>): string {
    return workflow.command.data.createOperationId;
  }

  /** Dispatches on the persisted stage. */
  protected async execute(workflow: ClaimedWorkflow<InstancePurgeRequestedV1>): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        await this.progress(workflow, 'verifying_purge');
        return;
      case 'verifying_purge':
        await this.verifyOwnership(workflow);
        return;
      case 'submitting_purge':
        await this.submitPurge(workflow);
        return;
      case 'polling_purge':
        await this.pollTask(workflow, 'observing_purge');
        return;
      case 'observing_purge':
        await this.observeAbsence(workflow);
        return;
      default:
        await this.fail(workflow, {
          category: 'permanent',
          code: 'WORKFLOW_STAGE_INVALID',
          safeMessage: 'The persisted workflow stage is not supported by this capability.',
        });
    }
  }

  /**
   * Proves live provider ownership immediately before destroying anything.
   *
   * SAFE-006's second half. A VM whose markers no longer match is not the resource that was
   * authorized for destruction — most plausibly its VMID has been recycled — so this refuses
   * rather than proceeding, and refuses to an operator rather than to a retry.
   *
   * A VM that has already vanished is treated as success, not failure: the purge's goal is
   * absence, and absence has been achieved.
   */
  private async verifyOwnership(
    workflow: ClaimedWorkflow<InstancePurgeRequestedV1>,
  ): Promise<void> {
    const observation = (
      await this.provider.observeInstance({
        context: this.context(workflow, 'verify-purge'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      })
    ).observation;

    if (!observation?.exists) {
      await this.completePurge(workflow, 'The instance was already absent from the provider.');
      return;
    }
    if (!observation.ownership?.complete || !observation.ownership.match) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'PURGE_OWNERSHIP_NOT_PROVEN',
        safeMessage: 'Live provider ownership could not be proven; the purge was not attempted.',
      });
      return;
    }
    await this.progress(workflow, 'submitting_purge');
  }

  /** Destroys the provider resource. Irreversible, and the only such call in the system. */
  private async submitPurge(workflow: ClaimedWorkflow<InstancePurgeRequestedV1>): Promise<void> {
    const response = await this.provider.purgeInstance({
      request: {
        context: this.context(workflow, 'purge'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      },
      purgeAuthorizationId: workflow.command.data.purgeAuthorizationId,
      retentionDeadline: workflow.command.data.retentionDeadline,
    });
    await this.handleMutationResult(workflow, response.result, 'polling_purge', 'observing_purge');
  }

  /**
   * Requires proven absence before reporting the purge complete.
   *
   * A task reporting success is not evidence the VM is gone; only a failed lookup is. Reporting
   * `purged` for a VM that still exists would leave a resource nobody is tracking and nobody is
   * paying attention to.
   */
  private async observeAbsence(workflow: ClaimedWorkflow<InstancePurgeRequestedV1>): Promise<void> {
    const observation = (
      await this.provider.observeInstance({
        context: this.context(workflow, 'observe-purge'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      })
    ).observation;

    if (observation?.exists) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'PURGE_NOT_CONFIRMED',
        safeMessage: 'The instance is still present after the purge was submitted.',
      });
      return;
    }
    await this.completePurge(workflow, 'The instance is absent from the provider.');
  }

  /** Records the terminal `purged` state, with absence as the evidence. */
  private async completePurge(
    workflow: ClaimedWorkflow<InstancePurgeRequestedV1>,
    observedNote: string,
  ): Promise<void> {
    void observedNote;
    const event: InstanceMutationCompletedV1 = {
      ...this.envelope(workflow, 'instance.mutation.completed'),
      data: {
        action: 'purge_instance',
        lifecycleState: 'purged',
        providerResourceId: this.requiredResource(workflow),
        evidenceId: randomUUID(),
        observed: {
          exists: false,
          powerState: 'unknown',
          // Absence cannot match a marker; recording `false` states plainly that nothing was
          // matched rather than implying a check succeeded.
          markerMatch: false,
          observedAt: new Date().toISOString(),
        },
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
}
