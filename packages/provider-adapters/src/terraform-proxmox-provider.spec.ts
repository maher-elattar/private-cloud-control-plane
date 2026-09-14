/**
 * The Terraform adapter's read path.
 *
 * The cases worth their place are the ones about *classification*: whether a refused plan is a
 * terminal failure or a poll-forever state, whether a missing run is failed or unknown, and
 * whether an unproven ownership marker reads as a match. Each of those decides what a workflow
 * does next, and getting one wrong either abandons a live instance or loops on it.
 *
 * @see packages/provider-adapters/src/terraform-proxmox-provider.ts
 */
import {
  ProviderResultState,
  ProviderTaskState,
  ValidationCheckState,
} from '@private-cloud/contracts/provider';
import { FailureCategory, ObservedPowerState } from '@private-cloud/contracts';
import { describe, expect, it } from 'vitest';
import {
  INSTANCE_ADDRESS,
  TerraformProxmoxProvider,
  type TerraformProxmoxConfiguration,
  type TerraformRunReader,
  type TerraformRunStore,
} from './terraform-proxmox-provider.js';
import type { TerraformRunner } from './terraform/runner.js';

const configuration: TerraformProxmoxConfiguration = {
  providerProfileId: 'proxmox-testsrv',
  projectId: '00000000-0000-4000-8000-0000000000a1',
  node: 'proxtest',
  templateVmid: 110,
  imageId: 'ubuntu-noble-2404',
  storage: 'local',
  diskInterface: 'scsi0',
  bridge: 'vmbr1',
  networkMtu: 1400,
  networkId: 'testsrv-vmbr1',
  ipv4Cidr: '192.168.4.0/22',
  ipv4Gateway: '192.168.4.1',
  dnsDomain: 'lab.invalid',
  cloudInitUsername: 'ubuntu',
  cloudInitPassword: 'example-password',
  resourceIdMinimum: 910_000,
  resourceIdMaximum: 910_099,
  environment: 'lab',
  managedBy: 'private-cloud-control-plane',
};

const ownership = {
  managedBy: 'private-cloud-control-plane',
  environment: 'lab',
  projectId: configuration.projectId,
  instanceId: '00000000-0000-4000-8000-0000000000bb',
  createOperationId: '00000000-0000-4000-8000-0000000000cc',
};

const context = {
  requestId: 'request:observe',
  operationId: ownership.createOperationId,
  correlationId: '00000000-0000-4000-8000-0000000000dd',
  projectId: configuration.projectId,
  instanceId: ownership.instanceId,
  providerProfileId: configuration.providerProfileId,
  attempt: 1,
};

/** A runner double that answers with scripted state and records nothing. */
function runnerDouble(overrides: Partial<TerraformRunner> = {}): TerraformRunner {
  return {
    prepare: async () => '/tmp/workspace',
    discard: async () => undefined,
    init: async () => ({ command: 'init', exitCode: 0, diagnostics: [], durationMs: 1 }),
    refresh: async () => ({ command: 'refresh', exitCode: 0, diagnostics: [], durationMs: 1 }),
    showState: async () => ({
      command: 'show-state',
      exitCode: 0,
      diagnostics: [],
      durationMs: 1,
      stdout: '{}',
    }),
    plan: async () => ({
      gate: { decision: 'allowed', actionCounts: { create: 1 }, objections: [], summary: 'ok' },
      invocation: { command: 'plan', exitCode: 0, diagnostics: [], durationMs: 1 },
    }),
    apply: async () => ({ command: 'apply', exitCode: 0, diagnostics: [], durationMs: 1 }),
    ...overrides,
  } as unknown as TerraformRunner;
}

/** Everything the store recorded, so the create cases can assert the ordering. */
interface RecordedRuns {
  readonly begun: unknown[];
  readonly completed: unknown[];
  readonly workspaces: unknown[];
}

/** A store double that answers reads with one scripted run and records every write. */
function runsDouble(
  run: Awaited<ReturnType<TerraformRunReader['readRun']>>,
  recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] },
): TerraformRunStore {
  return {
    readRun: async () => run,
    beginRun: async (input) => {
      recorded.begun.push(input);
    },
    completeRun: async (input) => {
      recorded.completed.push(input);
    },
    recordWorkspace: async (input) => {
      recorded.workspaces.push(input);
    },
  };
}

