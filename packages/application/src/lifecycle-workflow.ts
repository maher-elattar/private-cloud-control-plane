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
  type InstanceCreateRequestedV1,
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
  type LifecycleProviderPort,
} from '@private-cloud/provider-sdk';
import type { ClaimedWorkflow, LifecycleCommand, WorkflowStore } from './ports.js';
import { NOOP_APPLICATION_TELEMETRY, type ApplicationTelemetry } from './telemetry.js';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';

/** Default lease length for one claim. Must sit inside the store's permitted 5-300 seconds. */
const DEFAULT_LEASE_SECONDS = 30;

/** Pause before re-polling a provider task that is still queued or running. */
const TASK_POLL_DELAY_MS = 500;

/** Phase 4 workflow recovery policy. Attempts and time are both bounded. */
const MAXIMUM_RETRY_ATTEMPTS = 8;
const RETRY_BUDGET_MS = 15 * 60 * 1_000;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_CEILING_MS = 30_000;

/** Injectable nondeterminism used to verify retry boundaries without real sleeps. */
export interface WorkflowRecoveryOptions {
  readonly now?: () => Date;
  readonly random?: () => number;
}

/**
 * Stages whose provider call *changes* something on the provider.
 *
 * WHY this list exists: it decides whether a transport failure can be retried. See
 * {@link CreateInstanceWorkflow.handleProviderError}.
 */
/**
 * Stages of the create capability whose failure could have applied a provider effect.
 *
 * Declared per capability rather than globally: which stages are mutations is the single most
 * safety-critical fact about a workflow, because `handleProviderError` routes a failure in one of
 * these to `manual_review` instead of retrying it. A capability that inherited the wrong set would
 * retry a mutation that may already have been applied — the exact path to a duplicated destructive
 * operation. Every capability must state its own, and test it.
 */
const CREATE_MUTATION_STAGES: readonly WorkflowStage[] = [
  'submitting_create',
  'configuring',
  'starting',
];

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
/**
 * The reusable half of a persisted lifecycle saga.
 *
 * PATTERN — Template method over a persisted saga. Everything a capability shares lives here:
 * claiming under a lease, classifying a provider outcome, bounded retry with full jitter, governed
 * dead-lettering, checkpointing, and the ownership and envelope construction that make a
 * transition attributable. A capability supplies only its own stage table, its mutation stages,
 * and the provider calls each stage makes.
 *
 * WHY a base class rather than a shared function library: `handleProviderError` has to know which
 * stages of *this* capability are mutations, and that is the single most safety-critical fact a
 * workflow carries. Making it an abstract member forces every capability to state it explicitly
 * rather than inherit a default that might be wrong for it.
 *
 * @see docs/architecture/glossary.md#persisted-saga-workflow-state-machine
 * @see docs/architecture/safety-invariants.md
 */
export abstract class LifecycleWorkflow<
  TProvider extends LifecycleProviderPort = LifecycleProviderPort,
  TCommand extends LifecycleCommand = LifecycleCommand,
