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
  type ObserveInstanceRequest,
  type ObserveInstanceResponse,
  type OwnershipMarkers,
  type SubmitCreateInstanceRequest,
  type SubmitCreateInstanceResponse,
  type ValidateProfileRequest,
  type ValidateProfileResponse,
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
} from './proxmox-provider.js';
import { workspaceNameFor, type InstanceTfvars } from './terraform/tfvars.js';
import type { TerraformRunner } from './terraform/runner.js';

/** The allowlist this adapter is confined to. Mirrors the direct adapter's, minus the HTTP parts. */
export interface TerraformProxmoxConfiguration {
  readonly providerProfileId: string;
  readonly projectId: string;
  readonly node: string;
  readonly templateVmid: number;
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
  }): Promise<void>;
}

/** The reserved VMID interval, clamped regardless of configuration. */
const RESERVED_VMID_MINIMUM = 910_000;
const RESERVED_VMID_MAXIMUM = 910_099;

/** The resource address the module declares, which every plan and state read refers to. */
export const INSTANCE_ADDRESS = 'proxmox_virtual_environment_vm.instance';

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
        // Snapshots are not in this provider at all — bpg publishes no snapshot resource and no
        // snapshot data source. They are served by the narrowed direct client, so this adapter
        // reports them as unsupported rather than claiming work it cannot do.
        snapshots: false,
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
    try {
      const directory = await this.runner.prepare(probeWorkspace, this.probeTfvars());
      const init = await this.runner.init(directory, probeWorkspace);
      checks.push({
        name: 'terraform_init',
        state:
          init.exitCode === 0
            ? ValidationCheckState.VALIDATION_CHECK_STATE_PASSED
            : ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
        safeSummary:
          init.exitCode === 0
            ? 'The state backend and the module initialised.'
            : (init.diagnostics[0]?.summary ?? `Terraform init exited ${init.exitCode}.`),
      });

      if (init.exitCode === 0) {
        const { gate, invocation } = await this.runner.plan(directory);
        // A plan against an empty workspace should propose exactly one create. Anything else
        // means the module and the variables disagree, which is a configuration fault worth
        // catching here rather than inside a workflow.
        const proposesOneCreate =
          gate.decision === 'allowed' && (gate.actionCounts.create ?? 0) === 1;
        checks.push({
          name: 'module_plan',
          state: proposesOneCreate
            ? ValidationCheckState.VALIDATION_CHECK_STATE_PASSED
            : ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
          safeSummary: proposesOneCreate
            ? 'The module proposes exactly one create against an empty workspace.'
            : gate.summary || `Terraform plan exited ${invocation.exitCode}.`,
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
      await this.runner.discard(probeWorkspace).catch(() => undefined);
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

    const run = await this.runs.readRun(reference);
    const observedAt = new Date().toISOString();

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

    return {
      state: ProviderTaskState.PROVIDER_TASK_STATE_FAILED,
      failure: {
        category: FailureCategory.FAILURE_CATEGORY_PERMANENT,
        code: 'TERRAFORM_RUN_FAILED',
        safeMessage: 'The Terraform run failed.',
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
          ownership: {
            complete: actual !== null,
            match: expected ? markersMatch(actual, expected as OwnershipMarkers) : false,
            ...(actual ? { values: actual } : {}),
          },
          observedAt: new Date().toISOString(),
        },
      };
    } finally {
      await this.runner.discard(workspace).catch(() => undefined);
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
      fencingToken: context?.attempt ?? 1,
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
        await this.runs.recordWorkspace({
          instanceId: input.instanceId,
          workspaceName: input.workspace,
          lastRunId: runId,
          applied: true,
          driftState: 'in_sync',
        });
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