function provider(
  runner = runnerDouble(),
  runs: TerraformRunStore = runsDouble(null),
): TerraformProxmoxProvider {
  return new TerraformProxmoxProvider(configuration, runner, runs);
}

describe('construction', () => {
  it('refuses a VMID interval outside the reservation', () => {
    expect(
      () =>
        new TerraformProxmoxProvider(
          { ...configuration, resourceIdMinimum: 100 },
          runnerDouble(),
          runsDouble(null),
        ),
    ).toThrow(/910000-910099/);
  });

  it('refuses a blank cloud-init password', () => {
    // A blank password reaches cloud-init and state, and produces a guest nobody can log into
    // while looking configured.
    expect(
      () =>
        new TerraformProxmoxProvider(
          { ...configuration, cloudInitPassword: '' },
          runnerDouble(),
          runsDouble(null),
        ),
    ).toThrow(/password is required/);
  });
});

describe('getCapabilities', () => {
  it('is async, so a rejected profile does not escape a caller catch', async () => {
    // The readiness-probe defect: a synchronous throw escapes `.catch()` chained onto the call.
    const promise = provider().getCapabilities({ requestId: 'probe' });
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow(/not allowlisted/);
  });

  it('reports snapshots as unsupported, because this provider has no snapshot resource', async () => {
    const { capabilities } = await provider().getCapabilities({
      requestId: 'probe',
      providerProfileId: configuration.providerProfileId,
    });
    expect(capabilities?.snapshots).toBe(false);
    // Everything Terraform genuinely can do is reported true, so a caller gating on these flags
    // does not refuse work the adapter can perform.
    expect(capabilities?.createInstance).toBe(true);
    expect(capabilities?.resizeCompute).toBe(true);
    expect(capabilities?.growDisk).toBe(true);
    expect(capabilities?.purge).toBe(true);
  });
});

describe('getTask', () => {
  const request = { context, providerTaskReference: 'run-1' };

  it('reports a running run as running', async () => {
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'running',
        command: 'apply',
        gateDecision: null,
        gateRule: null,
        exitCode: null,
        diagnostics: null,
      }),
    ).getTask(request);
    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_RUNNING);
  });

  it('reports a succeeded run as succeeded', async () => {
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'succeeded',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: 0,
        diagnostics: null,
      }),
    ).getTask(request);
    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED);
  });

  it('reports a refused plan as a permanent failure, not as still running', async () => {
    // The classification that matters most here. The gate refusing is terminal — nothing was
    // applied and a retry reaches the same refusal — so reporting it as running would leave the
    // workflow polling forever.
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'failed',
        command: 'plan',
        gateDecision: 'refused_destructive',
        gateRule: 'replace_because_tainted',
        exitCode: 0,
        diagnostics: null,
      }),
    ).getTask(request);

    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_FAILED);
    expect(response.failure?.code).toBe('TERRAFORM_PLAN_REFUSED');
  });

  it('reports a locked-template clone failure as transient, not permanent', async () => {
    // Found live: a run started seconds after a previous destroy failed its clone because the
    // template was still locked, and an identical re-run succeeded. Classifying that as permanent
    // fails an instance that would have worked a moment later.
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'failed',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: 1,
        diagnostics: [
          { severity: 'error', summary: 'VM clone', detail: 'All attempts fail: VM is locked' },
        ],
      }),
    ).getTask(request);

    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_FAILED);
    expect(response.failure?.code).toBe('TERRAFORM_RUN_RETRYABLE');
    expect(response.failure?.category).toBe(FailureCategory.FAILURE_CATEGORY_TRANSIENT);
  });

  it('still reports a genuine failure as permanent', async () => {
    // The patterns must stay narrow. A broad match would retry a misconfiguration forever, which
    // is worse than failing it once.
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'failed',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: 1,
        diagnostics: [{ severity: 'error', summary: "storage 'local-lvm' does not exist" }],
      }),
    ).getTask(request);

    expect(response.failure?.code).toBe('TERRAFORM_RUN_FAILED');
    expect(response.failure?.category).toBe(FailureCategory.FAILURE_CATEGORY_PERMANENT);
  });

  it('reports an unknown run as unknown, so nothing is retried blindly', async () => {
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'unknown',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: null,
        diagnostics: null,
      }),
    ).getTask(request);
    // SAFE-018: an unknown outcome is not blindly retried.
    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_UNKNOWN);
  });

  it('reports a reference it cannot find as unknown rather than failed', async () => {
    // Guessing "failed" for a reference that may simply not be committed yet would abandon a
    // live instance.
    const response = await provider(runnerDouble(), runsDouble(null)).getTask(request);
    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_UNKNOWN);
  });

  it('refuses a missing reference', async () => {
    await expect(provider().getTask({ context })).rejects.toThrow(/Task reference is required/);
  });
});

