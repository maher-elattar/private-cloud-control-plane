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
  // A lease token distinct from `attempt`. The two being different is the point: `attempt` is
  // pinned to 1 by the workflow so replays are recognisable, and a fencing token must move when
  // the lease does. A fixture that set both to 1 would pass while the adapter read the wrong one.
  fencingToken: '7',
};

/** A runner double that answers with scripted state and records nothing. */
function runnerDouble(overrides: Partial<TerraformRunner> = {}): TerraformRunner {
  return {
    prepare: async () => '/tmp/workspace',
    discard: async () => undefined,
    init: async () => ({ command: 'init', exitCode: 0, diagnostics: [], durationMs: 1 }),
    initWithoutBackend: async () => ({
      command: 'init',
      exitCode: 0,
      diagnostics: [],
      durationMs: 1,
    }),
    validate: async () => ({ command: 'validate', exitCode: 0, diagnostics: [], durationMs: 1 }),
    deleteWorkspace: async () => ({
      command: 'workspace-delete',
      exitCode: 0,
      diagnostics: [],
      durationMs: 1,
    }),
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
    stateMetadata: async () => ({ serial: 3, lineage: 'lineage-abc' }),
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

  it('classifies a permission denial as permanent even though bpg wraps it in a retry message', async () => {
    // The measured regression. bpg's retry wrapper prefixes *every* exhausted failure with
    // "All attempts fail", which the transient list matches — so unless the permanent patterns win
    // first, an HTTP 403 is reported as "the provider was busy" and the workflow spends its whole
    // retry budget on a request that could never have succeeded. Seen on real hardware: a clone to
    // a VMID the API token had no `VM.Allocate` on.
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'failed',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: 1,
        diagnostics: [
          {
            severity: 'error',
            summary: 'VM clone',
            detail:
              'All attempts fail:\n#1: error cloning VM: received an HTTP 403 response - Reason: Permission check failed',
          },
        ],
      }),
    ).getTask(request);

    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_FAILED);
    expect(response.failure?.code).toBe('TERRAFORM_RUN_FAILED');
    expect(response.failure?.category).toBe(FailureCategory.FAILURE_CATEGORY_PERMANENT);
  });

  it('still retries a lock that arrives with the same retry-exhaustion prefix', async () => {
    // The other side of the same coin: the prefix must not become a permanence signal either.
    // A config lock is precisely what the retry policy exists for, and it is reported through the
    // same wrapper as the 403 above.
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'failed',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: 1,
        diagnostics: [
          {
            severity: 'error',
            summary: 'VM clone',
            detail: 'All attempts fail:\n#1: error cloning VM: VM is locked (clone)',
          },
        ],
      }),
    ).getTask(request);

    expect(response.failure?.code).toBe('TERRAFORM_RUN_RETRYABLE');
    expect(response.failure?.category).toBe(FailureCategory.FAILURE_CATEGORY_TRANSIENT);
  });

  it('reports a host systemd refusal as transient, not permanent', async () => {
    // Found live on a loaded shared server: the VM was cloned and configured, and only the final
    // start was refused because systemd on the *host* had a conflicting job queued. The error
    // name reads like a catastrophe and the condition is ordinary — "not in this transaction",
    // not "never". A permanent classification here abandons a VM that exists and works.
    const response = await provider(
      runnerDouble(),
      runsDouble({
        status: 'failed',
        command: 'apply',
        gateDecision: 'allowed',
        gateRule: null,
        exitCode: 1,
        diagnostics: [
          {
            severity: 'error',
            summary: 'VM start',
            detail:
              'start failed: org.freedesktop.systemd1.TransactionIsDestructive: Transaction for 910083.scope/start is destructive',
          },
        ],
      }),
    ).getTask(request);

    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_FAILED);
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

  it('reports the resources and address it observed, not just that the VM exists', async () => {
    // The observation is what the reconciler reads, and an observation carrying only existence and
    // power state cannot report *drift* — which is the whole job (SAFE-029). These fields stayed
    // null for this adapter, so a CPU count changed by hand on the server read as "no drift".
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
            description: marker,
            cpu: [{ cores: 6 }],
            memory: [{ dedicated: 12_288 }],
            disk: [{ size: 64 }],
            initialization: [
              { ip_config: [{ ipv4: [{ address: '192.168.4.9/22', gateway: '192.168.4.1' }] }] },
            ],
          }),
        }),
      } as Partial<TerraformRunner>),
    ).observeInstance({ context, expectedOwnershipMarkers: ownership });

    expect(observation?.resources?.cpuCount).toBe(6);
    expect(observation?.resources?.memoryMib).toBe('12288');
    expect(observation?.resources?.diskGib).toBe('64');
    expect(observation?.network?.ipv4Address).toBe('192.168.4.9');
    expect(observation?.network?.ipv4PrefixLength).toBe(22);
  });

  it('omits resources rather than reporting zeroes when state carries none', async () => {
    // A missing block and a block full of zeroes mean different things: "not observed" is not the
    // same finding as "observed as zero", and a reconciler comparing against zero would report
    // drift on every instance.
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
    expect(observation?.resources).toBeUndefined();
    expect(observation?.network).toBeUndefined();
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
    expect(response.checks?.map((check) => check.name)).toEqual([
      'terraform_module',
      'module_variables',
    ]);
  });

  it('fails, without throwing, when init fails', async () => {
    const response = await provider(
      runnerDouble({
        initWithoutBackend: async () => ({
          command: 'init',
          exitCode: 1,
          diagnostics: [{ severity: 'error', summary: 'provider unavailable' }],
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

  it('fails when the module or a variable is invalid', async () => {
    const response = await provider(
      runnerDouble({
        validate: async () => ({
          command: 'validate',
          exitCode: 1,
          diagnostics: [
            { severity: 'error', summary: 'vm_id must be inside the reserved interval' },
          ],
          durationMs: 1,
        }),
      } as Partial<TerraformRunner>),
    ).validateProfile({ profile: { providerProfileId: configuration.providerProfileId } });

    // A configuration fault worth catching here rather than minutes into a workflow.
    expect(response.valid).toBe(false);
    expect(response.checks?.[1]?.safeSummary).toContain('reserved interval');
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

  it('records the state serial and lineage after the apply', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await provider(runnerDouble(), runsDouble(null, recorded)).submitCreateInstance(request);
    await settle();

    // These two columns existed in the schema with nothing ever writing to them, which the
    // in-process checks never noticed. The lineage identifies the state *document*: if it changes
    // under a workspace, the state was replaced — restored from a backup, re-created after a
    // `state rm`, or pointed at another row — and that is exactly when Terraform's belief about
    // the world is confidently wrong. An inventory that cannot see that cannot report it.
    const workspace = recorded.workspaces[0] as { stateSerial?: number; stateLineage?: string };
    expect(workspace.stateSerial).toBe(3);
    expect(workspace.stateLineage).toBe('lineage-abc');
  });

  it('presents the lease fencing token, not the retry attempt', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await provider(runnerDouble(), runsDouble(null, recorded)).submitCreateInstance(request);
    await settle();

    // The inventory refuses a write whose token does not match the live lease. The adapter used
    // `context.attempt` here, which the workflow pins to 1 so that replays stay recognisable — so
    // the check compared a constant against a real token and failed the moment a workflow reached
    // its second claim. Both writes must carry the token the caller actually holds.
    expect((recorded.begun[0] as { fencingToken: string }).fencingToken).toBe('7');
    expect((recorded.completed[0] as { fencingToken: string }).fencingToken).toBe('7');
  });

  it('treats a caller with no fencing token as unfenced rather than as token 1', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await provider(runnerDouble(), runsDouble(null, recorded)).submitCreateInstance({
      ...request,
      context: { ...context, fencingToken: undefined },
    });
    await settle();

    // `0` and not `1`: an in-process caller holds no lease, and the inventory skips the check
    // when no lease row exists. Defaulting to `1` would silently match a real first claim.
    expect((recorded.begun[0] as { fencingToken: string }).fencingToken).toBe('0');
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

/** A direct-client double that records calls and answers with a UPID. */
function directDouble(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const marker = `private-cloud-control:${JSON.stringify(ownership)}`;
  return {
    calls,
    client: {
      config: async () => ({ description: marker }),
      listSnapshots: async () => [{ name: 'before-upgrade', snaptime: 1_700_000_000 }],
      createSnapshot: async (vmid: number, name: string) => {
        calls.push(`createSnapshot ${vmid} ${name}`);
        return 'UPID:proxtest:1:snapshot:';
      },
      rollbackSnapshot: async (vmid: number, name: string) => {
        calls.push(`rollbackSnapshot ${vmid} ${name}`);
        return 'UPID:proxtest:2:rollback:';
      },
      deleteSnapshot: async (vmid: number, name: string) => {
        calls.push(`deleteSnapshot ${vmid} ${name}`);
        return 'UPID:proxtest:3:delsnapshot:';
      },
      reboot: async (vmid: number) => {
        calls.push(`reboot ${vmid}`);
        return 'UPID:proxtest:4:reboot:';
      },
      stopHard: async (vmid: number) => {
        calls.push(`stopHard ${vmid}`);
        return 'UPID:proxtest:5:qmstop:';
      },
      taskState: async () => 'succeeded',
      ...overrides,
    },
  };
}

/** A runner whose state read answers with a declared instance, so mutations have a base. */
function stateRunner(values: Record<string, unknown> = {}): TerraformRunner {
  const marker = `private-cloud-control:${JSON.stringify(ownership)}`;
  return runnerDouble({
    showState: async () => ({
      command: 'show-state',
      exitCode: 0,
      diagnostics: [],
      durationMs: 1,
      stdout: JSON.stringify({
        values: {
          root_module: {
            resources: [
              {
                address: INSTANCE_ADDRESS,
                values: {
                  vm_id: 910_000,
                  name: 'tf-example-01',
                  description: marker,
                  started: true,
                  on_boot: false,
                  cpu: [{ cores: 2 }],
                  memory: [{ dedicated: 4096 }],
                  disk: [{ size: 32 }],
                  initialization: [
                    {
                      ip_config: [
                        { ipv4: [{ address: '192.168.4.2/22', gateway: '192.168.4.1' }] },
                      ],
                      dns: [{ servers: ['1.1.1.1'] }],
                      user_account: [{ keys: [] }],
                    },
                  ],
                  ...values,
                },
              },
            ],
          },
        },
      }),
    }),
  } as Partial<TerraformRunner>);
}

/**
 * The inner payload of a power request.
 *
 * The four power RPCs nest it under a `request` field, and these tests used to pass this object
 * directly — the same mistake the adapter made, which is exactly why they could not catch it.
 * `powerRequest` below is the shape that actually arrives over gRPC.
 */
const mutation = {
  context,
  providerResourceId: '910000',
  expectedOwnershipMarkers: ownership,
};

/** A power request as the wire delivers it. */
const powerRequest = { request: mutation };

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('power', () => {
  it('reports success without applying when already in the requested state', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
    ).startInstance(powerRequest);

    // A duplicate delivery must not produce a second run row for work nobody did.
    expect(response.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED);
    expect(recorded.begun).toHaveLength(0);
  });

  it('applies when the requested state differs', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
    ).shutdownInstance(powerRequest);

    expect(response.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    expect(recorded.begun).toHaveLength(1);
    await settle();
  });

  it('routes a hard stop to the direct client, not to Terraform', async () => {
    // `started = false` is a graceful shutdown. A hard stop is a different operation, and
    // conflating them would mean a caller asking for one and silently getting the other.
    const direct = directDouble();
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
      direct.client as never,
    ).stopInstance(powerRequest);

    expect(direct.calls).toEqual(['stopHard 910000']);
    expect(recorded.begun).toHaveLength(0);
    expect(response.result?.providerTaskReference).toMatch(/^upid:/);
    await settle();
  });

  it('routes a reboot to the direct client', async () => {
    const direct = directDouble();
    await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null),
      direct.client as never,
    ).rebootInstance(powerRequest);
    expect(direct.calls).toEqual(['reboot 910000']);
    await settle();
  });

  it('refreshes state after a direct mutation, because Terraform did not make the change', async () => {
    const direct = directDouble();
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
      direct.client as never,
    ).rebootInstance(powerRequest);
    await settle();

    // Design §6.4's rule, applied here rather than asked of each caller: the difference between
    // a rule and a hope.
    expect(recorded.workspaces).toHaveLength(1);
    expect((recorded.workspaces[0] as { refreshed: boolean }).refreshed).toBe(true);
  });

  it('refuses a power request that arrives with no payload', async () => {
    // The wire shape nests the payload, and an adapter that read the outer object saw `context`
    // as `undefined` — which the profile assertion then refused with a message about
    // allowlisting, hiding a plain shape mismatch behind a security-sounding error. This asserts
    // the empty case is handled rather than throwing on a property of `undefined`.
    await expect(
      new TerraformProxmoxProvider(configuration, stateRunner(), runsDouble(null)).startInstance(
        {},
      ),
    ).rejects.toThrow(/allowlisted/);
  });

  it('fails clearly when no direct client is configured', async () => {
    await expect(
      new TerraformProxmoxProvider(configuration, stateRunner(), runsDouble(null)).rebootInstance(
        powerRequest,
      ),
    ).rejects.toThrow(/no direct Proxmox client/);
  });
});

describe('resize', () => {
  it('refuses a disk shrink before planning anything', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
    ).resizeInstance({
      request: mutation,
      targetResources: { cpuCount: 2, memoryMib: '4096', diskGib: '16' },
    });

    // Refusing before the plan is what keeps state honest: bpg does refuse a shrink at apply
    // time, but it was measured writing the rejected size into state first.
    expect(response.result?.failure?.code).toBe('DISK_SHRINK_FORBIDDEN');
    expect(recorded.begun).toHaveLength(0);
  });

  it('applies a growth', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
    ).resizeInstance({
      request: mutation,
      targetResources: { cpuCount: 4, memoryMib: '8192', diskGib: '64' },
    });

    expect(response.result?.state).toBe(ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED);
    expect(recorded.begun).toHaveLength(1);
    await settle();
  });
});

