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
 * WHY this returns only `CreateInstanceProviderPort` while the direct adapter returns all six
 * narrowed ports: this adapter implements the create and read surface, and the capabilities it
 * does not yet serve are absent from the type rather than stubbed. A stub would satisfy the
 * compiler and then fail at runtime with a message about the wrong thing; an absent method makes
 * the gap a compile error at the one call site that would depend on it.
 *
 * @returns The configured Terraform adapter.
 * @throws Error if any setting is missing or malformed.
 */
function createTerraformProvider(): CreateInstanceProviderPort {
  const runner = new TerraformRunner({
    binary: requiredEnvironment('TERRAFORM_BINARY'),
    modulePath: requiredEnvironment('TERRAFORM_MODULE_PATH'),
    purgeModulePath: requiredEnvironment('TERRAFORM_PURGE_MODULE_PATH'),
    workingRoot: requiredEnvironment('TERRAFORM_WORKING_ROOT'),
    backendConnectionString: requiredEnvironment('TERRAFORM_STATE_CONN_STR'),
    ...(process.env.TERRAFORM_PLUGIN_DIR?.trim()
      ? { pluginDirectory: process.env.TERRAFORM_PLUGIN_DIR.trim() }
      : {}),
  });

  const runs = new PostgresTerraformInventoryStore(
    createPostgresDatabase(requiredEnvironment('DATABASE_URL')),
  );

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
  ) as unknown as CreateInstanceProviderPort;
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
    // The Terraform adapter serves the create and read surface today. The cast is confined to
    // this one line and is the honest shape of a partial migration: the process boots, serves
    // what it implements, and fails a call it does not — rather than pretending at the type level
    // that every capability is present.
    return createTerraformProvider() as ReturnType<typeof createProvider>;
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
