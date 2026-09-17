/**
 * Terraform-backed Proxmox adapter: the read path.
 *
 * PATTERN — ports and adapters. This satisfies the same provider-neutral port the direct adapter
 * does, so no workflow, no contract and no test above the gRPC boundary knows which one is
 * serving it. Terraform is an implementation detail of this adapter and nothing else.
 *
 * It shares the direct adapter's ownership and allowlist code rather than reimplementing it. A
 * second implementation of an ownership check is a second chance to disagree about whether a VM
 * may be destroyed, and that disagreement would surface as a purge that either refused
 * everything or refused nothing.
 *
 * **What this file deliberately does not do:** it opens no HTTP connection to Proxmox. Every
 * observation goes through Terraform, which holds the credentials. The one exception in the wider
 * design is the narrowed direct client for snapshots, reboot and hard stop — operations Terraform
 * has no way to express — and that is separate code with its own configuration.
 *
 * @see terraform-provisioning-plan.md
 * @see docs/architecture/terraform-manual-walkthrough.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { FailureCategory, ObservedPowerState } from '@private-cloud/contracts';
import {
  ProviderResultState,
  ProviderTaskState,
  ValidationCheckState,
  type GetCapabilitiesRequest,
  type GetCapabilitiesResponse,
  type GetTaskRequest,
  type GetTaskResponse,
  type InstanceObservation,
  type ApplyInstanceConfigurationRequest,
  type ApplyInstanceConfigurationResponse,
  type InstanceMutationRequest,
  type CreateSnapshotRequest,
  type CreateSnapshotResponse,
  type DeleteSnapshotRequest,
  type DeleteSnapshotResponse,
  type ListSnapshotsRequest,
  type ListSnapshotsResponse,
  type MarkInstanceRetainedRequest,
  type MarkInstanceRetainedResponse,
  type ObserveInstanceRequest,
  type ObserveInstanceResponse,
  type PurgeInstanceRequest,
  type PurgeInstanceResponse,
  type ResizeInstanceRequest,
  type ResizeInstanceResponse,
  type RollbackSnapshotRequest,
  type RollbackSnapshotResponse,
  type StartInstanceResponse,
  type OwnershipMarkers,
  type SubmitCreateInstanceRequest,
  type SubmitCreateInstanceResponse,
  type ValidateProfileRequest,
  type ValidateProfileResponse,
  type ProviderCallContext,
  type StartInstanceRequest,
  type ShutdownInstanceRequest,
  type StopInstanceRequest,
  type RebootInstanceRequest,
} from '@private-cloud/contracts/provider';
import { ProviderTransportError, type ProviderCallOptions } from '@private-cloud/provider-sdk';
import {
  MAXIMUM_CPU_COUNT,
  MAXIMUM_DISK_GIB,
  MAXIMUM_MEMORY_MIB,
  MAXIMUM_SNAPSHOTS,
  failure,
  markersMatch,
  ownershipDescription,
  parseOwnership,
  required,
  RETENTION_TRAILER_KEY,
  describedWithTrailer,
} from './proxmox-provider.js';
import type { ProxmoxDirectClient } from './terraform/direct-client.js';
import { workspaceNameFor, type InstanceTfvars } from './terraform/tfvars.js';
import type { TerraformRunner } from './terraform/runner.js';

/**
 * Reads the caller's lease fencing token out of the call context.
 *
 * WHY this is not `context.attempt`: it was, and that was wrong. `attempt` is pinned to `1` by
 * the workflow on purpose, so that `requestId` stays byte-identical across replays and a provider
 * can recognise a duplicate submission. A fencing token has to do the opposite — change whenever
 * the lease moves — so comparing `attempt` against a real lease token compared a constant against
 * a counter. The first full-stack run against real hardware failed on exactly that: the workflow
 * was on its second claim, the lease held token 2, the adapter presented 1, and the inventory
 * refused the run as `INSTANCE_BUSY` before Terraform was invoked at all.
 *
 * `0` when the caller holds no lease. The inventory treats an instance with no lease row as
 * unfenced, so an in-process caller — a verifier, a test — is not blocked by a check that has
 * nothing to compare against.
 */
function fencingTokenFrom(context: ProviderCallContext | undefined): string {
  const token = context?.fencingToken?.trim();
  return token ? token : '0';
}

/** The allowlist this adapter is confined to. Mirrors the direct adapter's, minus the HTTP parts. */
export interface TerraformProxmoxConfiguration {
  readonly providerProfileId: string;
  readonly projectId: string;
  readonly node: string;
  readonly templateVmid: number;
  /**
   * The clone template's disk format, which is what decides whether snapshots are possible.
   *
   * WHY this is configuration rather than a hypervisor read: `getCapabilities` is called by the
   * readiness probe every few seconds and must never reach the provider. The format is a static
   * property of the deployment's template, measured by `pnpm run survey:proxmox` and carried here
   * through `PROXMOX_TEMPLATE_DISK_FORMAT`, so the answer is both honest and free.
   */
  readonly templateDiskFormat: 'qcow2' | 'raw';
  readonly imageId: string;
  readonly storage: string;
  readonly diskInterface: string;
  readonly bridge: string;
  readonly networkMtu: number;
  readonly networkId: string;
  readonly ipv4Cidr: string;
  readonly ipv4Gateway: string;
  readonly dnsDomain: string;
  readonly cloudInitUsername: string;
  readonly cloudInitPassword: string;
  readonly resourceIdMinimum: number;
  readonly resourceIdMaximum: number;
  readonly environment: 'lab';
  readonly managedBy: 'private-cloud-control-plane';
}

/**
 * The run record this adapter reads, declared as an interface rather than imported.
 *
 * WHY: `packages/postgres-adapter` and this package are both adapters, and one adapter importing
 * another would make the provider unusable without a database. The composition root supplies the
 * PostgreSQL implementation, which satisfies this structurally.
 */
export interface TerraformRunReader {
  readRun(runId: string): Promise<{
    readonly status: string;
    readonly command: string;
    readonly gateDecision: string | null;
    readonly gateRule: string | null;
    readonly exitCode: number | null;
    readonly diagnostics: readonly unknown[] | null;
  } | null>;
}

/**
 * The run record this adapter writes.
 *
 * `beginRun` must be durable **before** the Terraform process starts. That ordering is the whole
 * of SAFE-014: the reference the workflow will poll has to outlive the worker that created it, so
 * a restart resumes the run rather than submitting a second apply against the same instance.
 */
export interface TerraformRunStore extends TerraformRunReader {
  beginRun(input: {
    readonly runId: string;
    readonly instanceId: string;
    readonly operationId: string;
    readonly workspaceName: string;
    readonly command: 'init' | 'plan' | 'apply' | 'refresh' | 'destroy';
    readonly fencingToken: number | string;
  }): Promise<void>;
  completeRun(input: {
    readonly runId: string;
    readonly fencingToken: number | string;
    readonly status: 'succeeded' | 'failed' | 'unknown';
    readonly exitCode?: number;
    readonly gateDecision?: 'allowed' | 'refused_destructive';
    readonly gateRule?: string;
    readonly planActions?: Readonly<Record<string, number>>;
    readonly diagnostics?: readonly unknown[];
  }): Promise<void>;
  recordWorkspace(input: {
    readonly instanceId: string;
    readonly workspaceName: string;
    readonly providerVersion?: string;
    readonly lastRunId?: string;
    readonly applied?: boolean;
    readonly refreshed?: boolean;
    readonly driftState?: 'unknown' | 'in_sync' | 'drifted' | 'absent';
    /** Write counter for the state document. Absent when state could not be read. */
    readonly stateSerial?: number;
    /** Identity of the state *document*. A change means the state was replaced. */
    readonly stateLineage?: string;
  }): Promise<void>;
}