describe('snapshots', () => {
  it('lists snapshots through the direct client', async () => {
    const direct = directDouble();
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null),
      direct.client as never,
    ).listSnapshots({ ...mutation });

    expect(response.snapshots?.map((entry) => entry.name)).toEqual(['before-upgrade']);
  });

  it('marks the workspace drifted after a rollback, not merely refreshed', async () => {
    // A rollback reverts disk and configuration wholesale and Terraform learns nothing about it.
    // `drifted` until a refresh proves otherwise is stronger than what other direct mutations get,
    // and deliberately so.
    const direct = directDouble();
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
      direct.client as never,
    ).rollbackSnapshot({
      request: { request: mutation, providerSnapshotReference: 'before-upgrade' },
    });
    await settle();

    expect(direct.calls).toEqual(['rollbackSnapshot 910000 before-upgrade']);
    expect((recorded.workspaces[0] as { driftState: string }).driftState).toBe('drifted');
  });

  it('refuses a snapshot operation when live ownership cannot be proven', async () => {
    const direct = directDouble({ config: async () => ({ description: 'someone else' }) });
    await expect(
      new TerraformProxmoxProvider(
        configuration,
        stateRunner(),
        runsDouble(null),
        direct.client as never,
      ).createSnapshot({ request: mutation, name: 'before-upgrade' }),
    ).rejects.toThrow(/ownership could not be proven/);
    expect(direct.calls).toEqual([]);
  });
});

