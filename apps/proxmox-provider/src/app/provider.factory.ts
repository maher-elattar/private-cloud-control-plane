/**
 * Chooses which provider adapter this process runs.
 *
 * **This is the live-provider safety gate.** The default is the deterministic fake, and
 * Proxmox is selected only by an explicit `PROVIDER_ADAPTER=proxmox`. A misconfigured or
 * partly configured deployment therefore fails closed — running against a fake — rather than
 * open, against real hardware.
 *
 * Every Proxmox setting is read through {@link requiredEnvironment}, with no defaults at all.
 * WHY: a default endpoint, node, or VMID range would let a partially-configured process
 * mutate the wrong machine. Refusing to start is the only safe response to missing config.
 *
 * @see docs/architecture/lab-boundary.md
 * @see docs/architecture/phase-3-vertical-slice.md
 */
import { FailureCategory } from '@private-cloud/contracts';
import {
  FakeProvider,
  ProxmoxDirectClient,
  ProxmoxProvider,
  TerraformProxmoxProvider,
  TerraformRunner,
  type FakeProviderConfiguration,
} from '@private-cloud/provider-adapters';
import {
  createPostgresDatabase,
  PostgresTerraformInventoryStore,
} from '@private-cloud/postgres-adapter';
import type {
  CreateInstanceProviderPort,
  PowerProviderPort,
  PurgeProviderPort,
  ResizeProviderPort,
  RetentionProviderPort,
  SnapshotProviderPort,
} from '@private-cloud/provider-sdk';

export type LocalFakeProviderScenario =
  | 'ambiguous'
  | 'permanent'
  | 'retry'
  | 'retry-exhaustion'
  | 'success';

const localFakeProviderScenarios: readonly LocalFakeProviderScenario[] = [
  'ambiguous',
  'permanent',
  'retry',
  'retry-exhaustion',
  'success',
];