describe('observeInstance', () => {
  /** A state document carrying one instance resource. */
  function state(values: Record<string, unknown>): string {
    return JSON.stringify({
      values: { root_module: { resources: [{ address: INSTANCE_ADDRESS, values }] } },
    });
  }

  const marker = `private-cloud-control:${JSON.stringify(ownership)}`;

  it('reports a running instance with matching ownership', async () => {
    const { observation } = await provider(
      runnerDouble({
        showState: async () => ({
          command: 'show-state',
          exitCode: 0,
          diagnostics: [],
          durationMs: 1,
          stdout: state({ vm_id: 910_000, started: true, description: marker }),
        }),
      } as Partial<TerraformRunner>),
    ).observeInstance({ context, expectedOwnershipMarkers: ownership });

    expect(observation?.exists).toBe(true);
    expect(observation?.providerResourceId).toBe('910000');
    expect(observation?.powerState).toBe(ObservedPowerState.OBSERVED_POWER_STATE_RUNNING);
    expect(observation?.ownership?.match).toBe(true);
  });

  it('reports a stopped instance', async () => {
    const { observation } = await provider(
      runnerDouble({
        showState: async () => ({
          command: 'show-state',
          exitCode: 0,
          diagnostics: [],
          durationMs: 1,
          stdout: state({ vm_id: 910_001, started: false, description: marker }),
        }),
      } as Partial<TerraformRunner>),
    ).observeInstance({ context, expectedOwnershipMarkers: ownership });

    expect(observation?.powerState).toBe(ObservedPowerState.OBSERVED_POWER_STATE_STOPPED);
  });

  it('reports absence when state holds no instance resource', async () => {
    const { observation } = await provider().observeInstance({
      context,
      expectedOwnershipMarkers: ownership,
    });
    expect(observation?.exists).toBe(false);
    expect(observation?.ownership?.match).toBe(false);
  });

  it('reports no match when the description carries someone else markers', async () => {
    const foreign = { ...ownership, projectId: '00000000-0000-4000-8000-00000000ffff' };
    const { observation } = await provider(
      runnerDouble({
        showState: async () => ({
          command: 'show-state',
          exitCode: 0,
          diagnostics: [],
          durationMs: 1,
          stdout: state({
            vm_id: 910_000,
            started: true,
            description: `private-cloud-control:${JSON.stringify(foreign)}`,
          }),
        }),
      } as Partial<TerraformRunner>),
    ).observeInstance({ context, expectedOwnershipMarkers: ownership });

    // Complete but not matching. SAFE-005: ownership is never inferred, and a partial match is
    // treated as no match.
    expect(observation?.ownership?.complete).toBe(true);
    expect(observation?.ownership?.match).toBe(false);
  });

  it('treats an unreachable backend as retryable rather than as absence', async () => {
    // Reporting "the instance does not exist" because the state backend was down is how a
    // reconciler comes to believe a live VM is gone.
    await expect(
      provider(
        runnerDouble({
          init: async () => ({ command: 'init', exitCode: 1, diagnostics: [], durationMs: 1 }),
        } as Partial<TerraformRunner>),
      ).observeInstance({ context, expectedOwnershipMarkers: ownership }),
    ).rejects.toThrow(/state backend is unreachable/);
  });

  it('discards the workspace even when the read throws', async () => {
    let discarded = false;
    await expect(
      provider(
        runnerDouble({
          discard: async () => {
            discarded = true;
          },
          init: async () => ({ command: 'init', exitCode: 1, diagnostics: [], durationMs: 1 }),
        } as Partial<TerraformRunner>),
      ).observeInstance({ context, expectedOwnershipMarkers: ownership }),
    ).rejects.toThrow();
    // The working directory holds a tfvars file with the cloud-init password in it.
    expect(discarded).toBe(true);
  });

  it('refuses a request with no instance id', async () => {
    await expect(
      provider().observeInstance({
        context: { ...context, instanceId: undefined },
        expectedOwnershipMarkers: ownership,
      }),
    ).rejects.toThrow(/instanceId is required/);
  });
});

