/**
 * The resize capability: change an instance's CPU, memory, and disk to a selected flavor.
 *
 * PATTERN — Persisted saga, sharing {@link LifecycleWorkflow}'s machinery. Three stages, one of
 * them a mutation.
 *
 * The safety shape is different again from create and power. A resize that half-applies leaves an
 * instance whose desired and observed sizing disagree, which is recoverable — the reconciler will
 * report the drift and the operation can be re-issued. What is *not* recoverable is a disk that
 * shrank, so that is refused at acceptance rather than handled here: by the time a workflow runs,
 * the safe answer is already the only one it can produce.
 *
 * @see docs/architecture/safety-invariants.md
 */
import { randomUUID } from 'node:crypto';
import type {
  InstanceMutationCompletedV1,
  InstanceResizeRequestedV1,
} from '@private-cloud/contracts';
import type { ResizeProviderPort } from '@private-cloud/provider-sdk';
import { LifecycleWorkflow } from './lifecycle-workflow.js';
import type { ClaimedWorkflow } from './ports.js';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';

/**
 * The one stage that changes provider state.
 *
 * A resize submitted but not confirmed must not be re-submitted blindly: Proxmox applies a disk
 * grow immediately and irreversibly, so a repeat could grow it twice.
 */
const RESIZE_MUTATION_STAGES: readonly WorkflowStage[] = ['submitting_resize'];

/** Executes flavor resizes one persisted checkpoint at a time. */
export class ResizeInstanceWorkflow extends LifecycleWorkflow<
  ResizeProviderPort,
  InstanceResizeRequestedV1
> {
  public readonly action: WorkflowAction = 'resize_instance';

  protected readonly mutationStages: readonly WorkflowStage[] = RESIZE_MUTATION_STAGES;

  /** The profile the request was accepted against. */
  protected providerProfileId(workflow: ClaimedWorkflow<InstanceResizeRequestedV1>): string {
    return workflow.command.data.providerProfileId;
  }

  /** The create operation whose id is in the VM's ownership markers. */
  protected createOperationId(workflow: ClaimedWorkflow<InstanceResizeRequestedV1>): string {
    return workflow.command.data.createOperationId;
  }

  /** Dispatches on the persisted stage. */
  protected async execute(workflow: ClaimedWorkflow<InstanceResizeRequestedV1>): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        await this.progress(workflow, 'submitting_resize');
        return;
      case 'submitting_resize':
        await this.submitResize(workflow);
        return;
      case 'polling_resize':
        await this.pollTask(workflow, 'observing_resize');
        return;
      case 'observing_resize':
        await this.observeResize(workflow);
        return;
      default:
        await this.fail(workflow, {
          category: 'permanent',
          code: 'WORKFLOW_STAGE_INVALID',
          safeMessage: 'The persisted workflow stage is not supported by this capability.',
        });
    }
  }

  /** Applies the target sizing. The only mutating stage. */
  private async submitResize(workflow: ClaimedWorkflow<InstanceResizeRequestedV1>): Promise<void> {
    const target = workflow.command.data.targetResources;
    const response = await this.provider.resizeInstance({
      request: {
        context: this.context(workflow, 'resize'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      },
      targetResources: {
        cpuCount: target.cpuCount,
        memoryMib: String(target.memoryMiB),
        diskGib: String(target.diskGiB),
      },
    });
    await this.handleMutationResult(
      workflow,
      response.result,
      'polling_resize',
      'observing_resize',
    );
  }

  /**
   * Confirms the provider reports the requested sizing before reporting success.
   *
   * WHY this tolerates a provider that reports no sizing at all, unlike the power capability's
   * strict state check: `InstanceObservation.resources` is optional in the contract, and a
   * provider that cannot measure is not the same as one that measured a wrong value. Only an
   * actual disagreement is treated as unresolved.
   */
  private async observeResize(workflow: ClaimedWorkflow<InstanceResizeRequestedV1>): Promise<void> {
    const observation = (
      await this.provider.observeInstance({
        context: this.context(workflow, 'observe-resize'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      })
    ).observation;

    if (!observation?.exists || !observation.ownership?.complete || !observation.ownership.match) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'RESIZE_OBSERVATION_AMBIGUOUS',
        safeMessage: 'Provider observation did not prove an owned instance after the resize.',
      });
      return;
    }

    const target = workflow.command.data.targetResources;
    const measured = observation.resources;
    const disagrees =
      measured !== undefined &&
      measured.cpuCount !== undefined &&
      (measured.cpuCount !== target.cpuCount ||
        Number(measured.memoryMib) !== target.memoryMiB ||
        Number(measured.diskGib) !== target.diskGiB);
    if (disagrees) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'RESIZE_NOT_APPLIED',
        safeMessage: 'The instance did not reach the requested sizing.',
      });
      return;
    }

    const event: InstanceMutationCompletedV1 = {
      ...this.envelope(workflow, 'instance.mutation.completed'),
      data: {
        action: 'resize_instance',
        // A resize does not move the instance off `active`; the new sizing is observed state.
        lifecycleState: 'active',
        providerResourceId: this.requiredResource(workflow),
        evidenceId: randomUUID(),
        observed: {
          exists: true,
          // A resize does not change power state, and observing one would report whatever the
          // instance happened to be doing rather than anything this operation caused.
          powerState: 'unknown',
          ...(measured && measured.cpuCount !== undefined
            ? {
                resources: {
                  cpuCount: measured.cpuCount,
                  memoryMiB: Number(measured.memoryMib),
                  diskGiB: Number(measured.diskGib),
                },
              }
            : {}),
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
