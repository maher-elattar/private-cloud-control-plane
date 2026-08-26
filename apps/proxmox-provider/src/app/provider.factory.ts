import { FakeProvider, ProxmoxProvider } from '@private-cloud/provider-adapters';
import type { CreateInstanceProviderPort } from '@private-cloud/provider-sdk';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when PROVIDER_ADAPTER=proxmox.`);
  return value;
}

function requiredInteger(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

export function createProvider(): CreateInstanceProviderPort {
  const adapter = process.env.PROVIDER_ADAPTER?.trim() || 'fake';
  if (adapter === 'fake') {
    const latencyMs = Number(process.env.FAKE_PROVIDER_LATENCY_MS ?? 0);
    const taskPolls = Number(process.env.FAKE_PROVIDER_TASK_POLLS ?? 1);
    if (
      !Number.isInteger(latencyMs) ||
      latencyMs < 0 ||
      !Number.isInteger(taskPolls) ||
      taskPolls < 0
    ) {
      throw new Error('Fake-provider latency and task polls must be non-negative integers.');
    }
    return new FakeProvider({
      defaultLatencyMs: latencyMs,
      defaultTaskPollsBeforeSuccess: taskPolls,
    });
  }
  if (adapter !== 'proxmox') throw new Error('PROVIDER_ADAPTER must be fake or proxmox.');

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
