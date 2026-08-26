/**
 * Proxmox adapter for the allowlisted Phase 3 create path.
 *
 * **This is the only file in the repository that can affect real hardware**, and it is written
 * to be boring on purpose. Every value it acts on is fixed by configuration and re-checked at
 * the point of use: one node, one template, one storage target, one bridge, one network, one
 * project, and a VMID inside the reserved `910000-910099` interval.
 *
 * What it deliberately never does:
 *
 * - **Never calls `/cluster/nextid`.** Cluster-wide ID allocation could hand back an ID outside
 *   the reserved interval, pointing a later call at a machine this system does not own.
 * - **Never deletes, purges, or stops** anything. No compensation path exists here at all.
 * - **Never disables certificate verification.** TLS uses the platform trust store, unmodified.
 * - **Never performs placement or host mutation.** It uses the one configured node.
 *
 * Ownership markers are written into the VM description on create and re-parsed before every
 * later call, so an ID collision or an operator's manual edit is detected rather than acted on.
 * That is also what makes a replay after a crash safe: an already-owned VM is recognised as
 * ours instead of being built a second time.
 *
 * @see docs/architecture/proxmox-create-call-map.md
 * @see docs/architecture/lab-boundary.md
 * @see docs/architecture/safety-invariants.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { FailureCategory, ObservedPowerState } from '@private-cloud/contracts';
import {
  ProviderResultState,
  ProviderTaskState,
  ValidationCheckState,
  type ApplyInstanceConfigurationRequest,
  type ApplyInstanceConfigurationResponse,
  type GetCapabilitiesRequest,
  type GetCapabilitiesResponse,
  type GetTaskRequest,
  type GetTaskResponse,
  type InstanceObservation,
  type ObserveInstanceRequest,
  type ObserveInstanceResponse,
  type OwnershipMarkers,
  type ProviderMutationResult,
  type StartInstanceRequest,
  type StartInstanceResponse,
  type SubmitCreateInstanceRequest,
  type SubmitCreateInstanceResponse,
  type ValidateProfileRequest,
  type ValidateProfileResponse,
} from '@private-cloud/contracts/provider';
import {
  ProviderTransportError,
  type CreateInstanceProviderPort,
  type ProviderCallOptions,
} from '@private-cloud/provider-sdk';
import ipaddr from 'ipaddr.js';

/**
 * The complete allowlist this adapter is confined to.
 *
 * Every field is required and has no default — `provider.factory.ts` reads each from an
 * environment variable and refuses to start if any is missing. A default here could point a
 * partially-configured deployment at the wrong machine.
 */
export interface ProxmoxProviderConfiguration {
  readonly endpoint: string;
  readonly apiTokenId: string;
  readonly apiTokenSecret: string;
  readonly providerProfileId: string;
  readonly clusterAlias: string;
  readonly node: string;
  readonly templateVmid: number;
  readonly imageId: string;
  readonly storage: string;
  readonly bridge: string;
  readonly networkId: string;
  readonly ipv4Cidr: string;
  readonly ipv4Gateway: string;
  readonly resourceIdMinimum: number;
  readonly resourceIdMaximum: number;
  readonly projectId: string;
  readonly environment: 'lab';
  readonly managedBy: 'private-cloud-control-plane';
  readonly requestTimeoutMs?: number;
}

/** Proxmox wraps every response body in a `data` field. */
interface ProxmoxEnvelope<T> {
  readonly data: T;
}

/** A VM as listed by `/nodes/{node}/qemu`. */
interface ProxmoxVmSummary {
  readonly vmid?: number;
}

/** A VM's configuration, including the description that carries ownership markers. */
interface ProxmoxVmConfig {
  readonly description?: string;
  readonly name?: string;
  readonly cores?: number;
  readonly memory?: number;
  readonly net0?: string;
  readonly ipconfig0?: string;
  readonly scsi0?: string;
  readonly virtio0?: string;
  readonly sata0?: string;
}

