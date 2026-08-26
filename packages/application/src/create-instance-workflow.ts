import { randomUUID } from 'node:crypto';
import {
  FailureCategory,
  ObservedPowerState,
  type InstanceMutationCompletedV1,
  type InstanceMutationFailedV1,
  type WorkflowProgressedV1,
} from '@private-cloud/contracts';
import type {
  GetTaskResponse,
  OwnershipMarkers,
  ProviderCallContext,
  ProviderFailure,
  ProviderMutationResult,
} from '@private-cloud/contracts/provider';
import { ProviderResultState, ProviderTaskState } from '@private-cloud/contracts/provider';
import {
  ProviderTransportError,
  type CreateInstanceProviderPort,
} from '@private-cloud/provider-sdk';
import type { ClaimedCreateWorkflow, WorkflowStore } from './ports.js';

function providerFailureCategory(
  category: FailureCategory | undefined,
): InstanceMutationFailedV1['data']['failure']['category'] {
  switch (category) {
    case FailureCategory.FAILURE_CATEGORY_VALIDATION:
    case FailureCategory.FAILURE_CATEGORY_QUOTA:
      return 'validation';
    case FailureCategory.FAILURE_CATEGORY_AUTHENTICATION:
    case FailureCategory.FAILURE_CATEGORY_AUTHORIZATION:
      return 'authorization';
    case FailureCategory.FAILURE_CATEGORY_CONFLICT:
      return 'conflict';
    case FailureCategory.FAILURE_CATEGORY_TRANSIENT:
      return 'transient';
    case FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME:
      return 'unknown_outcome';
    case FailureCategory.FAILURE_CATEGORY_COMPENSATION_FAILURE:
      return 'compensation_failure';
    case FailureCategory.FAILURE_CATEGORY_MANUAL_REVIEW:
      return 'manual_review';
    default:
      return 'permanent';
  }
}

/** Executes one persisted workflow transition. The caller must claim again before the next step. */
export class CreateInstanceWorkflow {
  public constructor(
    private readonly store: WorkflowStore,
    private readonly provider: CreateInstanceProviderPort,
    private readonly workerId: string,
  ) {}

  public async runOne(leaseSeconds = 30): Promise<boolean> {
    const workflow = await this.store.claimNextCreate(this.workerId, leaseSeconds);
    if (!workflow) return false;
    try {
      await this.execute(workflow);
    } catch (error: unknown) {
      if (!(error instanceof ProviderTransportError)) throw error;
      await this.handleProviderError(workflow, error);
    }
    return true;
  }

