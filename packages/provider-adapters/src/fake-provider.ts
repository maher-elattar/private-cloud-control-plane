/**
 * Deterministic in-memory provider used by tests and local runs.
 *
 * Not a toy. This is the only way to reproduce the failure modes the workflow's safety rules
 * exist for: a timeout *after* the provider committed, a duplicate delivery, an ambiguous task
 * result. None of those can be produced reliably against real hardware, and each is exactly
 * the case where a naive retry would build a second VM.
 *
 * Two behaviours make that possible:
 *
 * - **Scripted steps.** `configuration.script` supplies a per-method sequence of outcomes, so
 *   a test can say "the third call to `submitCreateInstance` times out after applying".
 * - **Request deduplication.** A repeated `requestId` replays the cached result instead of
 *   consuming another scripted step or creating another resource — modelling a provider that
 *   honours idempotency, which is what makes a replay after a crash safe.
 *
 * Deliberately in-memory: it models provider *behaviour*, not provider durability.
 *
 * @see docs/adr/0011-provider-port-and-deterministic-fake.md
 * @see docs/architecture/contracts-and-provider-port.md
 */
import { FailureCategory, ObservedPowerState } from '@private-cloud/contracts';
import {
  ProviderResultState,
  ProviderTaskState,
  ValidationCheckState,
  type ApplyInstanceConfigurationRequest,
  type ApplyInstanceConfigurationResponse,
  type CreateSnapshotRequest,
  type CreateSnapshotResponse,
  type DeleteSnapshotRequest,
  type DeleteSnapshotResponse,
  type GetCapabilitiesRequest,
  type GetCapabilitiesResponse,
  type GetTaskRequest,
  type GetTaskResponse,
  type InstanceMutationRequest,
  type InstanceObservation,
  type InstanceResources,
  type ListSnapshotsRequest,
  type ListSnapshotsResponse,
  type MarkInstanceRetainedRequest,
  type MarkInstanceRetainedResponse,
  type NetworkConfiguration,
  type ObserveInstanceRequest,
  type ObserveInstanceResponse,
  type OwnershipMarkers,
  type ProviderCallContext,
  type ProviderMutationResult,
  type ProviderSnapshot,
  type PurgeInstanceRequest,
  type PurgeInstanceResponse,
  type RebootInstanceRequest,
  type RebootInstanceResponse,
  type ResizeInstanceRequest,
  type ResizeInstanceResponse,
  type RollbackSnapshotRequest,
  type RollbackSnapshotResponse,
  type ShutdownInstanceRequest,
  type ShutdownInstanceResponse,
  type StartInstanceRequest,
  type StartInstanceResponse,
  type StopInstanceRequest,
  type StopInstanceResponse,
  type SubmitCreateInstanceRequest,
  type SubmitCreateInstanceResponse,
  type ValidateProfileRequest,
  type ValidateProfileResponse,
} from '@private-cloud/contracts/provider';
import {
  ProviderTransportError,
  type ProviderCallOptions,
  type ProviderMethod,
  type ProviderPort,
} from '@private-cloud/provider-sdk';

/**
 * The outcome a scripted step produces.
 *
 * `timeout` and `unknown-outcome` are the interesting ones: both leave the caller unable to
 * tell whether the mutation took effect, which is precisely the situation the workflow must
 * escalate rather than retry.
 */
export type FakeProviderMode = 'failure' | 'success' | 'timeout' | 'unknown-outcome';

/** One scripted outcome for one call to one method. */
export interface FakeProviderStep {
  readonly mode: FakeProviderMode;
  readonly latencyMs?: number;
  /** Models the dangerous case where the provider committed before the caller lost the response. */
  readonly applyBeforeResponse?: boolean;
  readonly failureCode?: string;
  readonly taskPollsBeforeSuccess?: number;
}