describe('validateProfile', () => {
  it('passes when init and the plan both behave', async () => {
    const response = await provider().validateProfile({
      profile: { providerProfileId: configuration.providerProfileId },
    });
    expect(response.valid).toBe(true);
    expect(response.checks?.map((check) => check.name)).toEqual(['terraform_init', 'module_plan']);
  });

  it('fails, without throwing, when init fails', async () => {
    const response = await provider(
      runnerDouble({
        init: async () => ({
          command: 'init',
          exitCode: 1,
          diagnostics: [{ severity: 'error', summary: 'backend unreachable' }],
          durationMs: 1,
        }),
      } as Partial<TerraformRunner>),
    ).validateProfile({ profile: { providerProfileId: configuration.providerProfileId } });

    expect(response.valid).toBe(false);
    expect(response.checks?.[0]?.state).toBe(ValidationCheckState.VALIDATION_CHECK_STATE_FAILED);
    // A partially-working deployment must be diagnosable, so the check is reported rather than
    // thrown, and the plan check is skipped rather than run against an uninitialised directory.
    expect(response.checks).toHaveLength(1);
  });

  it('fails when the module proposes anything other than one create', async () => {
    const response = await provider(
      runnerDouble({
        plan: async () => ({
          gate: {
            decision: 'allowed' as const,
            actionCounts: { create: 0, update: 1 },
            objections: [],
            summary: 'update=1',
          },
          invocation: { command: 'plan', exitCode: 0, diagnostics: [], durationMs: 1 },
        }),
      } as Partial<TerraformRunner>),
    ).validateProfile({ profile: { providerProfileId: configuration.providerProfileId } });

    // An empty workspace that plans an update means the module and the variables disagree, which
    // is a configuration fault worth catching before a workflow depends on it.
    expect(response.valid).toBe(false);
  });
});