  private async execute(workflow: ClaimedCreateWorkflow): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        await this.progress(workflow, 'submitting_create');
        return;
      case 'submitting_create':
        await this.submitCreate(workflow);
        return;
      case 'polling_create':
        await this.pollTask(workflow, 'configuring');
        return;
      case 'configuring':
        await this.configure(workflow);
        return;
      case 'polling_configuration':
        await this.pollTask(workflow, 'starting');
        return;
      case 'starting':
        await this.start(workflow);
        return;
      case 'polling_start':
        await this.pollTask(workflow, 'observing');
        return;
      case 'observing':
        await this.observe(workflow);
        return;
      default:
        await this.fail(workflow, {
          category: 'permanent',
          code: 'WORKFLOW_STAGE_INVALID',
          safeMessage: 'The persisted workflow stage is not supported.',
        });
    }
  }

  private async submitCreate(workflow: ClaimedCreateWorkflow): Promise<void> {
    const command = workflow.command;
    const result = (
      await this.provider.submitCreateInstance({
        context: this.context(workflow, 'create'),
        imageId: command.data.imageId,
        flavorId: command.data.flavorId,
        hostname: command.data.hostname,
        resources: {
          cpuCount: command.data.resources.cpuCount,
          memoryMib: String(command.data.resources.memoryMiB),
          diskGib: String(command.data.resources.diskGiB),
        },
        network: {
          networkId: command.data.networkId,
          ipv4Address: command.data.ipv4.address,
          ipv4PrefixLength: command.data.ipv4.prefixLength,
          ipv4Gateway: command.data.ipv4.gateway,
          dnsServers: [...command.data.ipv4.dnsServers],
        },
        sshPublicKeys: [...(command.data.sshPublicKeys ?? [])],
        ownershipMarkers: this.ownership(workflow),
      })
    ).result;
    await this.handleMutationResult(workflow, result, 'polling_create', 'configuring');
  }

  private async configure(workflow: ClaimedCreateWorkflow): Promise<void> {
    const resourceId = this.requiredResource(workflow);
    const command = workflow.command;
    const result = (
      await this.provider.applyInstanceConfiguration({
        context: this.context(workflow, 'configure'),
        providerResourceId: resourceId,
        hostname: command.data.hostname,
        resources: {
          cpuCount: command.data.resources.cpuCount,
          memoryMib: String(command.data.resources.memoryMiB),
          diskGib: String(command.data.resources.diskGiB),
        },
        network: {
          networkId: command.data.networkId,
          ipv4Address: command.data.ipv4.address,
          ipv4PrefixLength: command.data.ipv4.prefixLength,
          ipv4Gateway: command.data.ipv4.gateway,
          dnsServers: [...command.data.ipv4.dnsServers],
        },
        sshPublicKeys: [...(command.data.sshPublicKeys ?? [])],
        ownershipMarkers: this.ownership(workflow),
      })
    ).result;
    await this.handleMutationResult(workflow, result, 'polling_configuration', 'starting');
  }

  private async start(workflow: ClaimedCreateWorkflow): Promise<void> {
    const result = (
      await this.provider.startInstance({
        request: {
          context: this.context(workflow, 'start'),
          providerResourceId: this.requiredResource(workflow),
          expectedOwnershipMarkers: this.ownership(workflow),
        },
      })
    ).result;
    await this.handleMutationResult(workflow, result, 'polling_start', 'observing');
  }

  private async pollTask(workflow: ClaimedCreateWorkflow, successStage: string): Promise<void> {
    const taskReference = workflow.providerTaskReference;
    if (!taskReference) {
      await this.fail(workflow, {
        category: 'permanent',
        code: 'PROVIDER_TASK_REFERENCE_MISSING',
        safeMessage: 'The provider task reference was not persisted.',
      });
      return;
    }
    const response = await this.provider.getTask({
      context: this.context(workflow, `poll-${workflow.stage}`),
      providerTaskReference: taskReference,
    });
    await this.handleTaskResult(workflow, response, successStage, taskReference);
  }

  private async observe(workflow: ClaimedCreateWorkflow): Promise<void> {
    const observation = (
      await this.provider.observeInstance({
        context: this.context(workflow, 'observe'),
        providerResourceId: this.requiredResource(workflow),
        expectedOwnershipMarkers: this.ownership(workflow),
      })
    ).observation;
    if (
      !observation?.exists ||
      !observation.ownership?.complete ||
      !observation.ownership.match ||
      observation.powerState !== ObservedPowerState.OBSERVED_POWER_STATE_RUNNING
    ) {
      await this.manualReview(workflow, {
        category: 'manual_review',
        code: 'CREATE_OBSERVATION_AMBIGUOUS',
        safeMessage: 'Provider observation did not prove an owned running instance.',
      });
      return;
    }
    const event: InstanceMutationCompletedV1 = {
      ...this.envelope(workflow, 'instance.mutation.completed'),
      data: {
        action: 'create_instance',
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
  }

  private async handleMutationResult(
    workflow: ClaimedCreateWorkflow,
    result: ProviderMutationResult | undefined,
    acceptedStage: string,
    synchronousStage: string,
  ): Promise<void> {
    if (!result) {
      await this.fail(workflow, {
        category: 'permanent',
        code: 'PROVIDER_RESULT_MISSING',
        safeMessage: 'The provider response omitted its result.',
      });
      return;
    }
    if (result.state === ProviderResultState.PROVIDER_RESULT_STATE_UNKNOWN) {
      await this.manualReview(workflow, this.failureValue(result.failure, 'PROVIDER_UNKNOWN'));
      return;
    }
    if (result.state === ProviderResultState.PROVIDER_RESULT_STATE_REJECTED) {
      await this.fail(workflow, this.failureValue(result.failure, 'PROVIDER_REJECTED'));
      return;
    }
    const resourceId = result.providerResourceId ?? workflow.providerResourceId;
    if (!resourceId) {
      await this.fail(workflow, {
        category: 'permanent',
        code: 'PROVIDER_RESOURCE_ID_MISSING',
        safeMessage: 'The provider response omitted the resource identifier.',
      });
      return;
    }
    if (result.state === ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED) {
      if (!result.providerTaskReference) {
        await this.fail(workflow, {
          category: 'permanent',
          code: 'PROVIDER_TASK_REFERENCE_MISSING',
          safeMessage: 'The asynchronous provider response omitted its task reference.',
        });
        return;
      }
      await this.progress(workflow, acceptedStage, {
        providerResourceId: resourceId,
        providerTaskReference: result.providerTaskReference,
      });
      return;
    }
    if (result.state === ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED) {
      await this.progress(workflow, synchronousStage, { providerResourceId: resourceId });
      return;
    }
    await this.fail(workflow, {
      category: 'permanent',
      code: 'PROVIDER_RESULT_STATE_INVALID',
      safeMessage: 'The provider returned an unsupported result state.',
    });
  }

  private async handleTaskResult(
    workflow: ClaimedCreateWorkflow,
    response: GetTaskResponse,
    successStage: string,
    taskReference: string,
  ): Promise<void> {
    if (
      response.state === ProviderTaskState.PROVIDER_TASK_STATE_QUEUED ||
      response.state === ProviderTaskState.PROVIDER_TASK_STATE_RUNNING
    ) {
      await this.progress(workflow, workflow.stage, {
        providerTaskReference: taskReference,
        nextAttemptAt: new Date(Date.now() + 500),
      });
      return;
    }
    if (response.state === ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED) {
      await this.progress(workflow, successStage, { providerTaskReference: null });
      return;
    }
    if (response.state === ProviderTaskState.PROVIDER_TASK_STATE_UNKNOWN) {
      await this.manualReview(workflow, {
        category: 'unknown_outcome',
        code: 'PROVIDER_TASK_UNKNOWN',
        safeMessage: 'The provider no longer has an authoritative task result.',
      });
      return;
    }
    await this.fail(workflow, this.failureValue(response.failure, 'PROVIDER_TASK_FAILED'));
  }

  private async handleProviderError(
    workflow: ClaimedCreateWorkflow,
    error: ProviderTransportError,
  ): Promise<void> {
    const mutationStage = ['submitting_create', 'configuring', 'starting'].includes(workflow.stage);
    if (mutationStage && error.code !== 'protocol_error') {
      await this.manualReview(workflow, {
        category: 'unknown_outcome',
        code: `PROVIDER_${error.code.toUpperCase()}`,
        safeMessage: 'The mutation transport failed and its provider outcome is unknown.',
      });
      return;
    }
    if (error.retryable) {
      await this.progress(workflow, workflow.stage, {
        nextAttemptAt: new Date(Date.now() + Math.min(5_000, workflow.attempt * 500)),
        operationState: 'retry_wait',
      });
      return;
    }
    await this.fail(workflow, {
      category: 'permanent',
      code: 'PROVIDER_PROTOCOL_ERROR',
      safeMessage: 'The create workflow could not continue safely.',
    });
  }

  private async progress(
    workflow: ClaimedCreateWorkflow,
    stage: string,
    options: {
      readonly providerResourceId?: string;
      readonly providerTaskReference?: string | null;
      readonly nextAttemptAt?: Date;
      readonly operationState?: WorkflowProgressedV1['data']['operationState'];
    } = {},
  ): Promise<void> {
    const event: WorkflowProgressedV1 = {
      ...this.envelope(workflow, 'workflow.progressed'),
      data: {
        stage,
        attempt: workflow.attempt,
        operationState: options.operationState ?? 'running',
        ...(typeof options.providerTaskReference === 'string'
          ? { providerTaskReference: options.providerTaskReference }
          : {}),
        ...(options.nextAttemptAt ? { nextActionAt: options.nextAttemptAt.toISOString() } : {}),
      },
    };
    await this.store.checkpoint({
      operationId: workflow.command.operationId,
      workerId: this.workerId,
      fencingToken: workflow.fencingToken,
      stage,
      ...(options.providerResourceId
        ? { providerResourceId: options.providerResourceId }
        : workflow.providerResourceId
          ? { providerResourceId: workflow.providerResourceId }
          : {}),
      ...('providerTaskReference' in options
        ? { providerTaskReference: options.providerTaskReference ?? null }
        : {}),
      ...(options.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
      event,
    });
  }

  private fail(
    workflow: ClaimedCreateWorkflow,
    failure: InstanceMutationFailedV1['data']['failure'],
  ): Promise<void> {
    return this.finishFailure(workflow, failure, 'failed');
  }

  private manualReview(
    workflow: ClaimedCreateWorkflow,
    failure: InstanceMutationFailedV1['data']['failure'],
  ): Promise<void> {
    return this.finishFailure(workflow, failure, 'manual_review');
  }

  private async finishFailure(
    workflow: ClaimedCreateWorkflow,
    failure: InstanceMutationFailedV1['data']['failure'],
    status: 'failed' | 'manual_review',
  ): Promise<void> {
    const event: InstanceMutationFailedV1 = {
      ...this.envelope(workflow, 'instance.mutation.failed'),
      data: {
        action: 'create_instance',
        failure,
        compensationState: status === 'manual_review' ? 'unsafe' : 'not_required',
      },
    };
    await this.store.complete({
      operationId: workflow.command.operationId,
      workerId: this.workerId,
      fencingToken: workflow.fencingToken,
      status,
      event,
    });
  }

  private context(workflow: ClaimedCreateWorkflow, step: string): ProviderCallContext {
    const command = workflow.command;
    return {
      requestId: `${command.operationId}:${step}`,
      operationId: command.operationId,
      correlationId: command.correlationId,
      projectId: command.projectId,
      instanceId: command.aggregateId,
      providerProfileId: command.data.providerProfileId,
      // Phase 3 does not persist per-stage retry counters, so keep mutation identity stable.
      attempt: 1,
    };
  }

  private ownership(workflow: ClaimedCreateWorkflow): OwnershipMarkers {
    return {
      managedBy: 'private-cloud-control-plane',
      environment: 'lab',
      projectId: workflow.command.projectId,
      instanceId: workflow.command.aggregateId,
      createOperationId: workflow.command.operationId,
    };
  }

  private envelope<SchemaName extends string>(
    workflow: ClaimedCreateWorkflow,
    schemaName: SchemaName,
  ) {
    const command = workflow.command;
    return {
      eventId: randomUUID(),
      schemaName,
      schemaVersion: 1 as const,
      aggregateType: 'instance' as const,
      aggregateId: command.aggregateId,
      projectId: command.projectId,
      operationId: command.operationId,
      correlationId: command.correlationId,
      causationId: command.eventId,
      occurredAt: new Date().toISOString(),
      traceContext: command.traceContext,
      partitionKey: command.partitionKey,
    };
  }

  private requiredResource(workflow: ClaimedCreateWorkflow): string {
    if (!workflow.providerResourceId) {
      throw new ProviderTransportError('protocol_error', 'Provider resource ID is missing.', {
        retryable: false,
      });
    }
    return workflow.providerResourceId;
  }

  private failureValue(
    providerFailure: ProviderFailure | undefined,
    defaultCode: string,
  ): InstanceMutationFailedV1['data']['failure'] {
    return {
      category: providerFailureCategory(providerFailure?.category),
      code: providerFailure?.code ?? defaultCode,
      safeMessage: providerFailure?.safeMessage ?? 'The provider operation failed.',
      ...(providerFailure?.retryAfterMilliseconds
        ? { retryAfterMilliseconds: Number(providerFailure.retryAfterMilliseconds) }
        : {}),
    };
  }
}
