/**
 * The power capability: start, graceful shutdown, hard stop, and reboot.
 *
 * PATTERN — Persisted saga, sharing {@link LifecycleWorkflow}'s claim, retry, dead-letter, and
 * checkpoint machinery. Only three stages are its own, and only one of them touches the provider.
 *
 * The safety shape differs from create in one important way. Create's failure mode is a VM that
 * exists when it should not; power's is a VM in a state the tenant did not ask for — including,
 * for `stop`, one that lost unflushed writes. So `submitting_power` is a mutation stage: if the
 * provider cannot say whether it applied the transition, this must not simply try again.
 *
 * @see docs/architecture/state-machines.md
 * @see docs/architecture/safety-invariants.md
 */
import { randomUUID } from 'node:crypto';
import type {
  InstanceMutationCompletedV1,
  InstancePowerRequestedV1,
} from '@private-cloud/contracts';
import { ObservedPowerState } from '@private-cloud/contracts';
import type { ClaimedWorkflow } from './ports.js';
import { LifecycleWorkflow } from './lifecycle-workflow.js';
import type { PowerProviderPort } from '@private-cloud/provider-sdk';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';

/**
 * The one stage that changes provider state.
 *
 * Polling and observing are reads and are safe to repeat; submitting the transition is not.
 */
const POWER_MUTATION_STAGES: readonly WorkflowStage[] = ['submitting_power'];

/**
 * The observed power state each action is expected to produce.
 *
 * `reboot` maps to `running`: a reboot that leaves the guest off has not done what was asked, and
 * reporting success would tell the tenant their instance is up when it is not.
 */
const EXPECTED_POWER_STATE: Readonly<Record<string, ObservedPowerState>> = {
  start: ObservedPowerState.OBSERVED_POWER_STATE_RUNNING,
  reboot: ObservedPowerState.OBSERVED_POWER_STATE_RUNNING,
  shutdown: ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
  stop: ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
};

/** Executes power transitions one persisted checkpoint at a time. */
export class PowerInstanceWorkflow extends LifecycleWorkflow<
  PowerProviderPort,
  InstancePowerRequestedV1
> {
  public readonly action: WorkflowAction = 'power_instance';

  protected readonly mutationStages: readonly WorkflowStage[] = POWER_MUTATION_STAGES;

  /** The profile the request was accepted against, carried on the power command. */
  protected providerProfileId(workflow: ClaimedWorkflow<InstancePowerRequestedV1>): string {
    return workflow.command.data.providerProfileId;
  }

  /**
   * The create operation, carried on the command rather than this workflow's own operation id.
   *
   * The ownership markers on the VM were written by the create workflow. Presenting this power
   * operation's id instead would make the provider refuse to touch its own resource.
   */
  protected createOperationId(workflow: ClaimedWorkflow<InstancePowerRequestedV1>): string {
    return workflow.command.data.createOperationId;
  }

  /** Dispatches on the persisted stage; three stages, one of them a mutation. */
  protected async execute(workflow: ClaimedWorkflow<InstancePowerRequestedV1>): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        await this.progress(workflow, 'submitting_power');
        return;
      case 'submitting_power':
        await this.submitPower(workflow);
        return;
      case 'polling_power':
        await this.pollTask(workflow, 'observing_power');
        return;
      case 'observing_power':
        await this.observePower(workflow);
        return;
      default:
        // A create stage reaching the power workflow means the registry mis-routed, or stored
        // state is inconsistent. Either way no provider call is safe.
        await this.fail(workflow, {
          category: 'permanent',
          code: 'WORKFLOW_STAGE_INVALID',
          safeMessage: 'The persisted workflow stage is not supported by this capability.',
        });
    }
  }

  /** Asks the provider to apply the requested transition. The only mutating stage. */
  private async submitPower(workflow: ClaimedWorkflow<InstancePowerRequestedV1>): Promise<void> {
    const request = {
      request: {
        context: this.context(workflow, `power-${this.requestedAction(workflow)}`),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      },
    };

    // WHY a switch rather than an indexed call: the port methods differ in name only, but going
    // through a lookup table would let an unvalidated action reach the provider as a method name.
    const action = this.requestedAction(workflow);
    const response =
      action === 'start'
        ? await this.provider.startInstance(request)
        : action === 'shutdown'
          ? await this.provider.shutdownInstance(request)
          : action === 'stop'
            ? await this.provider.stopInstance(request)
            : await this.provider.rebootInstance(request);

    await this.handleMutationResult(workflow, response.result, 'polling_power', 'observing_power');
  }

  /**
   * Confirms the provider reached the requested state before reporting success.
   *
   * SAFE: an operation is not `succeeded` because a transport call returned, but because the
   * intended result was observed. A shutdown that the provider accepted and then failed to carry
   * out must not be reported as complete.
   */
  private async observePower(workflow: ClaimedWorkflow<InstancePowerRequestedV1>): Promise<void> {
    const observation = (
      await this.provider.observeInstance({
        context: this.context(workflow, 'observe-power'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      })
    ).observation;

    const expected = EXPECTED_POWER_STATE[this.requestedAction(workflow)];
    if (!observation?.exists || !observation.ownership?.complete || !observation.ownership.match) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'POWER_OBSERVATION_AMBIGUOUS',
        safeMessage: 'Provider observation did not prove an owned instance after the transition.',
      });
      return;
    }
    if (observation.powerState !== expected) {
      // Not a failure and not a success: the provider accepted the request and the instance is
      // owned, but it is not in the requested state. Retrying could mean a second hard stop, so
      // this is exactly the ambiguity that belongs with an operator.
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'POWER_STATE_NOT_REACHED',
        safeMessage: 'The instance did not reach the requested power state.',
      });
      return;
    }

    const event: InstanceMutationCompletedV1 = {
      ...this.envelope(workflow, 'instance.mutation.completed'),
      data: {
        action: 'power_instance',
        // Power changes do not move the instance off `active`; the transition is recorded as
        // observed state, not as a lifecycle change. See docs/architecture/state-machines.md.
        lifecycleState: 'active',
        providerResourceId: this.requiredResource(workflow),
        evidenceId: randomUUID(),
        observed: {
          exists: true,
          powerState:
            expected === ObservedPowerState.OBSERVED_POWER_STATE_RUNNING ? 'running' : 'stopped',
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

  /**
   * Reads the requested transition from the stored command.
   *
   * The command is narrowed at admission, so this is a read of validated state rather than a
   * second validation.
   */
  private requestedAction(workflow: ClaimedWorkflow<InstancePowerRequestedV1>): string {
    return workflow.command.data.action;
  }
}
