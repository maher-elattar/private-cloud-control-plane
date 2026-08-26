/**
 * The create-instance workflow — the provisioning saga.
 *
 * PATTERN — Persisted saga. Building a VM takes minutes and roughly eight provider
 * interactions. Rather than hold that in one long `async` function, each step is a *stage*
 * committed to the database, so a worker that dies mid-provision loses nothing: another
 * worker claims the instance and resumes from the last committed stage.
 *
 * Framework-independent by design — this class has no NestJS import and is driven by
 * `ProvisioningWorker` in `apps/provisioning-orchestrator`, which does nothing but call
 * {@link CreateInstanceWorkflow.runOne} on a timer.
 *
 * **The safety rule that shapes every branch below:** a failed create must never be retried
 * blindly, because a retry might build a *second* VM. Wherever the outcome of a provider
 * mutation is unknown, this code stops and asks for a human rather than guessing. No path
 * here automatically stops, deletes, or purges anything.
 *
 * @see docs/architecture/glossary.md#persisted-saga-workflow-state-machine
 * @see docs/architecture/safety-invariants.md
 * @see docs/architecture/phase-3-vertical-slice.md
 */
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
import type { WorkflowStage } from './workflow-stage.js';

/** Default lease length for one claim. Must sit inside the store's permitted 5-300 seconds. */
const DEFAULT_LEASE_SECONDS = 30;

/** Pause before re-polling a provider task that is still queued or running. */
const TASK_POLL_DELAY_MS = 500;

/** Backoff added per attempt after a retryable transport failure. */
const RETRY_BACKOFF_STEP_MS = 500;

/**
 * Ceiling on retry backoff.
 *
 * Deliberately short: the orchestrator is the only thing driving provisioning forward, so a
 * long backoff stalls a create that would otherwise succeed. Provider rate limiting is
 * handled by the provider's own `retryAfterMilliseconds`, not by this value.
 */
const RETRY_BACKOFF_CEILING_MS = 5_000;

/**
 * Stages whose provider call *changes* something on the provider.
 *
 * WHY this list exists: it decides whether a transport failure can be retried. See
 * {@link CreateInstanceWorkflow.handleProviderError}.
 */
const MUTATION_STAGES: readonly WorkflowStage[] = ['submitting_create', 'configuring', 'starting'];

/**
 * Translates a provider's failure category into the event contract's vocabulary.
 *
 * Validation and quota both collapse to `validation`, and authentication and authorization
 * both to `authorization`, because the control plane's response to each pair is identical.
 *
 * WHY the `default` is `permanent` rather than `transient`: an unrecognised category is an
 * unknown, and retrying an unknown mutation risks a duplicate VM. Refusing to retry is the
 * conservative reading.
 */
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

/**
 * Executes one persisted workflow transition per call.
 *
 * The caller must claim again before the next step — see {@link CreateInstanceWorkflow.runOne}.
 */
export class CreateInstanceWorkflow {
  /**
   * @param store Leased, fenced workflow persistence.
   * @param provider The provider boundary. In practice a gRPC client to the provider service,
   *   which in turn runs either the deterministic fake or the Proxmox adapter.
   * @param workerId Identity claimed on leases. Must be stable for one process and unique
   *   across processes, or two workers could mistake each other's leases for their own.
   */
  public constructor(
    private readonly store: WorkflowStore,
    private readonly provider: CreateInstanceProviderPort,
    private readonly workerId: string,
  ) {}

  /**
   * Claims one workflow, performs exactly one transition, and returns.
   *
   * WHY only one transition per claim: each transition commits its own checkpoint and then
   * releases the lease. Looping inside a single claim would hold the lease across several
   * provider calls, so a crash partway would leave the instance locked until expiry, and the
   * committed stage would lag behind what the provider had actually been asked to do.
   *
   * @returns `true` when a workflow was claimed — poll again immediately, there may be more
   *   work — or `false` when nothing was ready and the caller should back off.
   */
  public async runOne(leaseSeconds = DEFAULT_LEASE_SECONDS): Promise<boolean> {
    const workflow = await this.store.claimNextCreate(this.workerId, leaseSeconds);
    if (!workflow) return false;
    try {
      await this.execute(workflow);
    } catch (error: unknown) {
      // Only transport failures are classified here. Anything else is a bug in this process
      // and is rethrown so the worker logs it, rather than being recorded as a provider fault.
      if (!(error instanceof ProviderTransportError)) throw error;
      await this.handleProviderError(workflow, error);
    }
    return true;
  }