/** Reads a required Proxmox setting, refusing to start if it is absent. */
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when PROVIDER_ADAPTER=proxmox.`);
  return value;
}

/** Reads a required integer setting, such as a VMID bound. */
function requiredInteger(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

/** Builds the bounded deterministic behavior used by local failure drills. */
export function fakeProviderConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): FakeProviderConfiguration {
  const latencyMs = Number(environment.FAKE_PROVIDER_LATENCY_MS ?? 0);
  const taskPolls = Number(environment.FAKE_PROVIDER_TASK_POLLS ?? 1);
  const scenario = (environment.FAKE_PROVIDER_SCENARIO?.trim() ||
    'success') as LocalFakeProviderScenario;
  if (
    !Number.isInteger(latencyMs) ||
    latencyMs < 0 ||
    !Number.isInteger(taskPolls) ||
    taskPolls < 0
  ) {
    throw new Error('Fake-provider latency and task polls must be non-negative integers.');
  }
  if (!localFakeProviderScenarios.includes(scenario)) {
    throw new Error(
      `FAKE_PROVIDER_SCENARIO must be one of: ${localFakeProviderScenarios.join(', ')}.`,
    );
  }

  const script: FakeProviderConfiguration['script'] =
    scenario === 'retry'
      ? { getTask: [{ mode: 'failure' }, { mode: 'success' }] }
      : scenario === 'retry-exhaustion'
        ? { getTask: [{ mode: 'failure' }] }
        : scenario === 'permanent'
          ? {
              submitCreateInstance: [
                {
                  mode: 'failure',
                  failureCode: 'FAKE_IMAGE_REJECTED',
                  failureCategory: FailureCategory.FAILURE_CATEGORY_VALIDATION,
                },
              ],
            }
          : scenario === 'ambiguous'
            ? {
                submitCreateInstance: [{ mode: 'timeout', applyBeforeResponse: true }],
              }
            : undefined;

  return {
    defaultLatencyMs: latencyMs,
    defaultTaskPollsBeforeSuccess: taskPolls,
    ...(script ? { script } : {}),
  };
}

/**
 * The provider profile this process is configured to serve, or `undefined` under the fake.
 *
 * WHY this is exported separately rather than read off the adapter: `getCapabilities` asserts the
 * caller named the allowlisted profile, so the readiness probe has to pass it — and the probe
 * must not read the environment itself, or the health endpoint acquires configuration knowledge
 * that belongs in the composition root.
 *
 * @returns The allowlisted profile id, or `undefined` when the fake adapter is selected.
 */
export function providerProfileId(): string | undefined {
  const adapter = process.env.PROVIDER_ADAPTER?.trim() || 'fake';
  return adapter === 'proxmox' || adapter === 'terraform'
    ? requiredEnvironment('PROXMOX_PROVIDER_PROFILE_ID')
    : undefined;
}

/**
 * Builds the Terraform-backed adapter.
 *
 * The direct Proxmox client is optional and only constructed when API-token settings are present.
 * WHY optional: nine of the seventeen operations go through Terraform, which holds its own
 * credentials, so a deployment that does not need snapshots, reboot or hard stop can run without
 * Proxmox API credentials at all. Reaching one of those six without a client fails with a message
 * that says so, rather than with a null dereference.
 *
 * @returns The configured Terraform adapter, satisfying every narrowed port.
 * @throws Error if any required setting is missing or malformed.
 */
/**
 * How long one Terraform invocation may run.
 *
 * Must be **less** than the orchestrator's `PROVIDER_GRPC_DEADLINE_MS`, and greater than the
 * runner's 180-second state-lock wait plus a plan. A synchronous call that legitimately waited on
 * the lock and then tripped the transport deadline reports an unknown outcome, and an unknown
 * outcome on a mutation goes to manual review — so a deadline set too low converts "slow but
 * fine" into "a human must look at this". That is exactly what a 10-second deadline did on the
 * first full-stack run: the convergence assertion runs `init` and `plan` against a remote API and
 * needs about ten seconds on an idle server.
 */
const TERRAFORM_INVOCATION_TIMEOUT_MS = 240_000;

function createTerraformProvider(): ReturnType<typeof createProvider> {
  const runner = new TerraformRunner({
    binary: requiredEnvironment('TERRAFORM_BINARY'),
    modulePath: requiredEnvironment('TERRAFORM_MODULE_PATH'),
    purgeModulePath: requiredEnvironment('TERRAFORM_PURGE_MODULE_PATH'),
    workingRoot: requiredEnvironment('TERRAFORM_WORKING_ROOT'),
    backendConnectionString: requiredEnvironment('TERRAFORM_STATE_CONN_STR'),
    // Translated, not inherited. The provider plugin reads `PROXMOX_VE_*`, which are different
    // names from this system's `PROXMOX_*` settings, so the translation has to happen somewhere;
    // doing it here means one place decides which server an apply can reach.
    providerEnvironment: {
      PROXMOX_VE_ENDPOINT: requiredEnvironment('PROXMOX_ENDPOINT'),
      PROXMOX_VE_API_TOKEN: `${requiredEnvironment('PROXMOX_API_TOKEN_ID')}=${requiredEnvironment(
        'PROXMOX_API_TOKEN_SECRET',
      )}`,
      // Explicitly false rather than unset. The endpoint presents a publicly trusted certificate,
      // and this is the one setting whose default would silently disable verification.
      PROXMOX_VE_INSECURE: 'false',
    },
    ...(process.env.TERRAFORM_PLUGIN_DIR?.trim()
      ? { pluginDirectory: process.env.TERRAFORM_PLUGIN_DIR.trim() }
      : {}),
    // Bounded below the caller's gRPC deadline on purpose. Whichever expires first decides what
    // the workflow learns: this one produces a recorded run with diagnostics, while the caller's
    // deadline produces an *ambiguous* transport failure that must go to manual review. A
    // recorded failure is strictly better information, so the runner must give up first.
    timeoutMs: TERRAFORM_INVOCATION_TIMEOUT_MS,
  });

  const runs = new PostgresTerraformInventoryStore(
    createPostgresDatabase(requiredEnvironment('DATABASE_URL')),
  );

  // Present only when the six direct operations are wanted. All-or-nothing: a half-configured
  // client would fail at the first snapshot rather than at startup.
  const directSettings = ['PROXMOX_ENDPOINT', 'PROXMOX_API_TOKEN_ID', 'PROXMOX_API_TOKEN_SECRET'];
  const configuredDirect = directSettings.filter((name) => process.env[name]?.trim());
  if (configuredDirect.length > 0 && configuredDirect.length !== directSettings.length) {
    throw new Error(
      `The direct Proxmox client needs all of ${directSettings.join(', ')} or none of them.`,
    );
  }
  const directClient =
    configuredDirect.length === directSettings.length
      ? new ProxmoxDirectClient({
          endpoint: requiredEnvironment('PROXMOX_ENDPOINT'),
          apiTokenId: requiredEnvironment('PROXMOX_API_TOKEN_ID'),
          apiTokenSecret: requiredEnvironment('PROXMOX_API_TOKEN_SECRET'),
          node: requiredEnvironment('PROXMOX_NODE'),
          resourceIdMinimum: requiredInteger('PROXMOX_VMID_MINIMUM'),
          resourceIdMaximum: requiredInteger('PROXMOX_VMID_MAXIMUM'),
        })
      : undefined;

  return new TerraformProxmoxProvider(
    {
      providerProfileId: requiredEnvironment('PROXMOX_PROVIDER_PROFILE_ID'),
      projectId: requiredEnvironment('PROXMOX_PROJECT_ID'),
      node: requiredEnvironment('PROXMOX_NODE'),
      templateVmid: requiredInteger('PROXMOX_TEMPLATE_VMID'),
      imageId: requiredEnvironment('PROXMOX_IMAGE_ID'),
      storage: requiredEnvironment('PROXMOX_STORAGE'),
      diskInterface: requiredEnvironment('PROXMOX_DISK_INTERFACE'),
      bridge: requiredEnvironment('PROXMOX_BRIDGE'),
      networkMtu: requiredInteger('PROXMOX_NETWORK_MTU'),
      networkId: requiredEnvironment('PROXMOX_NETWORK_ID'),
      ipv4Cidr: requiredEnvironment('PROXMOX_IPV4_CIDR'),
      ipv4Gateway: requiredEnvironment('PROXMOX_IPV4_GATEWAY'),
      dnsDomain: requiredEnvironment('PROXMOX_DNS_DOMAIN'),
      cloudInitUsername: requiredEnvironment('PROXMOX_CLOUD_INIT_USER'),
      cloudInitPassword: requiredEnvironment('PROXMOX_CLOUD_INIT_PASSWORD'),
      resourceIdMinimum: requiredInteger('PROXMOX_VMID_MINIMUM'),
      resourceIdMaximum: requiredInteger('PROXMOX_VMID_MAXIMUM'),
      environment: 'lab',
      managedBy: 'private-cloud-control-plane',
    },
    runner,
    runs,
    directClient,
  ) as unknown as ReturnType<typeof createProvider>;
}

/**
 * Builds the configured provider adapter.
 *
 * @throws Error if `PROVIDER_ADAPTER` is unrecognised, or if Proxmox mode is selected with
 *   any setting missing or malformed.
 */
export function createProvider(): CreateInstanceProviderPort &
  PowerProviderPort &
  ResizeProviderPort &
  SnapshotProviderPort &
  RetentionProviderPort &
  PurgeProviderPort {
  // Defaults to `fake`: selecting a live provider must always be a deliberate act.
  const adapter = process.env.PROVIDER_ADAPTER?.trim() || 'fake';
  if (adapter === 'fake') {
    return new FakeProvider(fakeProviderConfiguration());
  }
  if (adapter === 'terraform') {
    return createTerraformProvider();
  }
  if (adapter !== 'proxmox') {
    throw new Error('PROVIDER_ADAPTER must be fake, proxmox, or terraform.');
  }

  // Every value below is mandatory. The VMID bounds and project ID in particular are what
  // confine this adapter to the reserved lab interval and the single permitted tenant.
  return new ProxmoxProvider({
    endpoint: requiredEnvironment('PROXMOX_ENDPOINT'),
    apiTokenId: requiredEnvironment('PROXMOX_API_TOKEN_ID'),
    apiTokenSecret: requiredEnvironment('PROXMOX_API_TOKEN_SECRET'),
    providerProfileId: requiredEnvironment('PROXMOX_PROVIDER_PROFILE_ID'),
    clusterAlias: requiredEnvironment('PROXMOX_CLUSTER_ALIAS'),
    node: requiredEnvironment('PROXMOX_NODE'),
    templateVmid: requiredInteger('PROXMOX_TEMPLATE_VMID'),
    imageId: requiredEnvironment('PROXMOX_IMAGE_ID'),
    storage: requiredEnvironment('PROXMOX_STORAGE'),
    bridge: requiredEnvironment('PROXMOX_BRIDGE'),
    networkId: requiredEnvironment('PROXMOX_NETWORK_ID'),
    ipv4Cidr: requiredEnvironment('PROXMOX_IPV4_CIDR'),
    ipv4Gateway: requiredEnvironment('PROXMOX_IPV4_GATEWAY'),
    resourceIdMinimum: requiredInteger('PROXMOX_VMID_MINIMUM'),
    resourceIdMaximum: requiredInteger('PROXMOX_VMID_MAXIMUM'),
    projectId: requiredEnvironment('PROXMOX_PROJECT_ID'),
    environment: 'lab',
    managedBy: 'private-cloud-control-plane',
  });
}