/** A task status read. Terminal only when `status` is `stopped`. */
interface ProxmoxTaskStatus {
  readonly status?: string;
  readonly exitstatus?: string;
}

/** A VM's live power status. */
interface ProxmoxCurrentStatus {
  readonly status?: string;
}

/** Prefix marking a description line as a control-plane ownership marker. */
const markerPrefix = 'private-cloud-control:';

/** Asserts a configured or request value is present. */
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new ProviderTransportError('protocol_error', `${name} is required.`, {
      retryable: false,
    });
  }
  return value;
}

/** Encodes a mutation body. The Proxmox API takes form encoding, not JSON. */
function form(values: Readonly<Record<string, string | number>>): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) result.set(key, String(value));
  return result;
}

/** Builds a sanitised provider failure. No Proxmox detail crosses this boundary. */
function failure(
  category: FailureCategory,
  code: string,
  safeMessage: string,
): ProviderMutationResult {
  return {
    state: ProviderResultState.PROVIDER_RESULT_STATE_REJECTED,
    evidenceId: randomUUID(),
    failure: { category, code, safeMessage },
  };
}

/**
 * Renders ownership markers into the VM description field.
 *
 * WHY the description: it is the one free-text field Proxmox preserves across clone and
 * configuration, giving a place to record ownership that survives the whole create sequence
 * and can be read back on any later call.
 */
function ownershipDescription(markers: OwnershipMarkers): string {
  return `${markerPrefix}${JSON.stringify({
    managedBy: markers.managedBy,
    environment: markers.environment,
    projectId: markers.projectId,
    instanceId: markers.instanceId,
    createOperationId: markers.createOperationId,
  })}`;
}

/** Parses ownership markers back out of a description, or `null` if absent or malformed. */
function parseOwnership(description: string | undefined): OwnershipMarkers | null {
  if (!description?.startsWith(markerPrefix)) return null;
  try {
    const value = JSON.parse(description.slice(markerPrefix.length)) as Partial<OwnershipMarkers>;
    if (
      !value.managedBy ||
      !value.environment ||
      !value.projectId ||
      !value.instanceId ||
      !value.createOperationId
    ) {
      return null;
    }
    return {
      managedBy: value.managedBy,
      environment: value.environment,
      projectId: value.projectId,
      instanceId: value.instanceId,
      createOperationId: value.createOperationId,
    };
  } catch {
    return null;
  }
}

/**
 * Exact, all-fields comparison of ownership markers.
 *
 * A partial match is treated as no match. Anything less than complete agreement means this
 * may not be our VM, and the safe response is to refuse to touch it.
 */
function markersMatch(actual: OwnershipMarkers | null, expected: OwnershipMarkers): boolean {
  if (!actual) return false;
  return (
    actual.managedBy === expected.managedBy &&
    actual.environment === expected.environment &&
    actual.projectId === expected.projectId &&
    actual.instanceId === expected.instanceId &&
    actual.createOperationId === expected.createOperationId
  );
}

/** Extracts the disk size in GiB from a Proxmox disk specification string. */
function diskGiB(config: ProxmoxVmConfig): string | undefined {
  const disk = config.scsi0 ?? config.virtio0 ?? config.sata0;
  const size = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT])(?:,|$)/i.exec(disk ?? '');
  if (!size?.[1] || !size[2]) return undefined;
  const factor = { K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024 }[
    size[2].toUpperCase() as 'G' | 'K' | 'M' | 'T'
  ];
  return String(Math.ceil(Number(size[1]) * factor));
}

/**
 * Narrow Proxmox adapter for the allowlisted Phase 3 create path. It never performs placement,
 * deletion, host mutation, cluster-wide ID allocation, or certificate-verification bypasses.
 */