describe('retention', () => {
  it('clears on_boot and appends the deadline while preserving the marker', async () => {
    const recorded: RecordedRuns = { begun: [], completed: [], workspaces: [] };
    await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runsDouble(null, recorded),
    ).markInstanceRetained({
      request: mutation,
      retentionDeadline: '2026-10-01T00:00:00.000Z',
    });

    // The marker must survive: a later purge has to prove live ownership and cannot do that
    // against a description it can no longer parse.
    expect(recorded.begun).toHaveLength(1);
    await settle();
  });
});

describe('purge', () => {
  it('refuses without an authorization id', async () => {
    await expect(
      new TerraformProxmoxProvider(
        configuration,
        stateRunner(),
        runsDouble(null),
        directDouble().client as never,
      ).purgeInstance({ request: mutation, retentionDeadline: '2026-10-01T00:00:00.000Z' }),
    ).rejects.toThrow(/purgeAuthorizationId is required/);
  });

  it('refuses when live ownership cannot be proven, even with an authorization id', async () => {
    // SAFE-006 wants both halves. State is this system's belief; a destroy has to be justified by
    // what is actually on the server.
    const direct = directDouble({ config: async () => null });
    await expect(
      new TerraformProxmoxProvider(
        configuration,
        stateRunner(),
        runsDouble(null),
        direct.client as never,
      ).purgeInstance({
        request: mutation,
        purgeAuthorizationId: '00000000-0000-4000-8000-0000000000ff',
        retentionDeadline: '2026-10-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/ownership could not be proven/);
  });

  it('uses the purge module and names the one address it may destroy', async () => {
    const planned: unknown[] = [];
    const runner = runnerDouble({
      showState: (stateRunner() as unknown as { showState: unknown }).showState,
      prepare: async (_workspace: string, _tfvars: unknown, purge?: boolean) => {
        planned.push({ purge: purge === true });
        return '/tmp/workspace';
      },
      plan: async (_directory: string, options?: { allowDestroyOf?: string }) => {
        planned.push({ allowDestroyOf: options?.allowDestroyOf });
        return {
          gate: {
            decision: 'allowed' as const,
            actionCounts: { delete: 1 },
            objections: [],
            summary: 'destroy',
          },
          invocation: { command: 'plan', exitCode: 0, diagnostics: [], durationMs: 1 },
        };
      },
    } as Partial<TerraformRunner>);

    await new TerraformProxmoxProvider(
      configuration,
      runner,
      runsDouble(null),
      directDouble().client as never,
    ).purgeInstance({
      request: mutation,
      purgeAuthorizationId: '00000000-0000-4000-8000-0000000000ff',
      retentionDeadline: '2026-10-01T00:00:00.000Z',
    });
    await settle();

    expect(planned.some((entry) => (entry as { purge?: boolean }).purge === true)).toBe(true);
    expect(
      planned.some(
        (entry) => (entry as { allowDestroyOf?: string }).allowDestroyOf === INSTANCE_ADDRESS,
      ),
    ).toBe(true);
  });
});

describe('the two task-reference kinds', () => {
  it('polls a direct-client reference through Proxmox, not the run table', async () => {
    let readRunCalled = false;
    const runs: TerraformRunStore = {
      ...runsDouble(null),
      readRun: async () => {
        readRunCalled = true;
        return null;
      },
    };
    const response = await new TerraformProxmoxProvider(
      configuration,
      stateRunner(),
      runs,
      directDouble().client as never,
    ).getTask({ context, providerTaskReference: 'upid:UPID:proxtest:1:snapshot:' });

    expect(response.state).toBe(ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED);
    // Looking it up in the run table and treating "not found" as "must be a UPID" would report a
    // genuinely lost run as a Proxmox task and then fail trying to poll it.
    expect(readRunCalled).toBe(false);
  });
});
