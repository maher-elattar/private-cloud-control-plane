/**
 * The soft-deletion capability: detach tenant access and retain the provider resource.
 *
 * PATTERN — Persisted saga, sharing {@link LifecycleWorkflow}.
 *
 * SAFE-028 defines what "delete" means here, and it is deliberately not destruction. A normal
 * delete detaches access and *keeps* the VM for review; only an explicit administrative purge
 * destroys it. That is why this workflow calls `markInstanceRetained` rather than anything that
 * removes a resource, and why its terminal lifecycle state is `retained` rather than `purged`.
 *
 * @see docs/architecture/safety-invariants.md
 * @see docs/adr/0007-soft-delete-and-guarded-purge.md
 */
import { randomUUID } from 'node:crypto';
import {
  ObservedPowerState,
  type InstanceMutationCompletedV1,
  type InstanceRetentionRequestedV1,
} from '@private-cloud/contracts';
import type { RetentionProviderPort } from '@private-cloud/provider-sdk';
import { LifecycleWorkflow } from './lifecycle-workflow.js';
import type { ClaimedWorkflow } from './ports.js';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';

/**
 * The one stage that changes provider state.
 *
 * Marking retained edits the VM's description, disables autostart, and detaches its network
 * configuration. None of that destroys data, but it does change a live machine, so an unknown
 * outcome still belongs with an operator rather than being repeated.
 */
const RETENTION_MUTATION_STAGES: readonly WorkflowStage[] = ['submitting_retention'];

/** Executes soft deletion one persisted checkpoint at a time. */
export class RetainInstanceWorkflow extends LifecycleWorkflow<
  RetentionProviderPort,
  InstanceRetentionRequestedV1
> {
  public readonly action: WorkflowAction = 'retain_instance';

  protected readonly mutationStages: readonly WorkflowStage[] = RETENTION_MUTATION_STAGES;

  /** The profile the request was accepted against. */
  protected providerProfileId(workflow: ClaimedWorkflow<InstanceRetentionRequestedV1>): string {
    return workflow.command.data.providerProfileId;
  }

  /** The create operation whose id is in the VM's ownership markers. */
  protected createOperationId(workflow: ClaimedWorkflow<InstanceRetentionRequestedV1>): string {
    return workflow.command.data.createOperationId;
  }

  /** Dispatches on the persisted stage. */
  protected async execute(workflow: ClaimedWorkflow<InstanceRetentionRequestedV1>): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        await this.progress(workflow, 'submitting_retention');
        return;
      case 'submitting_retention':
        await this.submitRetention(workflow);
        return;
      case 'polling_retention':
        await this.pollTask(workflow, 'observing_retention');
        return;
      case 'observing_retention':
        await this.observeRetention(workflow);
        return;
      default:
        await this.fail(workflow, {
          category: 'permanent',
          code: 'WORKFLOW_STAGE_INVALID',
          safeMessage: 'The persisted workflow stage is not supported by this capability.',
        });
    }
  }

  /** Marks the VM retained. The only mutating stage. */
  private async submitRetention(
    workflow: ClaimedWorkflow<InstanceRetentionRequestedV1>,
  ): Promise<void> {
    const response = await this.provider.markInstanceRetained({
      request: {
        context: this.context(workflow, 'retain'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      },
      retentionDeadline: workflow.command.data.retentionDeadline,
    });
    await this.handleMutationResult(
      workflow,
      response.result,
      'polling_retention',
      'observing_retention',
    );
  }

  /**
   * Confirms the VM still exists and is still ours before declaring it retained.
   *
   * WHY existence is the thing checked: retention's whole promise is that the resource is *kept*.
   * A VM that has vanished during retention is the one outcome that breaks that promise, and it
   * cannot be resolved automatically — an operator has to establish what happened to it.
   */
  private async observeRetention(
    workflow: ClaimedWorkflow<InstanceRetentionRequestedV1>,
  ): Promise<void> {
    const observation = (
      await this.provider.observeInstance({
        context: this.context(workflow, 'observe-retention'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      })
    ).observation;

    if (!observation?.exists || !observation.ownership?.complete || !observation.ownership.match) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'RETENTION_OBSERVATION_AMBIGUOUS',
        safeMessage: 'The retained instance could not be observed as present and owned.',
      });
      return;
    }

    const event: InstanceMutationCompletedV1 = {
      ...this.envelope(workflow, 'instance.mutation.completed'),
      data: {
        action: 'retain_instance',
        lifecycleState: 'retained',
        providerResourceId: this.requiredResource(workflow),
        evidenceId: randomUUID(),
        observed: {
          exists: true,
          // Retention disables autostart but does not itself stop the VM, so whatever power state
          // the provider reports is what is recorded.
          powerState:
            observation.powerState === ObservedPowerState.OBSERVED_POWER_STATE_STOPPED
              ? 'stopped'
              : observation.powerState === ObservedPowerState.OBSERVED_POWER_STATE_RUNNING
                ? 'running'
                : 'unknown',
          markerMatch: true,
          observedAt: observation.observedAt ?? new Date().toISOString(),
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