/** How the fake should behave across a test. */
export interface FakeProviderConfiguration {
  readonly defaultLatencyMs?: number;
  readonly defaultTaskPollsBeforeSuccess?: number;
  readonly script?: Partial<Record<ProviderMethod, readonly FakeProviderStep[]>>;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** A recorded call, for asserting what the caller actually did. */
export interface FakeProviderCall {
  readonly sequence: number;
  readonly method: ProviderMethod;
  readonly requestId: string;
  readonly mode: FakeProviderMode;
  readonly duplicate: boolean;
}

/** A VM the fake believes it has created. */
interface FakeResource {
  readonly id: string;
  readonly instanceId: string;
  ownership: OwnershipMarkers;
  resources: InstanceResources;
  network: NetworkConfiguration | undefined;
  powerState: ObservedPowerState;
  retained: boolean;
}

/** An asynchronous task that reports success only after N polls. */
interface FakeTask {
  remainingPolls: number;
  readonly terminalState: ProviderTaskState;
}

/**
 * A previous mutation result, keyed by request ID.
 *
 * `canonicalRequest` is retained so a request ID reused with *different* content is reported
 * as a conflict rather than silently replaying an unrelated result.
 */
interface CachedMutation {
  readonly canonicalRequest: string;
  readonly result: ProviderMutationResult;
}

/** A call context after every required identifier has been checked present. */
interface ValidatedProviderCallContext {
  readonly requestId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly providerProfileId: string;
  readonly attempt: number;
}

/** Used once a method's script is exhausted, so tests only script what they care about. */
const DEFAULT_STEP: FakeProviderStep = { mode: 'success' };

/** Serialises a request for the duplicate-content comparison. */
function requestJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Injectable delay that honours cancellation, so latency can be simulated without real waits. */
function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ProviderTransportError('aborted', 'Provider call was aborted.'));
  }
  if (milliseconds === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new ProviderTransportError('aborted', 'Provider call was aborted.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Stateful provider test double. A stable request ID is deduplicated before another scripted step
 * is consumed, which lets contract tests reproduce Kafka redelivery without duplicating resources.
 *
 * Implements the full `ProviderPort`, not just the Phase 3 subset, so later phases can be
 * developed against it before any adapter supports them.
 */
export class FakeProvider implements ProviderPort {
  readonly #configuration: FakeProviderConfiguration;
  readonly #stepIndexes = new Map<ProviderMethod, number>();
  readonly #mutationCache = new Map<string, CachedMutation>();
  readonly #resources = new Map<string, FakeResource>();
  readonly #resourceByInstance = new Map<string, string>();
  readonly #tasks = new Map<string, FakeTask>();
  readonly #snapshots = new Map<string, Map<string, ProviderSnapshot>>();
  readonly #calls: FakeProviderCall[] = [];
  readonly #logicalMutationCounts = new Map<ProviderMethod, number>();
  #sequence = 0;

  public constructor(configuration: FakeProviderConfiguration = {}) {
    this.#configuration = configuration;
  }

  /** Every call made so far, in order. Assert against this to prove a retry was deduplicated. */
  public get calls(): readonly FakeProviderCall[] {
    return [...this.#calls];
  }

  /**
   * Counts *distinct* mutations for a method, ignoring deduplicated repeats.
   *
   * The key assertion for idempotency tests: a workflow that replays a create must leave this
   * at 1, however many times the call was made.
   */
  public logicalMutationCount(method: ProviderMethod): number {
    return this.#logicalMutationCounts.get(method) ?? 0;
  }

  /** Number of VMs in existence. The blunt check that no duplicate was created. */
  public resourceCount(): number {
    return this.#resources.size;
  }

  /** Reports the profile as usable. Read-only. */
  public async validateProfile(
    request: ValidateProfileRequest,
    options?: ProviderCallOptions,
  ): Promise<ValidateProfileResponse> {
    return this.#query('validateProfile', this.#directRequestId(request.requestId), options, () => {
      const required = [
        ['endpoint', request.profile?.endpoint],
        ['computeTarget', request.profile?.computeTarget],
        ['storageTarget', request.profile?.storageTarget],
        ['networkAttachment', request.profile?.networkAttachment],
        ['credentialReference', request.profile?.credentialReference],
      ] as const;
      const checks = required.map(([name, value]) => ({
        name,
        state: value
          ? ValidationCheckState.VALIDATION_CHECK_STATE_PASSED
          : ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
        safeSummary: value ? `${name} is configured.` : `${name} is required.`,
      }));
      return {
        valid: checks.every(
          (check) => check.state === ValidationCheckState.VALIDATION_CHECK_STATE_PASSED,
        ),
        checks,
        validatedAt: this.#now(),
        validationEvidenceId: this.#nextId('evidence'),
      };
    });
  }

  /** Reports a fixed capability set. Read-only. */
  public async getCapabilities(
    request: GetCapabilitiesRequest,
    options?: ProviderCallOptions,
  ): Promise<GetCapabilitiesResponse> {
    return this.#query(
      'getCapabilities',
      this.#directRequestId(request.requestId),
      options,
      () => ({
        capabilities: {
          createInstance: true,
          configureInstance: true,
          power: true,
          resizeCompute: true,
          growDisk: true,
          snapshots: true,
          retentionMarker: true,
          purge: true,
          maximumCpuCount: 64,
          maximumMemoryMib: '262144',
          maximumDiskGib: '2048',
          maximumSnapshots: 32,
        },
        observedAt: this.#now(),
      }),
    );
  }

  /** Creates a resource, honouring the script and deduplicating repeated request IDs. */
  public async submitCreateInstance(
    request: SubmitCreateInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<SubmitCreateInstanceResponse> {
    const context = this.#context(request.context);
    return {
      result: await this.#mutation(
        'submitCreateInstance',
        context.requestId,
        request,
        options,
        () => {
          const existing = this.#resourceByInstance.get(context.instanceId);
          if (existing) return this.#accepted(existing);

          const resourceId = this.#nextId('resource');
          this.#resources.set(resourceId, {
            id: resourceId,
            instanceId: context.instanceId,
            ownership: this.#ownership(request.ownershipMarkers),
            resources: this.#resourcesValue(request.resources),
            network: request.network,
            powerState: ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
            retained: false,
          });
          this.#resourceByInstance.set(context.instanceId, resourceId);
          return this.#accepted(resourceId);
        },
      ),
    };
  }

  /** Applies configuration to an owned resource. */
  public async applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
    options?: ProviderCallOptions,
  ): Promise<ApplyInstanceConfigurationResponse> {
    const context = this.#context(request.context);
    return {
      result: await this.#mutation(
        'applyInstanceConfiguration',
        context.requestId,
        request,
        options,
        () => {
          const resource = this.#ownedResource(
            request.providerResourceId,
            request.ownershipMarkers,
          );
          if ('failure' in resource) return resource.failure;
          resource.value.resources = this.#resourcesValue(request.resources);
          resource.value.network = request.network;
          return this.#accepted(resource.value.id);
        },
      ),
    };
  }

  /** Reports a task as running until its scripted poll count is exhausted. */
  public async getTask(
    request: GetTaskRequest,
    options?: ProviderCallOptions,
  ): Promise<GetTaskResponse> {
    return this.#query('getTask', this.#context(request.context).requestId, options, () => {
      const task = this.#tasks.get(
        this.#required(request.providerTaskReference, 'providerTaskReference'),
      );
      if (!task) {
        return {
          state: ProviderTaskState.PROVIDER_TASK_STATE_UNKNOWN,
          observedAt: this.#now(),
        };
      }
      if (task.remainingPolls > 0) {
        task.remainingPolls -= 1;
        return {
          state: ProviderTaskState.PROVIDER_TASK_STATE_RUNNING,
          observedAt: this.#now(),
        };
      }
      return { state: task.terminalState, observedAt: this.#now() };
    });
  }

  /** Reports real state and ownership match, or absence. The workflow's completion proof. */
  public async observeInstance(
    request: ObserveInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ObserveInstanceResponse> {
    return this.#query('observeInstance', this.#context(request.context).requestId, options, () => {
      const resourceId =
        request.providerResourceId ??
        this.#resourceByInstance.get(request.context?.instanceId ?? '');
      const resource = resourceId ? this.#resources.get(resourceId) : undefined;
      const observation: InstanceObservation = resource
        ? {
            exists: true,
            providerResourceId: resource.id,
            powerState: resource.powerState,
            resources: resource.resources,
            ...(resource.network ? { network: resource.network } : {}),
            ownership: {
              complete: true,
              match: this.#markersMatch(resource.ownership, request.expectedOwnershipMarkers),
              values: resource.ownership,
            },
            observedAt: this.#now(),
          }
        : {
            exists: false,
            powerState: ObservedPowerState.OBSERVED_POWER_STATE_UNKNOWN,
            ownership: { complete: false, match: false },
            observedAt: this.#now(),
          };
      return { observation };
    });
  }

  /** Powers the resource on. */
  public startInstance(
    request: StartInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StartInstanceResponse> {
    return this.#power(
      'startInstance',
      request.request,
      ObservedPowerState.OBSERVED_POWER_STATE_RUNNING,
      options,
    );
  }

  /** Requests a graceful shutdown. */
  public shutdownInstance(
    request: ShutdownInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ShutdownInstanceResponse> {
    return this.#power(
      'shutdownInstance',
      request.request,
      ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
      options,
    );
  }

  /** Stops the resource. */
  public stopInstance(
    request: StopInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StopInstanceResponse> {
    return this.#power(
      'stopInstance',
      request.request,
      ObservedPowerState.OBSERVED_POWER_STATE_STOPPED,
      options,
    );
  }

  /** Reboots the resource. */
  public rebootInstance(
    request: RebootInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<RebootInstanceResponse> {
    return this.#power(
      'rebootInstance',
      request.request,
      ObservedPowerState.OBSERVED_POWER_STATE_RUNNING,
      options,
    );
  }

  /** Changes the resource's sizing. */
  public async resizeInstance(
    request: ResizeInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ResizeInstanceResponse> {
    const mutationRequest = this.#mutationRequest(request.request);
    return {
      result: await this.#mutation(
        'resizeInstance',
        mutationRequest.context.requestId,
        request,
        options,
        () => {
          const resource = this.#ownedResource(
            mutationRequest.providerResourceId,
            mutationRequest.expectedOwnershipMarkers,
          );
          if ('failure' in resource) return resource.failure;
          const target = this.#resourcesValue(request.targetResources);
          if (BigInt(target.diskGib ?? '0') < BigInt(resource.value.resources.diskGib ?? '0')) {
            return this.#rejected(
              'DISK_SHRINK_FORBIDDEN',
              FailureCategory.FAILURE_CATEGORY_VALIDATION,
            );
          }
          resource.value.resources = target;
          return this.#accepted(resource.value.id);
        },
      ),
    };
  }

  /** Lists snapshots for an owned resource. */
  public async listSnapshots(
    request: ListSnapshotsRequest,
    options?: ProviderCallOptions,
  ): Promise<ListSnapshotsResponse> {
    return this.#query('listSnapshots', this.#context(request.context).requestId, options, () => {
      const resource = this.#ownedResource(
        this.#required(request.providerResourceId, 'providerResourceId'),
        request.expectedOwnershipMarkers,
      );
      if ('failure' in resource) {
        throw new ProviderTransportError(
          'protocol_error',
          resource.failure.failure?.safeMessage ?? 'Ownership validation failed.',
        );
      }
      return {
        snapshots: [...(this.#snapshots.get(resource.value.id)?.values() ?? [])],
        observedAt: this.#now(),
      };
    });
  }

  /** Creates a snapshot. */
  public async createSnapshot(
    request: CreateSnapshotRequest,
    options?: ProviderCallOptions,
  ): Promise<CreateSnapshotResponse> {
    const mutationRequest = this.#mutationRequest(request.request);
    return {
      result: await this.#mutation(
        'createSnapshot',
        mutationRequest.context.requestId,
        request,
        options,
        () => {
          const resource = this.#ownedResource(
            mutationRequest.providerResourceId,
            mutationRequest.expectedOwnershipMarkers,
          );
          if ('failure' in resource) return resource.failure;
          const snapshotId = this.#required(request.snapshotId, 'snapshotId');
          const snapshots = this.#snapshots.get(resource.value.id) ?? new Map();
          snapshots.set(snapshotId, {
            providerSnapshotReference: `fake-snapshot-${snapshotId}`,
            name: this.#required(request.name, 'name'),
            ...(request.description ? { description: request.description } : {}),
            createdAt: this.#now(),
          });
          this.#snapshots.set(resource.value.id, snapshots);
          return this.#accepted(resource.value.id);
        },
      ),
    };
  }

  /** Rolls the resource back to a snapshot. */
  public async rollbackSnapshot(
    request: RollbackSnapshotRequest,
    options?: ProviderCallOptions,
  ): Promise<RollbackSnapshotResponse> {
    return { result: await this.#snapshotMutation('rollbackSnapshot', request, options, false) };
  }

  /** Deletes a snapshot. */
  public async deleteSnapshot(
    request: DeleteSnapshotRequest,
    options?: ProviderCallOptions,
  ): Promise<DeleteSnapshotResponse> {
    return { result: await this.#snapshotMutation('deleteSnapshot', request, options, true) };
  }

  /** Marks the resource retained, protecting it from purge. */
  public async markInstanceRetained(
    request: MarkInstanceRetainedRequest,
    options?: ProviderCallOptions,
  ): Promise<MarkInstanceRetainedResponse> {
    const mutationRequest = this.#mutationRequest(request.request);
    return {
      result: await this.#mutation(
        'markInstanceRetained',
        mutationRequest.context.requestId,
        request,
        options,
        () => {
          const resource = this.#ownedResource(
            mutationRequest.providerResourceId,
            mutationRequest.expectedOwnershipMarkers,
          );
          if ('failure' in resource) return resource.failure;
          resource.value.retained = true;
          return this.#accepted(resource.value.id);
        },
      ),
    };
  }

  /** Destroys the resource. Not reachable in Phase 3; no workflow path calls it. */
  public async purgeInstance(
    request: PurgeInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<PurgeInstanceResponse> {
    const mutationRequest = this.#mutationRequest(request.request);
    return {
      result: await this.#mutation(
        'purgeInstance',
        mutationRequest.context.requestId,
        request,
        options,
        () => {
          if (!request.purgeAuthorizationId || !request.retentionDeadline) {
            return this.#rejected(
              'PURGE_GUARD_FAILED',
              FailureCategory.FAILURE_CATEGORY_VALIDATION,
            );
          }
          const resource = this.#ownedResource(
            mutationRequest.providerResourceId,
            mutationRequest.expectedOwnershipMarkers,
          );
          if ('failure' in resource) return resource.failure;
          this.#resources.delete(resource.value.id);
          this.#resourceByInstance.delete(resource.value.instanceId);
          this.#snapshots.delete(resource.value.id);
          return this.#accepted(resource.value.id);
        },
      ),
    };
  }

  async #power(
    method: 'rebootInstance' | 'shutdownInstance' | 'startInstance' | 'stopInstance',
    request: InstanceMutationRequest | undefined,
    state: ObservedPowerState,
    options?: ProviderCallOptions,
  ): Promise<{ readonly result?: ProviderMutationResult }> {
    const mutationRequest = this.#mutationRequest(request);
    return {
      result: await this.#mutation(
        method,
        mutationRequest.context.requestId,
        request,
        options,
        () => {
          const resource = this.#ownedResource(
            mutationRequest.providerResourceId,
            mutationRequest.expectedOwnershipMarkers,
          );
          if ('failure' in resource) return resource.failure;
          resource.value.powerState = state;
          return this.#accepted(resource.value.id);
        },
      ),
    };
  }

  async #snapshotMutation(
    method: 'deleteSnapshot' | 'rollbackSnapshot',
    request: DeleteSnapshotRequest | RollbackSnapshotRequest,
    options: ProviderCallOptions | undefined,
    remove: boolean,
  ): Promise<ProviderMutationResult> {
    const snapshotRequest = request.request;
    const mutationRequest = this.#mutationRequest(snapshotRequest?.request);
    return this.#mutation(method, mutationRequest.context.requestId, request, options, () => {
      const resource = this.#ownedResource(
        mutationRequest.providerResourceId,
        mutationRequest.expectedOwnershipMarkers,
      );
      if ('failure' in resource) return resource.failure;
      const snapshotId = this.#required(snapshotRequest?.snapshotId, 'snapshotId');
      const snapshots = this.#snapshots.get(resource.value.id);
      if (!snapshots?.has(snapshotId)) {
        return this.#rejected('SNAPSHOT_NOT_FOUND', FailureCategory.FAILURE_CATEGORY_NOT_FOUND);
      }
      if (remove) snapshots.delete(snapshotId);
      return this.#accepted(resource.value.id);
    });
  }

  async #query<T>(
    method: ProviderMethod,
    requestId: string,
    options: ProviderCallOptions | undefined,
    execute: () => T,
  ): Promise<T> {
    const step = this.#nextStep(method);
    this.#record(method, requestId, step.mode, false);
    await this.#delay(step, options?.signal);
    if (step.mode === 'failure') {
      throw new ProviderTransportError('unavailable', `${method} injected failure.`);
    }
    if (step.mode === 'timeout') {
      throw new ProviderTransportError('deadline_exceeded', `${method} injected timeout.`);
    }
    if (step.mode === 'unknown-outcome') {
      throw new ProviderTransportError(
        'unavailable',
        `${method} cannot return an unknown query outcome.`,
      );
    }
    return execute();
  }

  async #mutation(
    method: ProviderMethod,
    requestId: string,
    request: unknown,
    options: ProviderCallOptions | undefined,
    execute: () => ProviderMutationResult,
  ): Promise<ProviderMutationResult> {
    const key = `${method}:${requestId}`;
    const canonicalRequest = requestJson(request);
    const cached = this.#mutationCache.get(key);
    if (cached) {
      if (cached.canonicalRequest !== canonicalRequest) {
        throw new ProviderTransportError(
          'protocol_error',
          `Request ID '${requestId}' was reused with different input.`,
          { retryable: false },
        );
      }
      const mode =
        cached.result.state === ProviderResultState.PROVIDER_RESULT_STATE_REJECTED
          ? 'failure'
          : cached.result.state === ProviderResultState.PROVIDER_RESULT_STATE_UNKNOWN
            ? 'unknown-outcome'
            : 'success';
      this.#record(method, requestId, mode, true);
      return cached.result;
    }

    const step = this.#nextStep(method);
    this.#record(method, requestId, step.mode, false);
    if (step.mode === 'timeout' && step.applyBeforeResponse) {
      const result = execute();
      this.#applyTaskPolling(step, result);
      this.#countMutation(method);
      this.#mutationCache.set(key, { canonicalRequest, result });
      await this.#delay(step, options?.signal);
      throw new ProviderTransportError(
        'deadline_exceeded',
        `${method} timed out after the provider applied it.`,
      );
    }

    await this.#delay(step, options?.signal);
    if (step.mode === 'timeout') {
      throw new ProviderTransportError(
        'deadline_exceeded',
        `${method} timed out before a known result.`,
      );
    }
    if (step.mode === 'failure') {
      const result = this.#rejected(
        step.failureCode ?? 'FAKE_PROVIDER_REJECTED',
        FailureCategory.FAILURE_CATEGORY_TRANSIENT,
      );
      this.#mutationCache.set(key, { canonicalRequest, result });
      return result;
    }
    if (step.mode === 'unknown-outcome') {
      if (step.applyBeforeResponse) {
        execute();
        this.#countMutation(method);
      }
      const result: ProviderMutationResult = {
        state: ProviderResultState.PROVIDER_RESULT_STATE_UNKNOWN,
        evidenceId: this.#nextId('evidence'),
        failure: {
          category: FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
          code: step.failureCode ?? 'FAKE_UNKNOWN_OUTCOME',
          safeMessage: 'The provider outcome requires observation before retry.',
        },
      };
      this.#mutationCache.set(key, { canonicalRequest, result });
      return result;
    }

    const result = execute();
    this.#applyTaskPolling(step, result);
    this.#countMutation(method);
    this.#mutationCache.set(key, { canonicalRequest, result });
    return result;
  }

  #accepted(resourceId: string): ProviderMutationResult {
    const taskReference = this.#nextId('task');
    this.#tasks.set(taskReference, {
      remainingPolls: this.#configuration.defaultTaskPollsBeforeSuccess ?? 0,
      terminalState: ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED,
    });
    return {
      state: ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      providerTaskReference: taskReference,
      providerResourceId: resourceId,
      evidenceId: this.#nextId('evidence'),
    };
  }

  #applyTaskPolling(step: FakeProviderStep, result: ProviderMutationResult): void {
    if (step.taskPollsBeforeSuccess === undefined || !result.providerTaskReference) return;
    const task = this.#tasks.get(result.providerTaskReference);
    if (task) task.remainingPolls = step.taskPollsBeforeSuccess;
  }

  #rejected(code: string, category: FailureCategory): ProviderMutationResult {
    return {
      state: ProviderResultState.PROVIDER_RESULT_STATE_REJECTED,
      evidenceId: this.#nextId('evidence'),
      failure: {
        category,
        code,
        safeMessage: `Fake provider rejected the request: ${code}.`,
      },
    };
  }

  #ownedResource(
    resourceId: string | undefined,
    expected: OwnershipMarkers | undefined,
  ): { value: FakeResource } | { failure: ProviderMutationResult } {
    const id = this.#required(resourceId, 'providerResourceId');
    const resource = this.#resources.get(id);
    if (!resource) {
      return {
        failure: this.#rejected('RESOURCE_NOT_FOUND', FailureCategory.FAILURE_CATEGORY_NOT_FOUND),
      };
    }
    if (!this.#markersMatch(resource.ownership, expected)) {
      return {
        failure: this.#rejected(
          'OWNERSHIP_MISMATCH',
          FailureCategory.FAILURE_CATEGORY_AUTHORIZATION,
        ),
      };
    }
    return { value: resource };
  }

  #markersMatch(actual: OwnershipMarkers, expected: OwnershipMarkers | undefined): boolean {
    if (!expected) return false;
    return (
      actual.managedBy === expected.managedBy &&
      actual.environment === expected.environment &&
      actual.projectId === expected.projectId &&
      actual.instanceId === expected.instanceId &&
      actual.createOperationId === expected.createOperationId
    );
  }

  #context(context: ProviderCallContext | undefined): ValidatedProviderCallContext {
    return {
      requestId: this.#required(context?.requestId, 'context.requestId'),
      operationId: this.#required(context?.operationId, 'context.operationId'),
      correlationId: this.#required(context?.correlationId, 'context.correlationId'),
      projectId: this.#required(context?.projectId, 'context.projectId'),
      instanceId: this.#required(context?.instanceId, 'context.instanceId'),
      providerProfileId: this.#required(context?.providerProfileId, 'context.providerProfileId'),
      attempt: context?.attempt ?? 1,
    };
  }

  #mutationRequest(request: InstanceMutationRequest | undefined): {
    context: ValidatedProviderCallContext;
    providerResourceId: string;
    expectedOwnershipMarkers: OwnershipMarkers;
  } {
    return {
      context: this.#context(request?.context),
      providerResourceId: this.#required(request?.providerResourceId, 'providerResourceId'),
      expectedOwnershipMarkers: this.#ownership(request?.expectedOwnershipMarkers),
    };
  }

  #ownership(markers: OwnershipMarkers | undefined): OwnershipMarkers {
    return {
      managedBy: this.#required(markers?.managedBy, 'ownership.managedBy'),
      environment: this.#required(markers?.environment, 'ownership.environment'),
      projectId: this.#required(markers?.projectId, 'ownership.projectId'),
      instanceId: this.#required(markers?.instanceId, 'ownership.instanceId'),
      createOperationId: this.#required(markers?.createOperationId, 'ownership.createOperationId'),
    };
  }

  #resourcesValue(resources: InstanceResources | undefined): InstanceResources {
    return {
      cpuCount: resources?.cpuCount ?? 1,
      memoryMib: resources?.memoryMib ?? '512',
      diskGib: resources?.diskGib ?? '8',
    };
  }

  #directRequestId(requestId: string | undefined): string {
    return this.#required(requestId, 'requestId');
  }

  #required(value: string | undefined, name: string): string {
    if (!value) {
      throw new ProviderTransportError('protocol_error', `${name} is required.`, {
        retryable: false,
      });
    }
    return value;
  }

  #nextStep(method: ProviderMethod): FakeProviderStep {
    const index = this.#stepIndexes.get(method) ?? 0;
    const script = this.#configuration.script?.[method];
    const step = script?.[index] ?? script?.at(-1) ?? DEFAULT_STEP;
    this.#stepIndexes.set(method, index + 1);
    return step;
  }

  async #delay(step: FakeProviderStep, signal?: AbortSignal): Promise<void> {
    const latency = step.latencyMs ?? this.#configuration.defaultLatencyMs ?? 0;
    await (this.#configuration.sleep ?? defaultSleep)(latency, signal);
  }

  #record(
    method: ProviderMethod,
    requestId: string,
    mode: FakeProviderMode,
    duplicate: boolean,
  ): void {
    this.#calls.push({ sequence: ++this.#sequence, method, requestId, mode, duplicate });
  }

  #countMutation(method: ProviderMethod): void {
    this.#logicalMutationCounts.set(method, (this.#logicalMutationCounts.get(method) ?? 0) + 1);
  }

  #nextId(kind: string): string {
    return `fake-${kind}-${String(++this.#sequence).padStart(6, '0')}`;
  }

  #now(): string {
    return (this.#configuration.now?.() ?? new Date()).toISOString();
  }
}