> {
  /** The capability this workflow implements; the registry routes claims on it. */
  public abstract readonly action: WorkflowAction;

  /**
   * Stages whose failure could have applied a provider effect.
   *
   * Declared per capability, never inherited. `handleProviderError` routes a failure in one of
   * these to `manual_review` instead of retrying, so a capability that inherited another's set
   * would retry a mutation that may already have been applied.
   */
  protected abstract readonly mutationStages: readonly WorkflowStage[];

  /**
   * @param store Leased, fenced workflow persistence.
   * @param provider The provider boundary. In practice a gRPC client to the provider service,
   *   which in turn runs either the deterministic fake or the Proxmox adapter.
   * @param workerId Identity claimed on leases. Must be stable for one process and unique
   *   across processes, or two workers could mistake each other's leases for their own.
   * @param telemetry Application telemetry used for durable-stage spans and metrics.
   */
  public constructor(
    protected readonly store: WorkflowStore,
    protected readonly provider: TProvider,
    protected readonly workerId: string,
    protected readonly telemetry: ApplicationTelemetry = NOOP_APPLICATION_TELEMETRY,
    protected readonly recovery: WorkflowRecoveryOptions = {},
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
    // Scoped to this capability's action. WHY not claim anything ready and check afterwards: the
    // claim takes the lease and increments the fencing token, so a claim this executor cannot
    // execute would strand the workflow until its lease expired. The registry rotates between
    // executors, so an unscoped claim meant every capability fought over every workflow.
    const workflow = await this.store.claimNext(this.workerId, leaseSeconds, this.action);
    if (!workflow) return false;
    if (workflow.action !== this.action) {
      // WHY throw rather than skip: the claim already incremented the fencing token and took the
      // lease, so silently returning would strand the workflow until the lease expires. A worker
      // reaching here means the registry routed a claim to the wrong capability, which is a
      // wiring bug that must be loud.
      throw new Error(
        `Workflow ${workflow.command.operationId} has action ${workflow.action}, not ${this.action}.`,
      );
    }
    await this.telemetry.trace(
      'controlplane.workflow.stage',
      {
        'workflow.stage': workflow.stage,
        'cloud.project.id': workflow.command.projectId,
        'cloud.resource.id': workflow.command.aggregateId,
        'controlplane.operation.id': workflow.command.operationId,
        'workflow.attempt': workflow.attempt,
      },
      async () => {
        try {
          // Narrowed here, justified by the action check above: the registry guarantees only this
          // capability's workflows reach this executor.
          await this.execute(workflow as unknown as ClaimedWorkflow<TCommand>);
        } catch (error: unknown) {
          // Only transport failures are classified here. Anything else is a bug in this process
          // and is rethrown so the worker logs it, rather than being recorded as a provider fault.
          if (!(error instanceof ProviderTransportError)) throw error;
          await this.handleProviderError(workflow as unknown as ClaimedWorkflow<TCommand>, error);
        }
      },
      workflow.traceContext,
    );
    return true;
  }

  /**
   * Checks an in-flight asynchronous provider task.
   *
   * Read-only, so unlike the mutation stages this is safe to repeat freely.
   */
  protected async pollTask(
    workflow: ClaimedWorkflow<TCommand>,
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
  protected async handleMutationResult(
    workflow: ClaimedWorkflow<TCommand>,
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
  protected async handleTaskResult(
    workflow: ClaimedWorkflow<TCommand>,
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
  protected async handleProviderError(
    workflow: ClaimedWorkflow<TCommand>,
    error: ProviderTransportError,
  ): Promise<void> {
    const isMutationStage = this.mutationStages.includes(workflow.stage);
    if (isMutationStage && error.code !== 'protocol_error') {
      await this.manualReview(workflow, {
        category: 'unknown_outcome',
        code: `PROVIDER_${error.code.toUpperCase()}`,
        safeMessage: 'The mutation transport failed and its provider outcome is unknown.',
      });
      return;
    }
    if (error.retryable) {
      this.telemetry.workflowRetry(workflow.stage, error.code);
      await this.retryOrDeadLetter(workflow, error);
      return;
    }
    await this.fail(workflow, {
      category: 'permanent',
      code: 'PROVIDER_PROTOCOL_ERROR',
      safeMessage: 'The create workflow could not continue safely.',
    });
  }

  /** Applies the persisted eight-attempt, 15-minute full-jitter recovery policy. */
  protected async retryOrDeadLetter(
    workflow: ClaimedWorkflow<TCommand>,
    error: ProviderTransportError,
  ): Promise<void> {
    return this.telemetry.trace(
      'controlplane.workflow.retry_decision',
      { 'workflow.stage': workflow.stage, 'error.category': error.code },
      async () => {
        const now = this.recovery.now?.() ?? new Date();
        const retryStartedAt = workflow.retryStartedAt ?? now;
        const stageAttempt = workflow.stageAttempt + 1;
        const remainingBudgetMs = retryStartedAt.getTime() + RETRY_BUDGET_MS - now.getTime();

        if (stageAttempt >= MAXIMUM_RETRY_ATTEMPTS || remainingBudgetMs <= 0) {
          const failure: InstanceMutationFailedV1['data']['failure'] = {
            category: 'transient',
            code: 'WORKFLOW_RETRY_EXHAUSTED',
            safeMessage:
              'The provider remained unavailable until the workflow retry policy expired.',
          };
          const event: InstanceMutationFailedV1 = {
            ...this.envelope(workflow, 'instance.mutation.failed'),
            data: {
              // The executing capability, not create: a power or resize failure that
              // reported itself as a create failure would be projected against the wrong action.
              action: this.action,
              failure,
              compensationState: 'not_required',
            },
          };
          await this.telemetry.trace(
            'controlplane.dead_letter.persist',
            { 'event.schema.name': event.schemaName, 'failure.code': failure.code },
            () =>
              this.store.deadLetterWorkflow({
                operationId: workflow.command.operationId,
                workerId: this.workerId,
                fencingToken: workflow.fencingToken,
                attempts: stageAttempt,
                failureCode: failure.code,
                safeMessage: failure.safeMessage,
                lastErrorCategory: 'provider_transport',
                lastErrorCode: error.code,
                event,
              }),
          );
          this.telemetry.deadLetter(event.schemaName, error.code, true);
          this.telemetry.workflowTransition(workflow.stage, 'failed');
          return;
        }

        const exponentialCeiling = Math.min(
          RETRY_BACKOFF_CEILING_MS,
          RETRY_BACKOFF_BASE_MS * 2 ** (stageAttempt - 1),
        );
        const random = this.recovery.random?.() ?? Math.random();
        if (!Number.isFinite(random) || random < 0 || random >= 1) {
          throw new Error('Workflow retry random source must return a value in [0, 1).');
        }
        const delayMs = Math.min(Math.floor(random * exponentialCeiling), remainingBudgetMs);
        await this.progress(workflow, workflow.stage, {
          nextAttemptAt: new Date(now.getTime() + delayMs),
          operationState: 'retry_wait',
          retry: {
            attempt: stageAttempt,
            startedAt: retryStartedAt,
            errorCategory: 'provider_transport',
            errorCode: error.code,
          },
        });
      },
    );
  }

  /**
   * Commits a stage transition and its explaining event, then releases the lease.
   *
   * The spread-conditional style throughout keeps optional fields *absent* rather than
   * `undefined`. That matters twice: the event contract rejects explicit `undefined`, and the
   * store distinguishes "leave the task reference alone" (omitted) from "clear it" (`null`).
   */
  protected async progress(
    workflow: ClaimedWorkflow<TCommand>,
    stage: WorkflowStage,
    options: {
      readonly providerResourceId?: string;
      readonly providerTaskReference?: string | null;
      readonly nextAttemptAt?: Date;
      readonly operationState?: WorkflowProgressedV1['data']['operationState'];
      readonly retry?: {
        readonly attempt: number;
        readonly startedAt: Date;
        readonly errorCategory: string;
        readonly errorCode: string;
      };
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
    await this.telemetry.trace(
      'controlplane.transaction.workflow_checkpoint',
      { 'workflow.stage.from': workflow.stage, 'workflow.stage.to': stage },
      () =>
        this.store.checkpoint({
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
          ...(options.retry ? { retry: options.retry } : {}),
          event,
        }),
    );
    this.telemetry.workflowTransition(workflow.stage, stage);
  }

  /** Terminates the workflow as failed: nothing was built, or nothing can be. */
  protected fail(
    workflow: ClaimedWorkflow<TCommand>,
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
  protected manualReview(
    workflow: ClaimedWorkflow<TCommand>,
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
  protected async finishFailure(
    workflow: ClaimedWorkflow<TCommand>,
    failure: InstanceMutationFailedV1['data']['failure'],
    status: 'failed' | 'manual_review',
  ): Promise<void> {
    const event: InstanceMutationFailedV1 = {
      ...this.envelope(workflow, 'instance.mutation.failed'),
      data: {
        // The executing capability, not create: a power or resize failure that
        // reported itself as a create failure would be projected against the wrong action.
        action: this.action,
        failure,
        compensationState: status === 'manual_review' ? 'unsafe' : 'not_required',
      },
    };
    await this.telemetry.trace(
      'controlplane.workflow.compensation_decision',
      { 'compensation.state': event.data.compensationState, 'workflow.outcome': status },
      () =>
        this.telemetry.trace(
          'controlplane.transaction.workflow_completion',
          { 'workflow.outcome': status },
          () =>
            this.store.complete({
              operationId: workflow.command.operationId,
              workerId: this.workerId,
              fencingToken: workflow.fencingToken,
              status,
              event,
            }),
        ),
    );
    this.telemetry.workflowTransition(workflow.stage, status);
  }

  /**
   * Builds the per-call context, including the provider-facing request identity.
   *
   * `requestId` is derived from operation and step rather than randomly generated, so a
   * replay after a crash presents the *same* identity. That is what lets a provider recognise
   * the retry as a duplicate instead of building a second VM — the client half of the
   * idempotency contract.
   */
  protected context(workflow: ClaimedWorkflow<TCommand>, step: string): ProviderCallContext {
    const command = workflow.command;
    return {
      requestId: `${command.operationId}:${step}`,
      operationId: command.operationId,
      correlationId: command.correlationId,
      projectId: command.projectId,
      instanceId: command.aggregateId,
      providerProfileId: this.providerProfileId(workflow),
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
  protected ownership(workflow: ClaimedWorkflow<TCommand>): OwnershipMarkers {
    return {
      managedBy: 'private-cloud-control-plane',
      environment: 'lab',
      projectId: workflow.command.projectId,
      instanceId: workflow.command.aggregateId,
      createOperationId: this.createOperationId(workflow),
    };
  }

  /**
   * Common event envelope fields.
   *
   * `causationId` points at the command's event ID, so the chain from request to outcome can
   * be walked backwards. `partitionKey` is the instance, which is what will preserve
   * per-instance ordering once Kafka replaces the poller in Phase 4.
   */
  protected envelope<SchemaName extends string>(
    workflow: ClaimedWorkflow<TCommand>,
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
      traceContext: this.telemetry.currentTraceContext(workflow.traceContext),
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
  protected requiredResource(workflow: ClaimedWorkflow<TCommand>): string {
    if (!workflow.providerResourceId) {
      throw new ProviderTransportError('protocol_error', 'Provider resource ID is missing.', {
        retryable: false,
      });
    }
    return workflow.providerResourceId;
  }

  /** Converts a provider failure into contract form, substituting safe defaults. */
  protected failureValue(
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
  /**
   * The capability's transition table: performs exactly one step from the persisted stage.
   *
   * Implementations must complete, fail, or checkpoint the workflow on every path. Returning
   * without doing one of those leaves the workflow claimed but unadvanced until its lease expires.
   */
  protected abstract execute(workflow: ClaimedWorkflow<TCommand>): Promise<void>;

  /**
   * The provider profile every call for this workflow is scoped to.
   *
   * Abstract because each command carries it in its own payload. It is not derived from the
   * instance record: the orchestrator must not read control-plane-owned tables, and the profile
   * that a workflow was accepted against must not silently change under it mid-flight.
   */
  protected abstract providerProfileId(workflow: ClaimedWorkflow<TCommand>): string;

  /**
   * The operation whose id is written into the provider ownership markers.
   *
   * WHY abstract rather than `workflow.command.operationId`: the markers are written once, at
   * create, and re-checked on every later call. A capability that presented its *own* operation id
   * would fail the check against every VM it did not itself create — which is every VM. Only the
   * create workflow may use its own id here.
   */
  protected abstract createOperationId(workflow: ClaimedWorkflow<TCommand>): string;
}

/**
 * The create-instance capability.
 *
 * Roughly eight provider interactions spanning minutes: submit, poll, configure, poll, start,
 * poll, then prove ownership by observation before reporting success.
 */
export class CreateInstanceWorkflow extends LifecycleWorkflow<
  CreateInstanceProviderPort,
  InstanceCreateRequestedV1
> {
  public readonly action: WorkflowAction = 'create_instance';

  protected readonly mutationStages: readonly WorkflowStage[] = CREATE_MUTATION_STAGES;

  /** The profile the request was accepted against, carried on the create command. */
  protected providerProfileId(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>): string {
    return workflow.command.data.providerProfileId;
  }

  /** Create is the one capability whose own operation id *is* the create operation id. */
  protected createOperationId(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>): string {
    return workflow.command.operationId;
  }

  /**
   * The transition table: dispatches on the persisted stage.
   *
   * Read alongside the stage table in `workflow-stage.ts`. Because `stage` is a union rather
   * than a string, adding a stage without handling it here is a compile error.
   */
  protected async execute(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>): Promise<void> {
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
  protected async submitCreate(
    workflow: ClaimedWorkflow<InstanceCreateRequestedV1>,
  ): Promise<void> {
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
  protected async configure(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>): Promise<void> {
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
  protected async start(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>): Promise<void> {
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
  protected async observe(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>): Promise<void> {
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
        // WHY carry the observation rather than let the read model infer it: the projection
        // otherwise has to guess measured CPU, memory, and disk, and would publish the *desired*
        // sizing as though it had been confirmed. Desired and observed disagreeing is exactly the
        // drift the reconciler exists to find, so the read model must never conflate them.
        observed: observedState(observation),
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

  /** Desired sizing from the accepted command. Stringified where the wire type is 64-bit. */
  protected resources(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>) {
    const resources = workflow.command.data.resources;
    return {
      cpuCount: resources.cpuCount,
      memoryMib: String(resources.memoryMiB),
      diskGib: String(resources.diskGiB),
    };
  }

  /** Network attachment fixed at acceptance, when the address was reserved. */
  protected network(workflow: ClaimedWorkflow<InstanceCreateRequestedV1>) {
    const data = workflow.command.data;
    return {
      networkId: data.networkId,
      ipv4Address: data.ipv4.address,
      ipv4PrefixLength: data.ipv4.prefixLength,
      ipv4Gateway: data.ipv4.gateway,
      dnsServers: [...data.ipv4.dnsServers],
    };
  }
}
/**
 * Converts a provider observation into the event contract's observed block.
 *
 * `resources` is omitted rather than defaulted when the provider did not report sizing. An absent
 * measurement and a measurement of zero are different claims, and only one of them is ever true.
 */
function observedState(
  observation: NonNullable<
    Awaited<ReturnType<CreateInstanceProviderPort['observeInstance']>>['observation']
  >,
): NonNullable<InstanceMutationCompletedV1['data']['observed']> {
  const resources = observation.resources;
  return {
    exists: Boolean(observation.exists),
    powerState: observedPowerState(observation.powerState),
    ...(resources && resources.cpuCount !== undefined
      ? {
          resources: {
            cpuCount: resources.cpuCount,
            memoryMiB: Number(resources.memoryMib),
            diskGiB: Number(resources.diskGib),
          },
        }
      : {}),
    markerMatch: Boolean(observation.ownership?.match),
    observedAt: observation.observedAt ?? new Date().toISOString(),
  };
}

/** Maps the provider enum onto the event contract's observed power vocabulary. */
function observedPowerState(
  value: ObservedPowerState | undefined,
): NonNullable<InstanceMutationCompletedV1['data']['observed']>['powerState'] {
  switch (value) {
    case ObservedPowerState.OBSERVED_POWER_STATE_RUNNING:
      return 'running';
    case ObservedPowerState.OBSERVED_POWER_STATE_STOPPED:
      return 'stopped';
    case ObservedPowerState.OBSERVED_POWER_STATE_SUSPENDED:
      return 'suspended';
    default:
      return 'unknown';
  }
}