/**
 * Reads one of bpg's single-element nested blocks out of a state document.
 *
 * Every `cpu {}`, `memory {}`, `disk {}` and `initialization {}` block arrives as a one-element
 * array because HCL blocks are repeatable in the schema even where the provider allows only one.
 * Naming that once is better than repeating the array dance at every use.
 */
function block(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? (value[0] as Record<string, unknown> | undefined) : undefined;
}

/**
 * Extracts the observable resource shape from a VM's state values.
 *
 * WHY `observeInstance` needs this and not just the ownership marker: an observation that reports
 * only existence and power state cannot report *drift*, and reporting drift is the whole job
 * (SAFE-029). The projection has `cpuCount`, `memoryMiB` and `diskGiB` fields that stayed null for
 * this adapter, so a CPU count changed by hand on the server was invisible to the reconciler — it
 * would have been read as "no drift" rather than as a finding.
 */
function observedResources(values: Record<string, unknown>):
  | {
      readonly cpuCount: number;
      readonly memoryMib: string;
      readonly diskGib: string;
    }
  | undefined {
  const cpu = block(values.cpu);
  const memory = block(values.memory);
  const disk = block(values.disk);
  if (!cpu && !memory && !disk) return undefined;
  return {
    cpuCount: Number(cpu?.cores ?? 0),
    memoryMib: String(memory?.dedicated ?? 0),
    diskGib: String(disk?.size ?? 0),
  };
}

/** The reserved VMID interval, clamped regardless of configuration. */
const RESERVED_VMID_MINIMUM = 910_000;
const RESERVED_VMID_MAXIMUM = 910_099;

/**
 * Diagnostic text that means "try again", not "this will never work".
 *
 * Found by live testing rather than reasoning. A verification run started seconds after the
 * previous run's destroy failed its clone with `Error: VM clone / All attempts fail`, and a
 * re-run of exactly the same configuration succeeded — the template was still locked by the
 * preceding operation. The adapter classified that as **permanent**, which would have failed a
 * workflow that should simply have waited.
 *
 * WHY a text match rather than a status code: Terraform flattens the provider's error into a
 * diagnostic string, so the structured Proxmox response is not available by the time this runs.
 * That is a real limitation of routing through Terraform and it is better stated than hidden.
 * The patterns are deliberately narrow — a broad one would retry a genuine misconfiguration
 * forever, which is worse than failing it once.
 */
const TRANSIENT_DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  // Proxmox holds a config lock during clone, migrate, backup and snapshot.
  /\block\b/i,
  /is locked/i,
  // bpg's own retry wrapper gives up with this when every attempt hit the same condition.
  /all attempts fail/i,
  // Storage or the API briefly unavailable.
  /connection refused/i,
  /timeout/i,
  /temporarily unavailable/i,
  // systemd on the *host* refusing to act right now because a conflicting job is queued. Seen on
  // a loaded shared server as `start failed: org.freedesktop.systemd1.TransactionIsDestructive`
  // — the VM was cloned and configured, and only the final start was refused. The name is
  // alarming and the condition is not: it says "not in this transaction", not "never". Narrow on
  // purpose, because it names one systemd error rather than matching the word "destructive".
  /TransactionIsDestructive/,
];

/**
 * Conditions that will fail identically forever, checked **before** the transient patterns.
 *
 * WHY this list has to win: `all attempts fail` above is bpg's *generic* retry-exhaustion prefix.
 * It wraps every failure its retry wrapper gave up on, and it gives up on permanent failures too —
 * so on its own that pattern classifies an HTTP 403 as "the provider was busy". Measured on real
 * hardware: a clone to a VMID the API token had no `VM.Allocate` on produced
 *
 *   All attempts fail:
 *   #1: error cloning VM: received an HTTP 403 response - Reason: Permission check failed
 *
 * and the workflow spent its whole retry budget on a request that could never have succeeded.
 * This is the second time a wrong "retryable" verdict has cost a run here — the first was Proxmox
 * answering a malformed SSH key with an HTTP 500 — and both share one shape: **the transport's
 * status code describes how the server felt, not whether the request was possible.**
 *
 * Deliberately narrow. Each entry names a specific denial or a specific impossibility, never a
 * general word like "error" or "failed", because a pattern that over-matches here wedges an
 * instance that a retry would have fixed.
 */
const PERMANENT_DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  // Authorization. The token lacks a privilege on this path, and waiting cannot grant it.
  /HTTP 403 response/i,
  /permission check failed/i,
  // Authentication. A bad or expired token stays bad until someone rotates it.
  /HTTP 401 response/i,
  /authentication failure/i,
  /invalid (?:ticket|csrf|token)/i,
  // The request names something that is not there. A retry re-sends the same name.
  /HTTP 404 response/i,
  /does not exist/i,
  /no such (?:vm|volume|storage|file)/i,
  // The request names something that is already there, so the same request cannot ever be new.
  /already exists/i,
  // Proxmox rejecting the *content* of a parameter. Narrow on purpose: this is the server saying
  // the value is wrong, not that it is busy.
  /parameter verification failed/i,
];

/**
 * Whether a failed run's diagnostics describe a condition worth retrying.
 *
 * Permanent patterns are tested first and win, because bpg's retry-exhaustion prefix appears on
 * permanent failures as well as transient ones.
 */