export class ProxmoxProvider implements CreateInstanceProviderPort {
  /**
   * Validates the allowlist before the adapter can be used at all.
   *
   * These checks run at construction, not per call, so a misconfigured deployment fails to
   * start rather than failing partway through provisioning. All three are safety boundaries:
   *
   * - HTTPS is mandatory — an API token must never cross a plaintext connection.
   * - The VMID interval is clamped to `910000-910099` regardless of what was configured, so a
   *   typo cannot widen the blast radius to production VMIDs.
   * - The gateway must lie inside the CIDR, catching a mismatched network before a guest is
   *   configured with an unreachable route.
   *
   * @throws Error if any allowlist value is missing, malformed, or out of bounds.
   */
  public constructor(private readonly configuration: ProxmoxProviderConfiguration) {
    const endpoint = new URL(configuration.endpoint);
    if (endpoint.protocol !== 'https:') throw new Error('Proxmox endpoint must use HTTPS.');
    if (
      !Number.isSafeInteger(configuration.resourceIdMinimum) ||
      !Number.isSafeInteger(configuration.resourceIdMaximum) ||
      configuration.resourceIdMinimum < 910_000 ||
      configuration.resourceIdMaximum > 910_099 ||
      configuration.resourceIdMinimum > configuration.resourceIdMaximum
    ) {
      throw new Error('Proxmox resource IDs must stay inside the reserved 910000-910099 range.');
    }
    try {
      const [range, prefixLength] = ipaddr.parseCIDR(configuration.ipv4Cidr);
      const gateway = ipaddr.parse(configuration.ipv4Gateway);
      if (
        range.kind() !== 'ipv4' ||
        gateway.kind() !== 'ipv4' ||
        !gateway.match(range, prefixLength)
      ) {
        throw new Error('The network must be an IPv4 CIDR containing its gateway.');
      }
    } catch (cause: unknown) {
      throw new Error('Proxmox IPv4 allowlist configuration is invalid.', { cause });
    }
  }

