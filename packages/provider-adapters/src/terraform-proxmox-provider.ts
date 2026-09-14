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
import { randomUUID } from 'node:crypto';
import { FailureCategory, ObservedPowerState } from '@private-cloud/contracts';
import {
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
  type ValidateProfileRequest,
  type ValidateProfileResponse,
} from '@private-cloud/contracts/provider';
import { ProviderTransportError, type ProviderCallOptions } from '@private-cloud/provider-sdk';
import {
  MAXIMUM_CPU_COUNT,
  MAXIMUM_DISK_GIB,
  MAXIMUM_MEMORY_MIB,
  MAXIMUM_SNAPSHOTS,
  markersMatch,
  parseOwnership,
} from './proxmox-provider.js';
import { workspaceNameFor } from './terraform/tfvars.js';
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
    private readonly runs: TerraformRunReader,
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