function isTransient(diagnostics: readonly unknown[] | null): boolean {
  if (!diagnostics || diagnostics.length === 0) return false;
  const text = JSON.stringify(diagnostics);
  if (PERMANENT_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Prefix marking a task reference that belongs to the direct client rather than to a run record.
 *
 * WHY two reference kinds rather than one: six operations do not go through Terraform at all, and
 * their task is a Proxmox UPID with no run row behind it. `getTask` has to be able to tell them
 * apart, and a prefix is checkable — the alternative, looking a reference up in the run table and
 * treating "not found" as "must be a UPID", would report a genuinely lost run as a Proxmox task
 * and then fail trying to poll it.
 */
const DIRECT_TASK_PREFIX = 'upid:';

/** The resource address the module declares, which every plan and state read refers to. */
export const INSTANCE_ADDRESS = 'proxmox_virtual_environment_vm.instance';

/**
 * Reads the DNS server list out of a state `initialization` block.
 *
 * Terraform renders every HCL block as an array of one, so reading state means unwrapping at
 * each level. Extracted because doing it inline was both unreadable and, as the compiler
 * observed, not actually null-safe.
 *
 * @param initialization The `initialization` block from state, if present.
 * @returns The configured resolvers, or `undefined` when the block did not carry any.
 */
function dnsServers(initialization: Record<string, unknown> | undefined): string[] | undefined {
  const blocks = initialization?.dns;
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const servers = (blocks[0] as { servers?: unknown }).servers;
  return Array.isArray(servers) ? servers.map(String) : undefined;
}

/** The subset of `terraform show -json` (state form) this adapter reads. */
interface TerraformState {
  readonly values?: {
    readonly root_module?: {
      readonly resources?: readonly {
        readonly address?: string;
        readonly values?: Record<string, unknown>;
      }[];
    };
  };
}

/** Reads the Terraform-backed lifecycle for one Proxmox deployment. */
export class TerraformProxmoxProvider {
  public constructor(
    private readonly configuration: TerraformProxmoxConfiguration,
    private readonly runner: TerraformRunner,
    private readonly runs: TerraformRunStore,
    /**
     * The direct client for the six operations Terraform cannot express.
     *
     * Optional, so a deployment that only needs create, power, resize and purge can run without
     * Proxmox API credentials at all. Reaching a snapshot without one fails with a message that
     * says so, rather than with a null dereference.
     */
    private readonly directClient?: ProxmoxDirectClient,
  ) {
    if (
      !Number.isSafeInteger(configuration.resourceIdMinimum) ||
      !Number.isSafeInteger(configuration.resourceIdMaximum) ||
      configuration.resourceIdMinimum < RESERVED_VMID_MINIMUM ||
      configuration.resourceIdMaximum > RESERVED_VMID_MAXIMUM ||
      configuration.resourceIdMinimum > configuration.resourceIdMaximum
    ) {
      throw new Error(
        `Proxmox resource IDs must stay inside the reserved ${RESERVED_VMID_MINIMUM}-${RESERVED_VMID_MAXIMUM} range.`,
      );
    }
    if (!configuration.cloudInitPassword) {
      // A blank password would be written into cloud-init and into state, and would produce a
      // guest nobody can log into while looking configured. Refusing to start is the safe answer.
      throw new Error('A cloud-init password is required.');
    }
  }

  /**
   * Reports the bounded capabilities this adapter supports.
   *
   * `async` deliberately, and cheap deliberately: the readiness probe calls it every few seconds
   * and must never reach a hypervisor, and a synchronous throw here escapes a caller's `.catch`
   * — which is exactly how the readiness probe came to answer 500 instead of 503.
   *
   * @param request Capability request. `providerProfileId` must name the allowlisted profile.
   * @returns The capability set and the time it was reported.
   */
  public async getCapabilities(request: GetCapabilitiesRequest): Promise<GetCapabilitiesResponse> {
    this.assertProfile(request.providerProfileId);
    return {
      capabilities: {
        createInstance: true,
        configureInstance: true,
        power: true,
        resizeCompute: true,
        growDisk: true,
        // Snapshots do not go through Terraform — bpg publishes no snapshot resource and no
        // snapshot data source — so they are served by the narrowed direct client. That makes
        // them available in principle, and the *storage* decides whether they are available in
        // fact: Proxmox refuses to snapshot a `raw` disk, and a full clone inherits its
        // template's format.
        //
        // This flag was previously a hardcoded `false` justified by "bpg has no snapshot
        // resource", which contradicted the six snapshot methods below that work perfectly well
        // through the direct client. It was accidentally correct for a different reason — the
        // template's disk really was `raw` — and would have stayed wrong after that was fixed.
        snapshots: this.configuration.templateDiskFormat === 'qcow2',
        retentionMarker: true,
        purge: true,
        maximumCpuCount: MAXIMUM_CPU_COUNT,
        maximumMemoryMib: String(MAXIMUM_MEMORY_MIB),
        maximumDiskGib: String(MAXIMUM_DISK_GIB),
        maximumSnapshots: MAXIMUM_SNAPSHOTS,
      },
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Checks that Terraform, the module and the backend are usable.
   *
   * Read-only, and local: it initialises a throwaway workspace rather than mutating anything. The
   * checks are reported individually and never thrown, so a partially-working deployment is
   * diagnosable rather than opaque.
   *
   * @param request Validation request.
   * @returns Per-check results.
   */
  public async validateProfile(request: ValidateProfileRequest): Promise<ValidateProfileResponse> {
    this.assertProfile(request.profile?.providerProfileId);
    const checks: { name: string; state: ValidationCheckState; safeSummary: string }[] = [];

    const probeWorkspace = `probe-${randomUUID()}`;
    let probeDirectory;
    try {
      const directory = await this.runner.prepare(probeWorkspace, this.probeTfvars());
      probeDirectory = directory;
      // Backend-free: validation only needs the module and the provider to be usable, and
      // initialising the real backend left a workspace row behind on every call.
      const init = await this.runner.initWithoutBackend(directory);
      checks.push({
        name: 'terraform_module',
        state:
          init.exitCode === 0
            ? ValidationCheckState.VALIDATION_CHECK_STATE_PASSED
            : ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
        safeSummary:
          init.exitCode === 0
            ? 'The module and the pinned provider initialised.'
            : (init.diagnostics[0]?.summary ?? `Terraform init exited ${init.exitCode}.`),
      });

      if (init.exitCode === 0) {
        // `validate` rather than `plan`: plan refuses to run against a configuration whose
        // backend has not been initialised, and initialising the real backend is what leaked a
        // workspace row per validation. Validate checks the module and every variable, which is
        // the question this check is actually asking.
        const validated = await this.runner.validate(directory);
        checks.push({
          name: 'module_variables',
          state:
            validated.exitCode === 0
              ? ValidationCheckState.VALIDATION_CHECK_STATE_PASSED
              : ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
          safeSummary:
            validated.exitCode === 0
              ? 'The module and the configured variables are valid.'
              : (validated.diagnostics[0]?.summary ??
                `Terraform validate exited ${validated.exitCode}.`),
        });
      }
    } catch (error) {
      checks.push({
        name: 'terraform_available',
        state: ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
        safeSummary: error instanceof Error ? error.message : 'Terraform could not be run.',
      });
    } finally {
      // The probe workspace holds a tfvars file with the cloud-init password in it.
      if (probeDirectory) await this.runner.discard(probeDirectory).catch(() => undefined);
    }

    return {
      valid: checks.every(
        (check) => check.state === ValidationCheckState.VALIDATION_CHECK_STATE_PASSED,
      ),
      checks,
      validatedAt: new Date().toISOString(),
      validationEvidenceId: randomUUID(),
    };
  }

  /**
   * Reports on one Terraform run.
   *
   * The run record is the task, which is what makes a worker restart survivable: the row exists
   * independently of the process that created it, so a new worker polls the same reference rather
   * than starting a second apply.
   *
   * **A refused plan reports `FAILED`, not `RUNNING`.** The gate refusing is a terminal outcome —
   * nothing was applied and a retry reaches the same refusal — so reporting it as still running
   * would leave the workflow polling forever.
   *
   * @param request Task request carrying the run id.
   * @returns The task state.
   */
  public async getTask(request: GetTaskRequest): Promise<GetTaskResponse> {
    const reference = request.providerTaskReference;
    if (!reference) {
      throw new ProviderTransportError('protocol_error', 'Task reference is required.', {
        retryable: false,
      });
    }

    const observedAt = new Date().toISOString();

    if (reference.startsWith(DIRECT_TASK_PREFIX)) {
      return this.directTaskState(reference.slice(DIRECT_TASK_PREFIX.length), observedAt);
    }

    const run = await this.runs.readRun(reference);

    if (!run) {
      // Unknown rather than failed: a reference this adapter cannot find may be a reference it
      // has not yet committed, and guessing "failed" would abandon a live instance.
      return { state: ProviderTaskState.PROVIDER_TASK_STATE_UNKNOWN, observedAt };
    }

    if (run.status === 'running') {
      return { state: ProviderTaskState.PROVIDER_TASK_STATE_RUNNING, observedAt };
    }

    if (run.status === 'succeeded') {
      return { state: ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED, observedAt };
    }

    if (run.gateDecision === 'refused_destructive') {
      return {
        state: ProviderTaskState.PROVIDER_TASK_STATE_FAILED,
        failure: {
          // Permanent, not transient. The plan will be refused again for the same reason, and the
          // only path forward is an operator decision.
          category: FailureCategory.FAILURE_CATEGORY_PERMANENT,
          code: 'TERRAFORM_PLAN_REFUSED',
          safeMessage: 'The change was refused because it would destroy a provider resource.',
        },
        observedAt,
      };
    }

    if (run.status === 'unknown') {
      return {
        state: ProviderTaskState.PROVIDER_TASK_STATE_UNKNOWN,
        failure: {
          category: FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
          code: 'TERRAFORM_RUN_UNKNOWN',
          safeMessage: 'The Terraform run outcome could not be determined.',
        },
        observedAt,
      };
    }

    // A transient condition is reported as such, so the workflow's retry policy can wait rather
    // than failing an instance that would have worked a moment later. SAFE-017 asks for exactly
    // this distinction, and getting it wrong in the safe direction still wedges an instance.
    const transient = isTransient(run.diagnostics);
    return {
      state: ProviderTaskState.PROVIDER_TASK_STATE_FAILED,
      failure: {
        category: transient
          ? FailureCategory.FAILURE_CATEGORY_TRANSIENT
          : FailureCategory.FAILURE_CATEGORY_PERMANENT,
        code: transient ? 'TERRAFORM_RUN_RETRYABLE' : 'TERRAFORM_RUN_FAILED',
        safeMessage: transient
          ? 'The provider was busy; the change can be retried.'
          : 'The Terraform run failed.',
      },
      observedAt,
    };
  }

  /**
   * Reads what actually exists, by refreshing state from the provider.
   *
   * `apply -refresh-only` writes to state and never to Proxmox, which is what makes observation
   * safe to run against a live instance — including during reconciliation, where SAFE-029 forbids
   * repairing anything.
   *
   * @param request Observation request.
   * @param options Cancellation.
   * @returns What exists, and whether its ownership markers match.
   */
  public async observeInstance(
    request: ObserveInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ObserveInstanceResponse> {
    void options;
    const context = request.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    if (!instanceId) {
      throw new ProviderTransportError('protocol_error', 'context.instanceId is required.', {
        retryable: false,
      });
    }

    const workspace = workspaceNameFor(instanceId);
    const directory = await this.runner.prepare(workspace, this.probeTfvars());
    try {
      const init = await this.runner.init(directory, workspace);
      if (init.exitCode !== 0) {
        throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
          retryable: true,
        });
      }

      await this.runner.refresh(directory);
      const state = await this.readState(directory);
      const resource = state?.values?.root_module?.resources?.find(
        (entry) => entry.address === INSTANCE_ADDRESS,
      );

      if (!resource) return { observation: this.absent() };

      const values = resource.values ?? {};
      const description = typeof values.description === 'string' ? values.description : undefined;
      const actual = parseOwnership(description);
      const expected = request.expectedOwnershipMarkers;

      // The refresh above has already pulled the server's real values into state, so these are
      // observations and not intentions — which is what makes reporting them meaningful.
      const resources = observedResources(values);
      const initialization = block(values.initialization);
      const ipv4 = block(block(initialization?.ip_config)?.ipv4);
      const [observedAddress, observedPrefix] = String(ipv4?.address ?? '').split('/');

      return {
        observation: {
          exists: true,
          providerResourceId: values.vm_id === undefined ? undefined : String(values.vm_id),
          powerState:
            values.started === true
              ? ObservedPowerState.OBSERVED_POWER_STATE_RUNNING
              : values.started === false
                ? ObservedPowerState.OBSERVED_POWER_STATE_STOPPED
                : ObservedPowerState.OBSERVED_POWER_STATE_UNKNOWN,
          ...(resources ? { resources } : {}),
          ...(observedAddress
            ? {
                network: {
                  networkId: this.configuration.networkId,
                  ipv4Address: observedAddress,
                  ipv4PrefixLength: Number(observedPrefix ?? 0),
                  ipv4Gateway: String(ipv4?.gateway ?? ''),
                  dnsServers: [],
                },
              }
            : {}),
          ownership: {
            complete: actual !== null,
            match: expected ? markersMatch(actual, expected as OwnershipMarkers) : false,
            ...(actual ? { values: actual } : {}),
          },
          observedAt: new Date().toISOString(),
        },
      };
    } finally {
      await this.runner.discard(directory).catch(() => undefined);
    }
  }

  /**
   * Starts a create, and returns before it finishes.
   *
   * The port's contract is submit-then-poll, and that is not a formality here: a clone plus
   * cloud-init takes tens of seconds, and holding a gRPC call open for it would tie the
   * workflow's liveness to a network connection. So the run row is committed, the apply is
   * started *without being awaited*, and the run id is handed back as the task reference.
   *
   * The ordering is the safety property. The row exists before the process does (SAFE-014), so a
   * worker that dies mid-apply leaves a reference a new worker can poll (SAFE-015) rather than a
   * gap that invites a second apply against the same instance.
   *
   * @param request The create request, carrying resources, network and ownership markers.
   * @returns `ACCEPTED` with the run id as the task reference, or a rejection.
   */
  public async submitCreateInstance(
    request: SubmitCreateInstanceRequest,
  ): Promise<SubmitCreateInstanceResponse> {
    const context = request.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    const operationId = context?.operationId;
    if (!instanceId || !operationId) {
      throw new ProviderTransportError(
        'protocol_error',
        'context.instanceId and context.operationId are required.',
        { retryable: false },
      );
    }
    if (request.imageId !== this.configuration.imageId) {
      throw new ProviderTransportError('protocol_error', 'Image is outside the allowlist.', {
        retryable: false,
      });
    }

    const markers = request.ownershipMarkers;
    if (!markers) {
      throw new ProviderTransportError('protocol_error', 'Ownership markers are required.', {
        retryable: false,
      });
    }

    const resources = request.resources;
    const network = request.network;
    if (!resources || !network) {
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_VALIDATION,
          'CONFIGURATION_REQUIRED',
          'Resources and network configuration are required.',
        ),
      };
    }

    const vmId = this.vmIdFor(instanceId);
    const workspace = workspaceNameFor(instanceId);
    const tfvars: InstanceTfvars = {
      node_name: this.configuration.node,
      template_vm_id: this.configuration.templateVmid,
      vm_id: vmId,
      hostname: required(request.hostname, 'hostname'),
      ownership_marker: ownershipDescription(markers),
      tags: [this.configuration.managedBy, this.configuration.environment],
      datastore_id: this.configuration.storage,
      disk_interface: this.configuration.diskInterface,
      disk_format: this.configuration.templateDiskFormat,
      disk_gib: Number(resources.diskGib ?? 0),
      cpu_cores: resources.cpuCount ?? 1,
      memory_mib: Number(resources.memoryMib ?? 512),
      bridge: this.configuration.bridge,
      network_mtu: this.configuration.networkMtu,
      ipv4_address: required(network.ipv4Address, 'network.ipv4Address'),
      ipv4_prefix_length: network.ipv4PrefixLength ?? 0,
      ipv4_gateway: required(network.ipv4Gateway, 'network.ipv4Gateway'),
      dns_servers: [...(network.dnsServers ?? [])],
      dns_domain: this.configuration.dnsDomain,
      cloud_init_username: this.configuration.cloudInitUsername,
      cloud_init_password: this.configuration.cloudInitPassword,
      ssh_public_keys: [...(request.sshPublicKeys ?? [])],
      started: true,
      on_boot: false,
    };

    return this.startApply({
      instanceId,
      operationId,
      workspace,
      vmId,
      tfvars,
      fencingToken: fencingTokenFrom(context),
    });
  }

  /**
   * Prepares, gates and starts an apply, returning as soon as the run is durable.
   *
   * Shared by every mutating capability, because they differ only in the variables they render.
   */
  private async startApply(input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly workspace: string;
    readonly vmId: number;
    readonly tfvars: InstanceTfvars;
    readonly fencingToken: number | string;
    readonly purge?: boolean;
  }): Promise<SubmitCreateInstanceResponse> {
    const runId = randomUUID();
    const directory = await this.runner.prepare(input.workspace, input.tfvars, input.purge);

    const init = await this.runner.init(directory, input.workspace);
    if (init.exitCode !== 0) {
      await this.runner.discard(input.workspace).catch(() => undefined);
      throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
        retryable: true,
      });
    }

    const { gate, invocation } = await this.runner.plan(directory, {
      ...(input.purge ? { destroy: true, allowDestroyOf: INSTANCE_ADDRESS } : {}),
    });

    // The run is recorded whether or not it will be applied, because a refusal is an outcome an
    // operator needs to see — not an absence.
    await this.runs.beginRun({
      runId,
      instanceId: input.instanceId,
      operationId: input.operationId,
      workspaceName: input.workspace,
      command: gate.decision === 'allowed' ? 'apply' : 'plan',
      fencingToken: input.fencingToken,
    });

    if (gate.decision !== 'allowed') {
      await this.runs.completeRun({
        runId,
        fencingToken: input.fencingToken,
        status: 'failed',
        exitCode: invocation.exitCode,
        gateDecision: gate.decision,
        ...(gate.rule ? { gateRule: gate.rule } : {}),
        planActions: gate.actionCounts,
        diagnostics: invocation.diagnostics,
      });
      await this.runner.discard(input.workspace).catch(() => undefined);
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_PERMANENT,
          'TERRAFORM_PLAN_REFUSED',
          'The change was refused because it would destroy a provider resource.',
        ),
      };
    }

    // Not awaited. The workflow polls `getTask`, and awaiting here would tie its liveness to a
    // gRPC connection held open for tens of seconds.
    void this.completeInBackground(runId, directory, input);

    return {
      result: {
        state: ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
        providerResourceId: String(input.vmId),
        providerTaskReference: runId,
        evidenceId: randomUUID(),
      },
    };
  }

  /**
   * Applies and records the outcome, after the caller has already been answered.
   *
   * WHY every path here ends in `completeRun`: the workflow polls until the run leaves `running`,
   * so a background task that threw without recording anything would leave it polling forever.
   * The `catch` is not optional tidiness.
   */
  private async completeInBackground(
    runId: string,
    directory: string,
    input: {
      readonly instanceId: string;
      readonly workspace: string;
      readonly fencingToken: number | string;
      readonly purge?: boolean;
    },
  ): Promise<void> {
    // The directory is this run's own, so discarding it in the `finally` below cannot disturb
    // another operation on the same instance.
    try {
      const { gate } = await this.runner.plan(directory, {
        ...(input.purge ? { destroy: true, allowDestroyOf: INSTANCE_ADDRESS } : {}),
      });
      const apply = await this.runner.apply(directory, gate);
      await this.runs.completeRun({
        runId,
        fencingToken: input.fencingToken,
        status: apply.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: apply.exitCode,
        gateDecision: 'allowed',
        planActions: gate.actionCounts,
        diagnostics: apply.diagnostics,
      });
      if (apply.exitCode === 0) {
        // Read *after* the apply, so the serial counts this write. A purge is the exception: it
        // leaves no state to read, and an absent workspace has no serial to report.
        const state = input.purge ? {} : await this.runner.stateMetadata(directory);
        await this.runs.recordWorkspace({
          instanceId: input.instanceId,
          workspaceName: input.workspace,
          lastRunId: runId,
          applied: true,
          // A purge leaves nothing to be in sync with. `absent` is the honest classification, and
          // the reconciler treats it differently from a workspace it simply has not observed.
          driftState: input.purge ? 'absent' : 'in_sync',
          ...(state.serial === undefined ? {} : { stateSerial: state.serial }),
          ...(state.lineage === undefined ? {} : { stateLineage: state.lineage }),
        });
        if (input.purge) {
          // The VM is gone, so its workspace is state for something that no longer exists. A
          // failure here is not fatal — the destroy already happened — but leaving the row means
          // the inventory keeps reporting an instance nobody can find.
          await this.runner.deleteWorkspace(directory, input.workspace).catch(() => undefined);
        }
      } else {
        // A failed apply can leave state holding a value the provider rejected, so nothing may
        // treat this workspace as in sync until a refresh has run.
        await this.runs.recordWorkspace({
          instanceId: input.instanceId,
          workspaceName: input.workspace,
          lastRunId: runId,
          driftState: 'unknown',
        });
      }
    } catch (error) {
      await this.runs
        .completeRun({
          runId,
          fencingToken: input.fencingToken,
          // `unknown`, not `failed`. The apply may have acted before the failure, and SAFE-018
          // forbids guessing: an unknown outcome goes to reconciliation or manual review.
          status: 'unknown',
          diagnostics: [
            {
              severity: 'error',
              summary: 'The Terraform run did not report an outcome.',
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        })
        .catch(() => undefined);
    } finally {
      await this.runner.discard(input.workspace).catch(() => undefined);
    }
  }

  /**
   * The VMID for an instance, derived deterministically from its id.
   *
   * Deterministic rather than allocated, so a replay of the same create computes the same VMID
   * and recognises its own earlier work instead of building a second VM. Never `/cluster/nextid`,
   * which could hand back an id outside the reservation.
   */
  private vmIdFor(instanceId: string): number {
    const digest = createHash('sha256').update(instanceId).digest('hex').slice(0, 8);
    const size = this.configuration.resourceIdMaximum - this.configuration.resourceIdMinimum + 1;
    return this.configuration.resourceIdMinimum + (Number.parseInt(digest, 16) % size);
  }

  /**
   * Asserts the workspace has converged, rather than writing anything.
   *
   * The direct adapter's `applyInstanceConfiguration` is a second write: clone first, configure
   * second. Terraform does both in one apply, so there is nothing left to write by the time this
   * stage runs — and the workflow's stage vocabulary is persisted state shared across
   * capabilities, so collapsing the stage was not an option.
   *
   * Turning it into an assertion is the better outcome anyway. A stage that previously performed
   * a blind second write now *proves* the instance matches its declared configuration, and a
   * non-empty plan fails the stage honestly instead of reporting success.
   *
   * @param request The configuration request.
   * @returns `SUCCEEDED` when the plan is empty, a rejection when it is not.
   */
  public async applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
  ): Promise<ApplyInstanceConfigurationResponse> {
    const context = request.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    if (!instanceId) {
      throw new ProviderTransportError('protocol_error', 'context.instanceId is required.', {
        retryable: false,
      });
    }

    const workspace = workspaceNameFor(instanceId);
    const directory = await this.runner.prepare(workspace, this.probeTfvars());
    try {
      const init = await this.runner.init(directory, workspace);
      if (init.exitCode !== 0) {
        throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
          retryable: true,
        });
      }

      const declared = await this.tfvarsFromState(directory);
      if (!declared) {
        return {
          result: failure(
            FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
            'TERRAFORM_STATE_ABSENT',
            'The instance has no Terraform state to verify against.',
          ),
        };
      }

      // Write the real variables into *this* directory, so the plan compares the module against
      // what was actually declared rather than against the placeholder values used to read state.
      await this.runner.writeVariables(directory, declared);
      const { gate, invocation } = await this.runner.plan(directory);

      const converged =
        gate.decision === 'allowed' &&
        (gate.actionCounts.create ?? 0) === 0 &&
        (gate.actionCounts.update ?? 0) === 0 &&
        (gate.actionCounts.delete ?? 0) === 0;

      if (!converged) {
        return {
          result: failure(
            FailureCategory.FAILURE_CATEGORY_PERMANENT,
            'TERRAFORM_NOT_CONVERGED',
            'The instance does not match its declared configuration.',
          ),
        };
      }

      void invocation;
      return {
        result: {
          state: ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
          providerResourceId: String(declared.vm_id),
          evidenceId: randomUUID(),
        },
      };
    } finally {
      await this.runner.discard(directory).catch(() => undefined);
    }
  }

  /**
   * Powers an instance on.
   *
   * @param request The power request.
   * @returns `ACCEPTED` with a run reference, or `SUCCEEDED` when already in that state.
   */
  /**
   * WHY the wrapper type is named explicitly here and in the three methods below: the four power
   * RPCs carry their payload nested under a `request` field, and these four declared the *inner*
   * type and read `context` straight off it. TypeScript never objected, because method parameters
   * are bivariant — a method taking a narrower parameter still satisfies the interface — so the
   * mismatch compiled, passed every unit test written against the same wrong shape, and passed an
   * in-process verifier that happened to call with the unwrapped object. Over real gRPC, `context`
   * was `undefined`, the profile assertion refused the call, and a create that had already built
   * and configured a VM failed at the power stage with "Provider profile is not allowlisted".
   *
   * The direct adapter had it right all along, which is the useful lesson: when two adapters
   * implement one port and only one of them is exercised end to end, the untested one drifts.
   */
  public async startInstance(request: StartInstanceRequest): Promise<StartInstanceResponse> {
    return this.setPowerState(request.request ?? {}, true);
  }

  /**
   * Changes the declared power state.
   *
   * WHY this reads Terraform state first: the port hands a power request only an instance id and
   * its ownership markers, because an imperative provider needs nothing else. A declarative one
   * needs the *whole* desired state — omit an attribute and Terraform plans to clear it. Terraform
   * 's own state is where that comes from, which is the deeper reason `observeInstance` reads it
   * too.
   */
  private async setPowerState(
    request: InstanceMutationRequest,
    started: boolean,
  ): Promise<StartInstanceResponse> {
    const context = request.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    const operationId = context?.operationId;
    if (!instanceId || !operationId) {
      throw new ProviderTransportError(
        'protocol_error',
        'context.instanceId and context.operationId are required.',
        { retryable: false },
      );
    }

    const workspace = workspaceNameFor(instanceId);
    const directory = await this.runner.prepare(workspace, this.probeTfvars());
    const init = await this.runner.init(directory, workspace);
    if (init.exitCode !== 0) {
      await this.runner.discard(directory).catch(() => undefined);
      throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
        retryable: true,
      });
    }

    const declared = await this.tfvarsFromState(directory);
    if (!declared) {
      await this.runner.discard(directory).catch(() => undefined);
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
          'TERRAFORM_STATE_ABSENT',
          'The instance has no Terraform state to change.',
        ),
      };
    }

    if (declared.started === started) {
      // Already in the requested state. Reporting success rather than applying a no-op keeps a
      // duplicate delivery from producing a second run row for work nobody did.
      await this.runner.discard(directory).catch(() => undefined);
      return {
        result: {
          state: ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
          providerResourceId: String(declared.vm_id),
          evidenceId: randomUUID(),
        },
      };
    }

    return this.startApply({
      instanceId,
      operationId,
      workspace,
      vmId: Number(declared.vm_id),
      tfvars: { ...declared, started },
      fencingToken: fencingTokenFrom(context),
    });
  }

  /** Powers an instance off gracefully, which is what `started = false` means to this provider. */
  public async shutdownInstance(request: ShutdownInstanceRequest): Promise<StartInstanceResponse> {
    return this.setPowerState(request.request ?? {}, false);
  }

  /**
   * Stops an instance without waiting for the guest.
   *
   * Direct API, because `started = false` is a *graceful* shutdown and a hard stop is a different
   * operation with different consequences for the guest. Conflating them would mean a caller
   * asking for one and silently getting the other.
   */
  public async stopInstance(request: StopInstanceRequest): Promise<StartInstanceResponse> {
    return this.directMutation(request.request ?? {}, (client, vmid) => client.stopHard(vmid));
  }

  /**
   * Reboots an instance.
   *
   * Direct API, because a reboot leaves the desired state exactly as it was: there is nothing for
   * Terraform to converge to.
   */
  public async rebootInstance(request: RebootInstanceRequest): Promise<StartInstanceResponse> {
    return this.directMutation(request.request ?? {}, (client, vmid) => client.reboot(vmid));
  }

  /**
   * Changes CPU, memory, or disk size.
   *
   * Disk growth only. The refusal is asserted here rather than left to the provider, and that
   * ordering matters: bpg does refuse a shrink at apply time, but it was measured writing the
   * rejected size into state first, leaving state disagreeing with the server until a refresh.
   * Refusing before the plan is what keeps state honest.
   */
  public async resizeInstance(request: ResizeInstanceRequest): Promise<ResizeInstanceResponse> {
    const mutation = request.request;
    const context = mutation?.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    const operationId = context?.operationId;
    if (!instanceId || !operationId) {
      throw new ProviderTransportError(
        'protocol_error',
        'context.instanceId and context.operationId are required.',
        { retryable: false },
      );
    }

    const workspace = workspaceNameFor(instanceId);
    const directory = await this.runner.prepare(workspace, this.probeTfvars());
    const init = await this.runner.init(directory, workspace);
    if (init.exitCode !== 0) {
      await this.runner.discard(directory).catch(() => undefined);
      throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
        retryable: true,
      });
    }

    const declared = await this.tfvarsFromState(directory);
    if (!declared) {
      await this.runner.discard(directory).catch(() => undefined);
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
          'TERRAFORM_STATE_ABSENT',
          'The instance has no Terraform state to resize.',
        ),
      };
    }

    const target = request.targetResources;
    const requestedDisk = target?.diskGib === undefined ? undefined : Number(target.diskGib);
    if (requestedDisk !== undefined && requestedDisk < declared.disk_gib) {
      await this.runner.discard(directory).catch(() => undefined);
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_VALIDATION,
          'DISK_SHRINK_FORBIDDEN',
          'Disk size can grow but never shrink.',
        ),
      };
    }

    return this.startApply({
      instanceId,
      operationId,
      workspace,
      vmId: Number(declared.vm_id),
      tfvars: {
        ...declared,
        ...(target?.cpuCount === undefined ? {} : { cpu_cores: target.cpuCount }),
        ...(target?.memoryMib === undefined ? {} : { memory_mib: Number(target.memoryMib) }),
        ...(requestedDisk === undefined ? {} : { disk_gib: requestedDisk }),
      },
      fencingToken: fencingTokenFrom(context),
    });
  }

  /** Lists an instance's snapshots. Direct API: this provider has no snapshot data source. */
  public async listSnapshots(request: ListSnapshotsRequest): Promise<ListSnapshotsResponse> {
    const context = request.context;
    this.assertProfile(context?.providerProfileId);
    const vmid = this.assertVmid(request.providerResourceId);
    await this.assertLiveOwnership(vmid, request.expectedOwnershipMarkers);

    const snapshots = await this.direct().listSnapshots(vmid);
    return {
      snapshots: snapshots.map(
        (snapshot: { name: string; description?: string; snaptime?: number }) => ({
          snapshotId: snapshot.name,
          name: snapshot.name,
          ...(snapshot.description ? { description: snapshot.description } : {}),
          createdAt: new Date((snapshot.snaptime ?? 0) * 1000).toISOString(),
        }),
      ),
      observedAt: new Date().toISOString(),
    };
  }

  /** Takes a snapshot. */
  public async createSnapshot(request: CreateSnapshotRequest): Promise<CreateSnapshotResponse> {
    return this.snapshotMutation(request.request, (client, vmid) =>
      client.createSnapshot(vmid, required(request.name, 'name'), request.description),
    );
  }

  /**
   * Rolls an instance back to a snapshot.
   *
   * The most state-invalidating operation in the system: it reverts disk and configuration to an
   * earlier moment and Terraform learns nothing about it. The workspace is therefore marked
   * `drifted` until a refresh proves otherwise, which is stronger than the refresh every other
   * direct mutation gets.
   */
  public async rollbackSnapshot(
    request: RollbackSnapshotRequest,
  ): Promise<RollbackSnapshotResponse> {
    const mutation = request.request;
    return this.snapshotMutation(
      mutation?.request,
      (client, vmid) =>
        client.rollbackSnapshot(
          vmid,
          required(mutation?.providerSnapshotReference, 'providerSnapshotReference'),
        ),
      'drifted',
    );
  }

  /** Deletes a snapshot. */
  public async deleteSnapshot(request: DeleteSnapshotRequest): Promise<DeleteSnapshotResponse> {
    const mutation = request.request;
    return this.snapshotMutation(mutation?.request, (client, vmid) =>
      client.deleteSnapshot(
        vmid,
        required(mutation?.providerSnapshotReference, 'providerSnapshotReference'),
      ),
    );
  }

  /**
   * Marks an instance retained: soft delete.
   *
   * SAFE-028 — detach access, retain the resource. `on_boot` is cleared so a host restart does
   * not bring it back, and the retention deadline is appended to the description as a trailer
   * beneath the ownership marker. **The marker itself is preserved**, because a later purge has
   * to prove live ownership and cannot do that against a description it can no longer parse.
   */
  public async markInstanceRetained(
    request: MarkInstanceRetainedRequest,
  ): Promise<MarkInstanceRetainedResponse> {
    const mutation = request.request;
    const context = mutation?.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    const operationId = context?.operationId;
    const markers = mutation?.expectedOwnershipMarkers;
    if (!instanceId || !operationId || !markers) {
      throw new ProviderTransportError(
        'protocol_error',
        'context and ownership markers are required.',
        { retryable: false },
      );
    }

    const workspace = workspaceNameFor(instanceId);
    const directory = await this.runner.prepare(workspace, this.probeTfvars());
    const init = await this.runner.init(directory, workspace);
    if (init.exitCode !== 0) {
      await this.runner.discard(directory).catch(() => undefined);
      throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
        retryable: true,
      });
    }

    const declared = await this.tfvarsFromState(directory);
    if (!declared) {
      await this.runner.discard(directory).catch(() => undefined);
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
          'TERRAFORM_STATE_ABSENT',
          'The instance has no Terraform state to retain.',
        ),
      };
    }

    return this.startApply({
      instanceId,
      operationId,
      workspace,
      vmId: Number(declared.vm_id),
      tfvars: {
        ...declared,
        on_boot: false,
        started: false,
        ownership_marker: describedWithTrailer(
          markers,
          RETENTION_TRAILER_KEY,
          request.retentionDeadline ?? '',
        ),
      },
      fencingToken: fencingTokenFrom(context),
    });
  }

  /**
   * Destroys an instance. The one authorized destructive operation.
   *
   * Three things must line up before anything is destroyed: the caller must be the purge path, so
   * the purge module is used rather than the protected one; live ownership must be provable from
   * the VM's own description (SAFE-006); and the plan gate must be given `allowDestroyOf` naming
   * this exact resource address, so a plan that would also destroy something else is still
   * refused.
   */
  public async purgeInstance(request: PurgeInstanceRequest): Promise<PurgeInstanceResponse> {
    const mutation = request.request;
    const context = mutation?.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    const operationId = context?.operationId;
    const markers = mutation?.expectedOwnershipMarkers;
    if (!instanceId || !operationId || !markers) {
      throw new ProviderTransportError(
        'protocol_error',
        'context and ownership markers are required.',
        { retryable: false },
      );
    }
    if (!request.purgeAuthorizationId) {
      // SAFE-006's first half: a purge without an authorization record is not a purge.
      throw new ProviderTransportError('protocol_error', 'purgeAuthorizationId is required.', {
        retryable: false,
      });
    }

    const vmid = this.assertVmid(mutation?.providerResourceId);
    // SAFE-006's second half, and it is read from the live VM rather than from state: state is
    // this system's belief, and a purge must be justified by what is actually there.
    await this.assertLiveOwnership(vmid, markers);

    const workspace = workspaceNameFor(instanceId);
    const directory = await this.runner.prepare(workspace, this.probeTfvars(), true);
    const init = await this.runner.init(directory, workspace);
    if (init.exitCode !== 0) {
      await this.runner.discard(directory).catch(() => undefined);
      throw new ProviderTransportError('unavailable', 'The state backend is unreachable.', {
        retryable: true,
      });
    }
    const declared = await this.tfvarsFromState(directory);

    if (!declared) {
      await this.runner.discard(directory).catch(() => undefined);
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_UNKNOWN_OUTCOME,
          'TERRAFORM_STATE_ABSENT',
          'The instance has no Terraform state to purge.',
        ),
      };
    }

    return this.startApply({
      instanceId,
      operationId,
      workspace,
      vmId: Number(declared.vm_id),
      tfvars: declared,
      fencingToken: fencingTokenFrom(context),
      purge: true,
    });
  }

  /** Polls a Proxmox task belonging to the direct client. */
  private async directTaskState(upid: string, observedAt: string): Promise<GetTaskResponse> {
    const state = await this.direct().taskState(upid);
    if (state === 'running') {
      return { state: ProviderTaskState.PROVIDER_TASK_STATE_RUNNING, observedAt };
    }
    if (state === 'succeeded') {
      return { state: ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED, observedAt };
    }
    return {
      state: ProviderTaskState.PROVIDER_TASK_STATE_FAILED,
      failure: {
        category: FailureCategory.FAILURE_CATEGORY_PERMANENT,
        code: 'PROXMOX_TASK_FAILED',
        safeMessage: 'The provider task failed.',
      },
      observedAt,
    };
  }

  /**
   * Runs one direct-API mutation and schedules the refresh it makes necessary.
   *
   * The refresh is the point. Terraform did not make this change and has no way to know about it,
   * so state is stale the moment the call returns. Design §6.4 requires a `-refresh-only` after
   * every direct mutation, and doing it here rather than asking each caller to remember is the
   * difference between a rule and a hope.
   */
  private async directMutation(
    request: InstanceMutationRequest,
    act: (client: ProxmoxDirectClient, vmid: number) => Promise<string>,
    driftState: 'in_sync' | 'drifted' = 'in_sync',
  ): Promise<StartInstanceResponse> {
    const context = request.context;
    this.assertProfile(context?.providerProfileId);
    const instanceId = context?.instanceId;
    if (!instanceId) {
      throw new ProviderTransportError('protocol_error', 'context.instanceId is required.', {
        retryable: false,
      });
    }
    const vmid = this.assertVmid(request.providerResourceId);
    await this.assertLiveOwnership(vmid, request.expectedOwnershipMarkers);

    const upid = await act(this.direct(), vmid);

    // Not awaited: the refresh is bookkeeping, and the caller is waiting on the mutation.
    void this.refreshAfterDirectMutation(instanceId, driftState);

    return {
      result: {
        state: ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
        providerResourceId: String(vmid),
        providerTaskReference: `${DIRECT_TASK_PREFIX}${upid}`,
        evidenceId: randomUUID(),
      },
    };
  }

  /** A snapshot mutation, which is a direct mutation with the port's nested request shape. */
  private async snapshotMutation(
    mutation: InstanceMutationRequest | undefined,
    act: (client: ProxmoxDirectClient, vmid: number) => Promise<string>,
    driftState: 'in_sync' | 'drifted' = 'in_sync',
  ): Promise<CreateSnapshotResponse> {
    if (!mutation) {
      throw new ProviderTransportError('protocol_error', 'request is required.', {
        retryable: false,
      });
    }
    return this.directMutation(mutation, act, driftState);
  }

  /** Refreshes state after a change Terraform did not make, and records what it found. */
  private async refreshAfterDirectMutation(
    instanceId: string,
    driftState: 'in_sync' | 'drifted',
  ): Promise<void> {
    const workspace = workspaceNameFor(instanceId);
    let directory;
    try {
      directory = await this.runner.prepare(workspace, this.probeTfvars());
      const init = await this.runner.init(directory, workspace);
      if (init.exitCode !== 0) return;
      await this.runner.refresh(directory);
      // A refresh writes state, so it advances the serial. Recording it here is what keeps the
      // inventory's serial meaningful: a serial that only moved on applies could not distinguish
      // "nothing has happened" from "nobody has looked".
      const state = await this.runner.stateMetadata(directory);
      await this.runs.recordWorkspace({
        instanceId,
        workspaceName: workspace,
        refreshed: true,
        driftState,
        ...(state.serial === undefined ? {} : { stateSerial: state.serial }),
        ...(state.lineage === undefined ? {} : { stateLineage: state.lineage }),
      });
    } catch {
      // A failed refresh must not fail the mutation that already succeeded. It does mean state
      // cannot be trusted, so the workspace is marked unknown rather than left claiming in sync.
      await this.runs
        .recordWorkspace({ instanceId, workspaceName: workspace, driftState: 'unknown' })
        .catch(() => undefined);
    } finally {
      if (directory) await this.runner.discard(directory).catch(() => undefined);
    }
  }

  /**
   * Proves ownership from the live VM, not from state.
   *
   * State is this system's belief about a VM. A destructive operation has to be justified by what
   * is actually there, which is why SAFE-006 asks for both and why this reads the description
   * directly.
   */
  private async assertLiveOwnership(
    vmid: number,
    expected: OwnershipMarkers | undefined,
  ): Promise<void> {
    if (!expected) {
      throw new ProviderTransportError('protocol_error', 'Ownership markers are required.', {
        retryable: false,
      });
    }
    const config = await this.direct().config(vmid);
    const description = typeof config?.description === 'string' ? config.description : undefined;
    if (!markersMatch(parseOwnership(description), expected)) {
      throw new ProviderTransportError(
        'protocol_error',
        'Provider ownership could not be proven.',
        { retryable: false },
      );
    }
  }

  /** The direct client, which is only configured when the six operations are reachable. */
  private direct(): ProxmoxDirectClient {
    if (!this.directClient) {
      throw new ProviderTransportError(
        'protocol_error',
        'This deployment has no direct Proxmox client, so snapshots, reboot and hard stop are unavailable.',
        { retryable: false },
      );
    }
    return this.directClient;
  }

  /** Refuses a VMID outside the reservation. */
  private assertVmid(value: string | undefined): number {
    const vmid = Number(value);
    if (
      !Number.isSafeInteger(vmid) ||
      vmid < this.configuration.resourceIdMinimum ||
      vmid > this.configuration.resourceIdMaximum
    ) {
      throw new ProviderTransportError('protocol_error', 'VMID is outside the reserved range.', {
        retryable: false,
      });
    }
    return vmid;
  }

  /**
   * Reconstructs the declared variables from Terraform state.
   *
   * State holds every attribute of the resource, which is exactly what a declarative mutation
   * needs and what the imperative port does not carry. The allowlisted values are taken from
   * configuration rather than from state, so a state document someone edited cannot widen the
   * boundary.
   *
   * @param directory A prepared, initialised directory.
   * @returns The variables, or `undefined` when the workspace holds no instance.
   */
  private async tfvarsFromState(directory: string): Promise<InstanceTfvars | undefined> {
    const state = await this.readState(directory);
    const values = state?.values?.root_module?.resources?.find(
      (entry) => entry.address === INSTANCE_ADDRESS,
    )?.values;
    if (!values) return undefined;

    const initialization = block(values.initialization);
    const ipv4 = block(block(initialization?.ip_config)?.ipv4);
    const account = block(initialization?.user_account);
    const cpu = block(values.cpu);
    const memory = block(values.memory);
    const disk = block(values.disk);

    const address = String(ipv4?.address ?? '');
    const [ipv4Address, prefix] = address.split('/');

    return {
      // Allowlisted values come from configuration, never from state. A state document an
      // operator edited must not be able to move this instance to another node or storage.
      node_name: this.configuration.node,
      template_vm_id: this.configuration.templateVmid,
      datastore_id: this.configuration.storage,
      disk_interface: this.configuration.diskInterface,
      disk_format: this.configuration.templateDiskFormat,
      bridge: this.configuration.bridge,
      network_mtu: this.configuration.networkMtu,
      dns_domain: this.configuration.dnsDomain,
      cloud_init_username: this.configuration.cloudInitUsername,
      // Never read back from state either: Proxmox does not return it, so state's copy is the
      // only one and configuration is the authority.
      cloud_init_password: this.configuration.cloudInitPassword,

      vm_id: Number(values.vm_id ?? this.configuration.resourceIdMinimum),
      hostname: String(values.name ?? 'instance'),
      ownership_marker: String(values.description ?? ''),
      tags: Array.isArray(values.tags) ? values.tags.map(String) : [],
      disk_gib: Number(disk?.size ?? 0),
      cpu_cores: Number(cpu?.cores ?? 1),
      memory_mib: Number(memory?.dedicated ?? 512),
      ipv4_address: ipv4Address ?? '',
      ipv4_prefix_length: Number(prefix ?? 0),
      ipv4_gateway: String(ipv4?.gateway ?? this.configuration.ipv4Gateway),
      dns_servers: dnsServers(initialization) ?? ['1.1.1.1'],
      ssh_public_keys: Array.isArray(account?.keys) ? account.keys.map(String) : [],
      started: values.started === true,
      on_boot: values.on_boot === true,
    };
  }

  /** Reads the workspace's state document. */
  private async readState(directory: string): Promise<TerraformState | undefined> {
    const shown = await this.runner.showState(directory);
    if (shown.exitCode !== 0) return undefined;
    try {
      return JSON.parse(shown.stdout) as TerraformState;
    } catch {
      return undefined;
    }
  }

  /** The observation for a workspace whose resource does not exist. */
  private absent(): InstanceObservation {
    return {
      exists: false,
      powerState: ObservedPowerState.OBSERVED_POWER_STATE_UNKNOWN,
      ownership: { complete: false, match: false },
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Variables sufficient to initialise a workspace for a read.
   *
   * A read still needs a complete variable file, because Terraform validates variables before it
   * will do anything at all. These are the allowlisted values with a placeholder identity: no
   * plan produced from them is ever applied, and the VMID is the bottom of the reserved interval
   * so that even a mistake could not name a machine outside it.
   */
  private probeTfvars() {
    return {
      node_name: this.configuration.node,
      template_vm_id: this.configuration.templateVmid,
      vm_id: this.configuration.resourceIdMinimum,
      hostname: 'probe',
      ownership_marker: 'private-cloud-control:{}',
      tags: [this.configuration.managedBy],
      datastore_id: this.configuration.storage,
      disk_interface: this.configuration.diskInterface,
      disk_format: this.configuration.templateDiskFormat,
      disk_gib: 32,
      cpu_cores: 1,
      memory_mib: 512,
      bridge: this.configuration.bridge,
      network_mtu: this.configuration.networkMtu,
      ipv4_address: this.configuration.ipv4Gateway,
      ipv4_prefix_length: Number(this.configuration.ipv4Cidr.split('/')[1] ?? 24),
      ipv4_gateway: this.configuration.ipv4Gateway,
      dns_servers: ['1.1.1.1'],
      dns_domain: this.configuration.dnsDomain,
      cloud_init_username: this.configuration.cloudInitUsername,
      cloud_init_password: this.configuration.cloudInitPassword,
      ssh_public_keys: [],
      started: false,
      on_boot: false,
    };
  }

  /** Refuses a profile this deployment does not serve. */
  private assertProfile(profileId: string | undefined): void {
    if (profileId !== this.configuration.providerProfileId) {
      throw new ProviderTransportError('protocol_error', 'Provider profile is not allowlisted.', {
        retryable: false,
      });
    }
  }
}