  /** Probes each allowlisted target and reports per-check results. Read-only; no mutation. */
  public async validateProfile(
    request: ValidateProfileRequest,
    options?: ProviderCallOptions,
  ): Promise<ValidateProfileResponse> {
    this.assertDirectProfile(request.profile?.providerProfileId);
    const checks: Array<{ name: string; state: ValidationCheckState; safeSummary: string }> = [];
    const check = async (name: string, path: string, predicate: (data: unknown) => boolean) => {
      try {
        const data = await this.request<unknown>('GET', path, undefined, options?.signal);
        const passed = predicate(data);
        checks.push({
          name,
          state: passed
            ? ValidationCheckState.VALIDATION_CHECK_STATE_PASSED
            : ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
          safeSummary: passed ? `${name} is allowlisted and available.` : `${name} did not match.`,
        });
      } catch {
        checks.push({
          name,
          state: ValidationCheckState.VALIDATION_CHECK_STATE_FAILED,
          safeSummary: `${name} could not be verified.`,
        });
      }
    };
    const node = encodeURIComponent(this.configuration.node);
    await check('endpoint', '/version', (data) => typeof data === 'object' && data !== null);
    await check(
      'node',
      `/nodes/${node}/status`,
      (data) => typeof data === 'object' && data !== null,
    );
    await check(
      'template',
      `/nodes/${node}/qemu/${this.configuration.templateVmid}/config`,
      (data) => typeof data === 'object' && data !== null,
    );
    await check(
      'storage',
      `/nodes/${node}/storage/${encodeURIComponent(this.configuration.storage)}/status`,
      (data) => typeof data === 'object' && data !== null,
    );
    await check('bridge', `/nodes/${node}/network`, (data) =>
      Array.isArray(data)
        ? data.some(
            (entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              (entry as { iface?: string }).iface === this.configuration.bridge,
          )
        : false,
    );
    return {
      valid: checks.every(
        (entry) => entry.state === ValidationCheckState.VALIDATION_CHECK_STATE_PASSED,
      ),
      checks,
      validatedAt: new Date().toISOString(),
      validationEvidenceId: randomUUID(),
    };
  }

  /** Reports the bounded create capabilities this adapter supports. */
  public getCapabilities(request: GetCapabilitiesRequest): Promise<GetCapabilitiesResponse> {
    this.assertDirectProfile(request.providerProfileId);
    return Promise.resolve({
      capabilities: {
        createInstance: true,
        configureInstance: true,
        power: true,
        resizeCompute: false,
        growDisk: false,
        snapshots: false,
        retentionMarker: false,
        purge: false,
        maximumCpuCount: 8,
        maximumMemoryMib: '16384',
        maximumDiskGib: '128',
        maximumSnapshots: 0,
      },
      observedAt: new Date().toISOString(),
    });
  }

  /**
   * Full-clones the configured template into a reserved VMID.
   *
   * Searches only the allowlisted node and interval for a free ID — never `/cluster/nextid`.
   * An existing VM already carrying our exact markers is recognised as a replay of this same
   * request and reused, rather than cloned again.
   */
  public async submitCreateInstance(
    request: SubmitCreateInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<SubmitCreateInstanceResponse> {
    const context = this.assertContext(request.context);
    const ownership = this.assertOwnership(request.ownershipMarkers, context);
    if (request.imageId !== this.configuration.imageId) {
      throw new ProviderTransportError('protocol_error', 'Image is outside the allowlist.', {
        retryable: false,
      });
    }
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(request.hostname ?? '')) {
      throw new ProviderTransportError('protocol_error', 'Hostname is invalid.', {
        retryable: false,
      });
    }
    const vmid = await this.findOwnedOrFreeVmid(ownership, options?.signal);
    const existing = await this.vmConfig(vmid, options?.signal, true);
    if (existing) {
      return {
        result: {
          state: ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
          providerResourceId: String(vmid),
          evidenceId: randomUUID(),
        },
      };
    }
    const upid = await this.request<string>(
      'POST',
      `/nodes/${encodeURIComponent(this.configuration.node)}/qemu/${this.configuration.templateVmid}/clone`,
      form({
        newid: vmid,
        name: required(request.hostname, 'hostname'),
        full: 1,
        storage: this.configuration.storage,
        description: ownershipDescription(ownership),
      }),
      options?.signal,
    );
    return { result: this.accepted(vmid, required(upid, 'provider task reference')) };
  }

  /**
   * Applies CPU, memory, network, and cloud-init settings to an owned VM.
   *
   * Preserves the inherited `net0` model, MAC, and options rather than rewriting the NIC, so
   * the guest keeps a stable MAC across configuration. Blank SSH keys and every password
   * field are omitted entirely.
   */
  public async applyInstanceConfiguration(
    request: ApplyInstanceConfigurationRequest,
    options?: ProviderCallOptions,
  ): Promise<ApplyInstanceConfigurationResponse> {
    const context = this.assertContext(request.context);
    const ownership = this.assertOwnership(request.ownershipMarkers, context);
    const vmid = this.assertVmid(request.providerResourceId);
    const current = await this.requireOwnedConfig(vmid, ownership, options?.signal);
    const network = request.network;
    const resources = request.resources;
    if (!network || !resources) {
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_VALIDATION,
          'CONFIGURATION_REQUIRED',
          'Resources and network configuration are required.',
        ),
      };
    }
    this.assertResources(resources, current);
    this.assertNetwork(network);
    await this.assertIpv4Available(network.ipv4Address ?? '', vmid, options?.signal);
    if (!current.net0) {
      return {
        result: failure(
          FailureCategory.FAILURE_CATEGORY_PERMANENT,
          'NET0_MISSING',
          'The allowlisted template did not provide net0.',
        ),
      };
    }
    const net0 = current.net0
      .split(',')
      .filter((part) => !part.startsWith('bridge='))
      .concat(`bridge=${this.configuration.bridge}`)
      .join(',');
    const values: Record<string, string | number> = {
      name: required(request.hostname, 'hostname'),
      cores: resources.cpuCount ?? 1,
      sockets: 1,
      vcpus: resources.cpuCount ?? 1,
      memory: resources.memoryMib ?? '512',
      net0,
      ipconfig0: `ip=${required(network.ipv4Address, 'network.ipv4Address')}/${network.ipv4PrefixLength ?? 0},gw=${required(network.ipv4Gateway, 'network.ipv4Gateway')}`,
      nameserver: (network.dnsServers ?? []).join(' '),
      description: ownershipDescription(ownership),
    };
    if ((request.sshPublicKeys?.length ?? 0) > 0) {
      values.sshkeys = request.sshPublicKeys?.join('\n') ?? '';
    }
    const upid = await this.request<string | null>(
      'POST',
      `/nodes/${encodeURIComponent(this.configuration.node)}/qemu/${vmid}/config`,
      form(values),
      options?.signal,
    );
    return {
      result: upid
        ? this.accepted(vmid, upid)
        : {
            state: ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
            providerResourceId: String(vmid),
            evidenceId: randomUUID(),
          },
    };
  }

  /**
   * Reads one task status by UPID.
   *
   * A task counts as successful only when it is `stopped` *and* reports `exitstatus=OK`.
   * `stopped` alone means finished, not succeeded.
   */
  public async getTask(
    request: GetTaskRequest,
    options?: ProviderCallOptions,
  ): Promise<GetTaskResponse> {
    this.assertContext(request.context);
    const { node, upid } = this.decodeTask(required(request.providerTaskReference, 'task'));
    if (node !== this.configuration.node) {
      throw new ProviderTransportError('protocol_error', 'Task node is outside the allowlist.', {
        retryable: false,
      });
    }
    const task = await this.request<ProxmoxTaskStatus>(
      'GET',
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      undefined,
      options?.signal,
    );
    if (task.status !== 'stopped') {
      return {
        state: ProviderTaskState.PROVIDER_TASK_STATE_RUNNING,
        observedAt: new Date().toISOString(),
      };
    }
    if (task.exitstatus === 'OK') {
      return {
        state: ProviderTaskState.PROVIDER_TASK_STATE_SUCCEEDED,
        observedAt: new Date().toISOString(),
      };
    }
    return {
      state: ProviderTaskState.PROVIDER_TASK_STATE_FAILED,
      failure: {
        category: FailureCategory.FAILURE_CATEGORY_PERMANENT,
        code: 'PROXMOX_TASK_FAILED',
        safeMessage: 'The provider task failed.',
      },
      observedAt: new Date().toISOString(),
    };
  }

  /** Powers on a VM, after confirming its ownership markers match exactly. */
  public async startInstance(
    request: StartInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<StartInstanceResponse> {
    const mutation = request.request;
    const context = this.assertContext(mutation?.context);
    const ownership = this.assertOwnership(mutation?.expectedOwnershipMarkers, context);
    const vmid = this.assertVmid(mutation?.providerResourceId);
    await this.requireOwnedConfig(vmid, ownership, options?.signal);
    const current = await this.currentStatus(vmid, options?.signal);
    if (current.status === 'running') {
      return {
        result: {
          state: ProviderResultState.PROVIDER_RESULT_STATE_SUCCEEDED,
          providerResourceId: String(vmid),
          evidenceId: randomUUID(),
        },
      };
    }
    const upid = await this.request<string>(
      'POST',
      `/nodes/${encodeURIComponent(this.configuration.node)}/qemu/${vmid}/status/start`,
      form({}),
      options?.signal,
    );
    return { result: this.accepted(vmid, required(upid, 'provider task reference')) };
  }

  /**
   * Reads config, status, and ownership to prove what actually exists.
   *
   * The completion evidence for the create workflow. Reports absence rather than throwing when
   * the VM is not found, so the caller can distinguish "not there" from "could not tell".
   */
  public async observeInstance(
    request: ObserveInstanceRequest,
    options?: ProviderCallOptions,
  ): Promise<ObserveInstanceResponse> {
    const context = this.assertContext(request.context);
    const expected = this.assertOwnership(request.expectedOwnershipMarkers, context);
    const vmid = request.providerResourceId
      ? this.assertVmid(request.providerResourceId)
      : await this.findOwnedVmid(expected, options?.signal);
    if (vmid === null) return { observation: this.absentObservation() };
    const config = await this.vmConfig(vmid, options?.signal, true);
    if (!config) return { observation: this.absentObservation() };
    const status = await this.currentStatus(vmid, options?.signal);
    const actual = parseOwnership(config.description);
    const observation: InstanceObservation = {
      exists: true,
      providerResourceId: String(vmid),
      powerState:
        status.status === 'running'
          ? ObservedPowerState.OBSERVED_POWER_STATE_RUNNING
          : status.status === 'stopped'
            ? ObservedPowerState.OBSERVED_POWER_STATE_STOPPED
            : ObservedPowerState.OBSERVED_POWER_STATE_UNKNOWN,
      resources: {
        cpuCount: config.cores ?? 0,
        memoryMib: String(config.memory ?? 0),
        ...(diskGiB(config) ? { diskGib: diskGiB(config) } : {}),
      },
      ownership: {
        complete: actual !== null,
        match: markersMatch(actual, expected),
        ...(actual ? { values: actual } : {}),
      },
      observedAt: new Date().toISOString(),
    };
    return { observation };
  }

  private accepted(vmid: number, upid: string): ProviderMutationResult {
    return {
      state: ProviderResultState.PROVIDER_RESULT_STATE_ACCEPTED,
      providerResourceId: String(vmid),
      providerTaskReference: this.encodeTask(upid),
      evidenceId: randomUUID(),
    };
  }

  private assertDirectProfile(profileId: string | undefined): void {
    if (profileId !== this.configuration.providerProfileId) {
      throw new ProviderTransportError('protocol_error', 'Provider profile is not allowlisted.', {
        retryable: false,
      });
    }
  }

  private assertContext(
    context: SubmitCreateInstanceRequest['context'],
  ): NonNullable<SubmitCreateInstanceRequest['context']> {
    if (!context)
      throw new ProviderTransportError('protocol_error', 'Context is required.', {
        retryable: false,
      });
    this.assertDirectProfile(context.providerProfileId);
    if (context.projectId !== this.configuration.projectId) {
      throw new ProviderTransportError('protocol_error', 'Project is outside the lab boundary.', {
        retryable: false,
      });
    }
    required(context.requestId, 'context.requestId');
    required(context.operationId, 'context.operationId');
    required(context.correlationId, 'context.correlationId');
    required(context.instanceId, 'context.instanceId');
    return context;
  }

  private assertOwnership(
    markers: OwnershipMarkers | undefined,
    context: NonNullable<SubmitCreateInstanceRequest['context']>,
  ): OwnershipMarkers {
    if (
      !markers ||
      markers.managedBy !== this.configuration.managedBy ||
      markers.environment !== this.configuration.environment ||
      markers.projectId !== context.projectId ||
      markers.instanceId !== context.instanceId ||
      markers.createOperationId !== context.operationId
    ) {
      throw new ProviderTransportError(
        'protocol_error',
        'Ownership markers violate the lab boundary.',
        { retryable: false },
      );
    }
    return markers;
  }

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

  private assertResources(
    resources: NonNullable<ApplyInstanceConfigurationRequest['resources']>,
    current: ProxmoxVmConfig,
  ): void {
    const cpu = resources.cpuCount ?? 0;
    const memory = Number(resources.memoryMib ?? 0);
    const disk = Number(resources.diskGib ?? 0);
    if (
      !Number.isInteger(cpu) ||
      cpu < 1 ||
      cpu > 8 ||
      !Number.isInteger(memory) ||
      memory < 512 ||
      memory > 16_384 ||
      !Number.isInteger(disk) ||
      disk < 1 ||
      disk > 128 ||
      diskGiB(current) !== String(disk)
    ) {
      throw new ProviderTransportError(
        'protocol_error',
        'Resources violate the Phase 3 allowlist or template disk baseline.',
        { retryable: false },
      );
    }
  }

  private assertNetwork(network: NonNullable<ApplyInstanceConfigurationRequest['network']>): void {
    const address = required(network.ipv4Address, 'network.ipv4Address');
    let range: ipaddr.IPv4 | ipaddr.IPv6;
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    let prefixLength: number;
    try {
      [range, prefixLength] = ipaddr.parseCIDR(this.configuration.ipv4Cidr);
      parsed = ipaddr.parse(address);
    } catch (cause: unknown) {
      throw new ProviderTransportError('protocol_error', 'IPv4 address is invalid.', {
        cause,
        retryable: false,
      });
    }
    if (
      network.networkId !== this.configuration.networkId ||
      network.ipv4Gateway !== this.configuration.ipv4Gateway ||
      network.ipv4PrefixLength !== prefixLength ||
      parsed.kind() !== 'ipv4' ||
      range.kind() !== 'ipv4' ||
      !parsed.match(range, prefixLength) ||
      (network.dnsServers?.length ?? 0) < 1
    ) {
      throw new ProviderTransportError(
        'protocol_error',
        'Network configuration violates the lab allowlist.',
        { retryable: false },
      );
    }
  }

  private async findOwnedOrFreeVmid(
    markers: OwnershipMarkers,
    signal?: AbortSignal,
  ): Promise<number> {
    const summaries = await this.listVms(signal);
    const occupied = new Set(summaries.flatMap((entry) => (entry.vmid ? [entry.vmid] : [])));
    const size = this.configuration.resourceIdMaximum - this.configuration.resourceIdMinimum + 1;
    const seed = Number.parseInt(
      createHash('sha256')
        .update(required(markers.instanceId, 'ownership.instanceId'))
        .digest('hex')
        .slice(0, 8),
      16,
    );
    for (let offset = 0; offset < size; offset += 1) {
      const vmid = this.configuration.resourceIdMinimum + ((seed + offset) % size);
      if (!occupied.has(vmid)) return vmid;
      const config = await this.vmConfig(vmid, signal, false);
      if (markersMatch(parseOwnership(config?.description), markers)) return vmid;
    }
    throw new ProviderTransportError('protocol_error', 'The reserved VMID range is exhausted.', {
      retryable: false,
    });
  }

  private async findOwnedVmid(
    markers: OwnershipMarkers,
    signal?: AbortSignal,
  ): Promise<number | null> {
    for (const summary of await this.listVms(signal)) {
      if (
        !summary.vmid ||
        summary.vmid < this.configuration.resourceIdMinimum ||
        summary.vmid > this.configuration.resourceIdMaximum
      )
        continue;
      const config = await this.vmConfig(summary.vmid, signal, false);
      if (markersMatch(parseOwnership(config?.description), markers)) return summary.vmid;
    }
    return null;
  }

  private listVms(signal?: AbortSignal): Promise<ProxmoxVmSummary[]> {
    return this.request<ProxmoxVmSummary[]>(
      'GET',
      `/nodes/${encodeURIComponent(this.configuration.node)}/qemu`,
      undefined,
      signal,
    );
  }

  private currentStatus(vmid: number, signal?: AbortSignal): Promise<ProxmoxCurrentStatus> {
    return this.request<ProxmoxCurrentStatus>(
      'GET',
      `/nodes/${encodeURIComponent(this.configuration.node)}/qemu/${vmid}/status/current`,
      undefined,
      signal,
    );
  }

  private async vmConfig(
    vmid: number,
    signal: AbortSignal | undefined,
    allowMissing: boolean,
  ): Promise<ProxmoxVmConfig | null> {
    try {
      return await this.request<ProxmoxVmConfig>(
        'GET',
        `/nodes/${encodeURIComponent(this.configuration.node)}/qemu/${vmid}/config`,
        undefined,
        signal,
      );
    } catch (error: unknown) {
      if (allowMissing && error instanceof ProxmoxHttpError && error.status === 404) return null;
      throw error;
    }
  }

  private async requireOwnedConfig(
    vmid: number,
    expected: OwnershipMarkers,
    signal?: AbortSignal,
  ): Promise<ProxmoxVmConfig> {
    const config = await this.vmConfig(vmid, signal, true);
    if (!config || !markersMatch(parseOwnership(config.description), expected)) {
      throw new ProviderTransportError(
        'protocol_error',
        'Provider ownership could not be proven.',
        { retryable: false },
      );
    }
    return config;
  }

  private async assertIpv4Available(
    address: string,
    currentVmid: number,
    signal?: AbortSignal,
  ): Promise<void> {
    required(address, 'network.ipv4Address');
    for (const summary of await this.listVms(signal)) {
      if (!summary.vmid || summary.vmid === currentVmid) continue;
      const config = await this.vmConfig(summary.vmid, signal, false);
      if (config?.ipconfig0?.includes(`ip=${address}/`)) {
        throw new ProviderTransportError(
          'protocol_error',
          'The reserved IPv4 address is already configured.',
          { retryable: false },
        );
      }
    }
  }

  private absentObservation(): InstanceObservation {
    return {
      exists: false,
      powerState: ObservedPowerState.OBSERVED_POWER_STATE_UNKNOWN,
      ownership: { complete: false, match: false },
      observedAt: new Date().toISOString(),
    };
  }

  private encodeTask(upid: string): string {
    return `${this.configuration.node}:${Buffer.from(upid).toString('base64url')}`;
  }

  private decodeTask(reference: string): { node: string; upid: string } {
    const separator = reference.indexOf(':');
    if (separator < 1)
      throw new ProviderTransportError('protocol_error', 'Task reference is invalid.', {
        retryable: false,
      });
    try {
      const decoded = {
        node: reference.slice(0, separator),
        upid: Buffer.from(reference.slice(separator + 1), 'base64url').toString('utf8'),
      };
      if (!decoded.upid.startsWith('UPID:')) throw new Error('UPID prefix is missing.');
      return decoded;
    } catch (cause: unknown) {
      throw new ProviderTransportError('protocol_error', 'Task reference is invalid.', {
        cause,
        retryable: false,
      });
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: URLSearchParams,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 15_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.configuration.endpoint.replace(/\/$/, '')}/api2/json${path}`, {
        method,
        headers: {
          Authorization: `PVEAPIToken=${this.configuration.apiTokenId}=${this.configuration.apiTokenSecret}`,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body ? { body } : {}),
        signal,
      });
    } catch (cause: unknown) {
      const code = callerSignal?.aborted
        ? 'aborted'
        : timeout.aborted
          ? 'deadline_exceeded'
          : 'unavailable';
      throw new ProviderTransportError(code, 'Proxmox transport failed.', { cause });
    }
    if (!response.ok) throw new ProxmoxHttpError(response.status);
    let envelope: ProxmoxEnvelope<T>;
    try {
      envelope = (await response.json()) as ProxmoxEnvelope<T>;
    } catch (cause: unknown) {
      throw new ProviderTransportError('protocol_error', 'Proxmox returned invalid JSON.', {
        cause,
        retryable: false,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      throw new ProviderTransportError('protocol_error', 'Proxmox response omitted data.', {
        retryable: false,
      });
    }
    return envelope.data;
  }
}

/** An HTTP-level Proxmox failure, carrying the status for classification. */
class ProxmoxHttpError extends ProviderTransportError {
  public constructor(public readonly status: number) {
    const retryable = status === 408 || status === 429 || status >= 500;
    super(retryable ? 'unavailable' : 'protocol_error', 'Proxmox rejected the request.', {
      retryable,
    });
    this.name = 'ProxmoxHttpError';
  }
}