  /**
   * The transition table: dispatches on the persisted stage.
   *
   * Read alongside the stage table in `workflow-stage.ts`. Because `stage` is a union rather
   * than a string, adding a stage without handling it here is a compile error.
   */
  private async execute(workflow: ClaimedCreateWorkflow): Promise<void> {
    switch (workflow.stage) {
      case 'accepted':
        // No provider call — just move off the initial stage, so the very first checkpoint
        // proves the workflow was picked up before anything external happens.
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

  /** Asks the provider to create the VM. First stage that changes provider state. */
  private async submitCreate(workflow: ClaimedCreateWorkflow): Promise<void> {
    const command = workflow.command;
    const result = (
      await this.provider.submitCreateInstance({
        context: this.context(workflow, 'create'),
        imageId: command.data.imageId,
        flavorId: command.data.flavorId,
        hostname: command.data.hostname,
        resources: this.resources(workflow),
        network: this.network(workflow),
        sshPublicKeys: [...(command.data.sshPublicKeys ?? [])],
        ownershipMarkers: this.ownership(workflow),
      })
    ).result;
    await this.handleMutationResult(workflow, result, 'polling_create', 'configuring');
  }

  /** Applies CPU, memory, network, and SSH configuration to the created VM. */
  private async configure(workflow: ClaimedCreateWorkflow): Promise<void> {
    const command = workflow.command;
    const result = (
      await this.provider.applyInstanceConfiguration({
        context: this.context(workflow, 'configure'),
        providerResourceId: this.requiredResource(workflow),
        hostname: command.data.hostname,
        resources: this.resources(workflow),
        network: this.network(workflow),
        sshPublicKeys: [...(command.data.sshPublicKeys ?? [])],
        ownershipMarkers: this.ownership(workflow),
      })
    ).result;
    await this.handleMutationResult(workflow, result, 'polling_configuration', 'starting');
  }

  /** Powers the VM on. The accepted command always requests a running instance. */
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

  /**
   * Checks an in-flight asynchronous provider task.
   *
   * Read-only, so unlike the mutation stages this is safe to repeat freely.
   */
  private async pollTask(
    workflow: ClaimedCreateWorkflow,
    successStage: WorkflowStage,
  ): Promise<void> {
    const taskReference = workflow.providerTaskReference;
    if (!taskReference) {
      // The stage says a task is in flight but its handle was not persisted, so there is no
      // way to discover what the provider did. Retrying the mutation could duplicate it.
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

  /**
   * Proves the VM exists, is ours, and is running — then completes the operation.
   *
   * WHY a separate observation stage rather than trusting the start call: a successful
   * mutation response says the provider accepted the request, not that the result is what was
   * asked for. Ownership markers are re-checked here so a VMID collision or an operator's
   * manual edit cannot be mistaken for our instance.
   *
   * Anything short of complete proof goes to `manual_review`, never to `failed` — a create
   * that may have partially succeeded must not be reported as if nothing happened.
   */
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

  /**
   * Interprets the outcome of a provider mutation and picks the next stage.
   *
   * Providers may answer a mutation in one of three useful ways, and each needs a different
   * next step:
   *
   * - `ACCEPTED` — work is queued; move to `acceptedStage` and poll the returned task.
   * - `SUCCEEDED` — work is already done; skip polling and move to `synchronousStage`.
   * - `REJECTED` — the provider refused; nothing was built, so failing is safe.
   *
   * `UNKNOWN` is the dangerous one and goes to `manual_review`: the provider is telling us it
   * cannot say whether the mutation took effect, and no automated choice is safe.
   */
  private async handleMutationResult(
    workflow: ClaimedCreateWorkflow,
    result: ProviderMutationResult | undefined,
    acceptedStage: WorkflowStage,
    synchronousStage: WorkflowStage,
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

    // Fall back to the persisted ID because only the create stage returns one; `configuring`
    // and `starting` act on a resource that was already identified.
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
        // Asynchronous work we cannot track. Failing here is safe only because the resource ID
        // is persisted alongside, leaving an operator something to find.
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

  /**
   * Interprets a task poll and either waits, advances, or terminates.
   *
   * A still-running task re-checkpoints the *same* stage with a delay. That looks like a
   * no-op but is not: it refreshes the lease and pushes out `next_attempt_at`, so the
   * instance stays claimed and other work is not starved by a tight poll loop.
   *
   * `UNKNOWN` means the provider has forgotten the task — common when a task ages out of the
   * provider's history. Since the mutation may well have succeeded, this goes to
   * `manual_review` rather than being retried.
   */
  private async handleTaskResult(
    workflow: ClaimedCreateWorkflow,
    response: GetTaskResponse,
    successStage: WorkflowStage,
    taskReference: string,
  ): Promise<void> {
    if (
      response.state === ProviderTaskState.PROVIDER_TASK_STATE_QUEUED ||
      response.state === ProviderTaskState.PROVIDER_TASK_STATE_RUNNING
    ) {
      await this.progress(workflow, workflow.stage, {
        providerTaskReference: taskReference,
        nextAttemptAt: new Date(Date.now() + TASK_POLL_DELAY_MS),
      });
      return;
    }
    if (response.state === ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED) {
      // Clear the task reference explicitly: leaving a completed handle behind would make a
      // later stage look like it had work in flight.
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

  /**
   * Classifies a transport failure — the single most safety-critical decision here.
   *
   * The question is never "did the call fail?" but "did the provider act before it failed?".
   *
   * A timeout or connection reset on a **mutation** cannot answer that: the request may have
   * arrived and built a VM whose response never came back. Retrying could produce a second
   * VM, so these go to `manual_review`.
   *
   * A `protocol_error` is the exception: a malformed request was rejected before any action,
   * so it is safe to treat as an ordinary failure. Read-only stages are likewise safe to
   * retry, since repeating a `GetTask` changes nothing.
   *
   * @see docs/architecture/failure-sequences.md
   */
  private async handleProviderError(
    workflow: ClaimedCreateWorkflow,
    error: ProviderTransportError,
  ): Promise<void> {
    const isMutationStage = MUTATION_STAGES.includes(workflow.stage);
    if (isMutationStage && error.code !== 'protocol_error') {
      await this.manualReview(workflow, {
        category: 'unknown_outcome',
        code: `PROVIDER_${error.code.toUpperCase()}`,
        safeMessage: 'The mutation transport failed and its provider outcome is unknown.',
      });
      return;
    }
    if (error.retryable) {
      await this.progress(workflow, workflow.stage, {
        nextAttemptAt: new Date(
          Date.now() + Math.min(RETRY_BACKOFF_CEILING_MS, workflow.attempt * RETRY_BACKOFF_STEP_MS),
        ),
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

  /**
   * Commits a stage transition and its explaining event, then releases the lease.
   *
   * The spread-conditional style throughout keeps optional fields *absent* rather than
   * `undefined`. That matters twice: the event contract rejects explicit `undefined`, and the
   * store distinguishes "leave the task reference alone" (omitted) from "clear it" (`null`).
   */
  private async progress(
    workflow: ClaimedCreateWorkflow,
    stage: WorkflowStage,
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
      // Carry the existing resource ID forward when this transition does not supply one, so a
      // later stage does not lose the handle to the VM that was already created.
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

  /** Terminates the workflow as failed: nothing was built, or nothing can be. */
  private fail(
    workflow: ClaimedCreateWorkflow,
    failure: InstanceMutationFailedV1['data']['failure'],
  ): Promise<void> {
    return this.finishFailure(workflow, failure, 'failed');
  }

  /**
   * Terminates the workflow for human attention.
   *
   * Used whenever a VM may exist that this process cannot prove or disprove. It is not a
   * worse `fail` — it is a different claim: `failed` asserts nothing was left behind, and
   * `manual_review` explicitly declines to assert that.
   */
  private manualReview(
    workflow: ClaimedCreateWorkflow,
    failure: InstanceMutationFailedV1['data']['failure'],
  ): Promise<void> {
    return this.finishFailure(workflow, failure, 'manual_review');
  }

  /**
   * Writes the terminal failure event.
   *
   * `compensationState` is `unsafe` for manual review because the control plane will not
   * clean up after an outcome it could not determine — deleting a VM that might be someone's
   * running workload is worse than leaving an orphan for an operator to inspect.
   */
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

  /**
   * Builds the per-call context, including the provider-facing request identity.
   *
   * `requestId` is derived from operation and step rather than randomly generated, so a
   * replay after a crash presents the *same* identity. That is what lets a provider recognise
   * the retry as a duplicate instead of building a second VM — the client half of the
   * idempotency contract.
   */
  private context(workflow: ClaimedCreateWorkflow, step: string): ProviderCallContext {
    const command = workflow.command;
    return {
      requestId: `${command.operationId}:${step}`,
      operationId: command.operationId,
      correlationId: command.correlationId,
      projectId: command.projectId,
      instanceId: command.aggregateId,
      providerProfileId: command.data.providerProfileId,
      // WHY hardcoded: `requestId` must be byte-identical across replays for the provider to
      // recognise a duplicate. Phase 3 keeps only a per-claim counter, not a per-stage one, so
      // a real attempt number here would change between replays and defeat that recognition.
      attempt: 1,
    };
  }

  /**
   * Labels identifying this control plane as the owner of the provider resource.
   *
   * Written on create and re-checked on every later call. This is how the system refuses to
   * touch a VM it did not create, and how it recognises its own resource after a replay.
   */
  private ownership(workflow: ClaimedCreateWorkflow): OwnershipMarkers {
    return {
      managedBy: 'private-cloud-control-plane',
      environment: 'lab',
      projectId: workflow.command.projectId,
      instanceId: workflow.command.aggregateId,
      createOperationId: workflow.command.operationId,
    };
  }

  /** Desired sizing from the accepted command. Stringified where the wire type is 64-bit. */
  private resources(workflow: ClaimedCreateWorkflow) {
    const resources = workflow.command.data.resources;
    return {
      cpuCount: resources.cpuCount,
      memoryMib: String(resources.memoryMiB),
      diskGib: String(resources.diskGiB),
    };
  }

  /** Network attachment fixed at acceptance, when the address was reserved. */
  private network(workflow: ClaimedCreateWorkflow) {
    const data = workflow.command.data;
    return {
      networkId: data.networkId,
      ipv4Address: data.ipv4.address,
      ipv4PrefixLength: data.ipv4.prefixLength,
      ipv4Gateway: data.ipv4.gateway,
      dnsServers: [...data.ipv4.dnsServers],
    };
  }

  /**
   * Common event envelope fields.
   *
   * `causationId` points at the command's event ID, so the chain from request to outcome can
   * be walked backwards. `partitionKey` is the instance, which is what will preserve
   * per-instance ordering once Kafka replaces the poller in Phase 4.
   */
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

  /**
   * Reads the provider resource ID, which must exist by this point in the workflow.
   *
   * WHY it throws `ProviderTransportError` rather than failing the workflow directly: this is
   * an internal inconsistency, not a provider outcome. Raising it routes through
   * {@link CreateInstanceWorkflow.handleProviderError}, which applies the same
   * did-the-provider-act analysis rather than assuming nothing happened.
   */
  private requiredResource(workflow: ClaimedCreateWorkflow): string {
    if (!workflow.providerResourceId) {
      throw new ProviderTransportError('protocol_error', 'Provider resource ID is missing.', {
        retryable: false,
      });
    }
    return workflow.providerResourceId;
  }

  /** Converts a provider failure into contract form, substituting safe defaults. */
  private failureValue(
    providerFailure: ProviderFailure | undefined,
    defaultCode: string,
  ): InstanceMutationFailedV1['data']['failure'] {
    return {
      category: providerFailureCategory(providerFailure?.category),
      code: providerFailure?.code ?? defaultCode,
      // Provider messages are pre-sanitised by the adapter; no vendor detail crosses this
      // boundary into an API response.
      safeMessage: providerFailure?.safeMessage ?? 'The provider operation failed.',
      ...(providerFailure?.retryAfterMilliseconds
        ? { retryAfterMilliseconds: Number(providerFailure.retryAfterMilliseconds) }
        : {}),
    };
  }
}