describe('submitCreateInstance', () => {
  const request = {
    context,
    imageId: configuration.imageId,
    flavorId: 'lab-small',
    hostname: 'tf-create-01',
    resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
    network: {
      networkId: configuration.networkId,
      ipv4Address: '192.168.4.2',
      ipv4PrefixLength: 22,
      ipv4Gateway: '192.168.4.1',
      dnsServers: ['1.1.1.1'],
    },
    sshPublicKeys: [],
    ownershipMarkers: ownership,
  };

  /** Waits for the un-awaited background apply to settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('records the run before returning, and returns the run id as the task reference', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const response = await provider(
      runnerDouble(),
      runsDouble(null, recorded),
    ).submitCreateInstance(request);

    // SAFE-014: the reference the workflow will poll is durable before the caller is answered.
    expect(recorded.begun).toHaveLength(1);
    const reference = response.result?.providerTaskReference;
    expect(reference).toBeTruthy();
    expect((recorded.begun[0] as { runId: string }).runId).toBe(reference);
    await settle();
  });

  it('returns accepted without waiting for the apply', async () => {
    let applyFinished = false;
    const runner = runnerDouble({
      apply: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        applyFinished = true;
        return { command: 'apply', exitCode: 0, diagnostics: [], durationMs: 50 };
      },
    } as Partial<TerraformRunner>);

    const response = await provider(runner, runsDouble(null)).submitCreateInstance(request);

    // The port is submit-then-poll. Holding the call open for a clone plus cloud-init would tie
    // the workflow's liveness to a gRPC connection.
    expect(applyFinished).toBe(false);
    expect(response.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    await settle();
  });

  it('derives the VMID deterministically, so a replay recognises its own work', async () => {
    const first = await provider(runnerDouble(), runsDouble(null)).submitCreateInstance(request);
    await settle();
    const second = await provider(runnerDouble(), runsDouble(null)).submitCreateInstance(request);
    await settle();

    expect(first.result?.providerResourceId).toBe(second.result?.providerResourceId);
    const vmId = Number(first.result?.providerResourceId);
    expect(vmId).toBeGreaterThanOrEqual(configuration.resourceIdMinimum);
    expect(vmId).toBeLessThanOrEqual(configuration.resourceIdMaximum);
  });

  it('records a refused plan as an outcome and applies nothing', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    let applied = false;
    const runner = runnerDouble({
      plan: async () => ({
        gate: {
          decision: 'refused_destructive' as const,
          rule: 'replace_because_tainted',
          actionCounts: { create: 1, delete: 1, replace: 1 },
          objections: [{ address: INSTANCE_ADDRESS, actions: ['delete', 'create'] }],
          summary: 'would destroy',
        },
        invocation: { command: 'plan', exitCode: 0, diagnostics: [], durationMs: 1 },
      }),
      apply: async () => {
        applied = true;
        return { command: 'apply', exitCode: 0, diagnostics: [], durationMs: 1 };
      },
    } as Partial<TerraformRunner>);

    const response = await provider(runner, runsDouble(null, recorded)).submitCreateInstance(
      request,
    );

    expect(applied).toBe(false);
    // The refusal is recorded rather than merely returned: an operator needs to see it, and a
    // run row that never appeared would look like nothing was attempted.
    expect(recorded.completed).toHaveLength(1);
    expect((recorded.completed[0] as { gateDecision: string }).gateDecision).toBe(
      'refused_destructive',
    );
    expect(response.result?.failure?.code).toBe('TERRAFORM_PLAN_REFUSED');
  });

  it('records an unknown outcome when the background apply throws', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const runner = runnerDouble({
      apply: async () => {
        throw new Error('the runner died');
      },
    } as Partial<TerraformRunner>);

    await provider(runner, runsDouble(null, recorded)).submitCreateInstance(request);
    await settle();

    // `unknown`, not `failed`. The apply may have acted before the failure, and SAFE-018 forbids
    // guessing. Equally important: something was recorded at all, or the workflow polls forever.
    expect(recorded.completed).toHaveLength(1);
    expect((recorded.completed[0] as { status: string }).status).toBe('unknown');
  });

  it('marks the workspace in sync only after a successful apply', async () => {
    const succeeded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await provider(runnerDouble(), runsDouble(null, succeeded)).submitCreateInstance(request);
    await settle();
    expect((succeeded.workspaces[0] as { driftState: string }).driftState).toBe('in_sync');

    const failed: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await provider(
      runnerDouble({
        apply: async () => ({ command: 'apply', exitCode: 1, diagnostics: [], durationMs: 1 }),
      } as Partial<TerraformRunner>),
      runsDouble(null, failed),
    ).submitCreateInstance(request);
    await settle();
    // A failed apply can leave state holding a value the provider rejected, so nothing may treat
    // this workspace as in sync until a refresh has run.
    expect((failed.workspaces[0] as { driftState: string }).driftState).toBe('unknown');
  });

  it('refuses an image outside the allowlist', async () => {
    await expect(
      provider().submitCreateInstance({ ...request, imageId: 'something-else' }),
    ).rejects.toThrow(/outside the allowlist/);
  });

  it('refuses a request with no ownership markers', async () => {
    await expect(
      provider().submitCreateInstance({ ...request, ownershipMarkers: undefined }),
    ).rejects.toThrow(/Ownership markers are required/);
  });

  it('rejects rather than throws when resources are absent', async () => {
    const response = await provider().submitCreateInstance({ ...request, resources: undefined });
    expect(response.result?.failure?.code).toBe('CONFIGURATION_REQUIRED');
  });

  it('treats an unreachable backend as retryable', async () => {
    await expect(
      provider(
        runnerDouble({
          init: async () => ({ command: 'init', exitCode: 1, diagnostics: [], durationMs: 1 }),
        } as Partial<TerraformRunner>),
      ).submitCreateInstance(request),
    ).rejects.toThrow(/state backend is unreachable/);
  });
});
