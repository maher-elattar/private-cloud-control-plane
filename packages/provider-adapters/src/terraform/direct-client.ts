/**
 * The narrowed Proxmox client for operations Terraform cannot express.
 *
 * PATTERN — honest hybrid. bpg publishes no snapshot resource and no snapshot data source, and a
 * declarative provider has no vocabulary for "reboot now" or "stop hard". Six of the seventeen
 * port methods therefore cannot go through Terraform at all, and pretending otherwise would mean
 * discovering it at the first snapshot request.
 *
 * This client is deliberately much smaller than the direct adapter. It performs only those six
 * operations, it holds no create or configure path, and it can name no VMID outside the reserved
 * interval. What it does *not* do is as important as what it does: it never writes a VM's
 * configuration, so it cannot move an instance away from the state Terraform believes in.
 *
 * **Every mutation here leaves Terraform state stale**, because Terraform did not make the change
 * and has no way to know about it. A rollback in particular reverts disk and configuration
 * wholesale. The caller is responsible for a `-refresh-only` afterwards, and the adapter's
 * snapshot methods do exactly that.
 *
 * @see docs/architecture/terraform-manual-walkthrough.md
 * @see terraform-provisioning-plan.md
 */
import { ProviderTransportError } from '@private-cloud/provider-sdk';

/** Everything this client needs, and nothing it does not. */
export interface DirectClientConfiguration {
  /** Proxmox API base, which must be HTTPS. */
  readonly endpoint: string;
  /** `user@realm!tokenid`. */
  readonly apiTokenId: string;
  readonly apiTokenSecret: string;
  /** The single allowlisted node. */
  readonly node: string;
  /** The reserved VMID interval. Nothing outside it can be named. */
  readonly resourceIdMinimum: number;
  readonly resourceIdMaximum: number;
  readonly requestTimeoutMs?: number;
}

/** One snapshot as Proxmox lists it. */
export interface ProxmoxSnapshot {
  readonly name: string;
  readonly description?: string;
  /** Unix seconds. Absent on the synthetic `current` entry. */
  readonly snaptime?: number;
}

/** Default ceiling for one request. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The synthetic entry Proxmox includes in every snapshot listing.
 *
 * It represents "the VM as it is now" rather than a snapshot, and returning it to a caller would
 * offer a rollback target that is not one.
 */
const SYNTHETIC_SNAPSHOT = 'current';

/**
 * Snapshot names this client will send.
 *
 * The name is interpolated into a URL path, so it is validated rather than escaped: a name that
 * needed escaping is a name Proxmox would reject anyway, and validating is easier to audit.
 */
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** A Proxmox HTTP failure, carrying the retry classification its status implies. */
class ProxmoxHttpError extends ProviderTransportError {
  public constructor(public readonly status: number) {
    const retryable = status === 408 || status === 429 || status >= 500;
    super(retryable ? 'unavailable' : 'protocol_error', 'Proxmox rejected the request.', {
      retryable,
    });
    this.name = 'ProxmoxHttpError';
  }
}

/** Performs the six operations Terraform has no expression for. */
export class ProxmoxDirectClient {
  public constructor(private readonly configuration: DirectClientConfiguration) {
    const endpoint = new URL(configuration.endpoint);
    if (endpoint.protocol !== 'https:') {
      throw new Error('Proxmox endpoint must use HTTPS.');
    }
  }

  /**
   * Lists an instance's snapshots.
   *
   * @param vmid The instance's VMID.
   * @param signal Cancellation.
   * @returns The snapshots, with the synthetic `current` entry removed.
   */
  public async listSnapshots(vmid: number, signal?: AbortSignal): Promise<ProxmoxSnapshot[]> {
    const entries = await this.request<ProxmoxSnapshot[]>(
      'GET',
      `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/snapshot`,
      undefined,
      signal,
    );
    return (entries ?? []).filter((entry) => entry.name !== SYNTHETIC_SNAPSHOT);
  }

  /**
   * Takes a snapshot.
   *
   * `vmstate=0` keeps it disk-only. Including memory would make the snapshot far larger and make
   * a rollback restore a running process image, which is not what a lifecycle snapshot means
   * here.
   *
   * @returns The Proxmox task identifier.
   */
  public async createSnapshot(
    vmid: number,
    name: string,
    description: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.request<string>(
      'POST',
      `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/snapshot`,
      new URLSearchParams({
        snapname: this.assertSnapshotName(name),
        vmstate: '0',
        ...(description ? { description } : {}),
      }),
      signal,
    );
  }

  /**
   * Rolls an instance back to a snapshot.
   *
   * **This is the single most state-invalidating operation in the system.** It reverts the disk
   * and the configuration to an earlier moment, and Terraform learns nothing about it. The
   * caller must refresh afterwards, and must treat the workspace as drifted until that refresh
   * proves otherwise.
   *
   * @returns The Proxmox task identifier.
   */
  public async rollbackSnapshot(vmid: number, name: string, signal?: AbortSignal): Promise<string> {
    return this.request<string>(
      'POST',
      `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/snapshot/${encodeURIComponent(
        this.assertSnapshotName(name),
      )}/rollback`,
      new URLSearchParams({ start: '1' }),
      signal,
    );
  }

  /**
   * Deletes a snapshot.
   *
   * @returns The Proxmox task identifier.
   */
  public async deleteSnapshot(vmid: number, name: string, signal?: AbortSignal): Promise<string> {
    return this.request<string>(
      'DELETE',
      `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/snapshot/${encodeURIComponent(
        this.assertSnapshotName(name),
      )}`,
      undefined,
      signal,
    );
  }

  /**
   * Reboots an instance.
   *
   * Not expressible declaratively: a reboot leaves the desired state exactly as it was, so there
   * is nothing for Terraform to converge to.
   *
   * @returns The Proxmox task identifier.
   */
  public async reboot(vmid: number, signal?: AbortSignal): Promise<string> {
    return this.request<string>(
      'POST',
      `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/status/reboot`,
      new URLSearchParams(),
      signal,
    );
  }

  /**
   * Stops an instance without waiting for the guest.
   *
   * `started = false` in Terraform is a *graceful* shutdown. A hard stop is a different operation
   * with different consequences for the guest, and conflating them would mean a caller asking for
   * one and silently getting the other.
   *
   * `overrule-shutdown=1` is required when a graceful shutdown is already pending; without it
   * Proxmox refuses.
   *
   * @returns The Proxmox task identifier.
   */
  public async stopHard(vmid: number, signal?: AbortSignal): Promise<string> {
    return this.request<string>(
      'POST',
      `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/status/stop`,
      new URLSearchParams({ 'overrule-shutdown': '1' }),
      signal,
    );
  }

  /**
   * Reads one task's status.
   *
   * A task counts as successful only when it is `stopped` *and* reports `exitstatus=OK`.
   * `stopped` alone means finished, not succeeded — a distinction that decides whether a
   * workflow proceeds or goes to review.
   *
   * @returns `running`, `succeeded` or `failed`.
   */
  public async taskState(
    upid: string,
    signal?: AbortSignal,
  ): Promise<'running' | 'succeeded' | 'failed'> {
    const task = await this.request<{ status?: string; exitstatus?: string }>(
      'GET',
      `/nodes/${this.node()}/tasks/${encodeURIComponent(upid)}/status`,
      undefined,
      signal,
    );
    if (task?.status !== 'stopped') return 'running';
    return task.exitstatus === 'OK' ? 'succeeded' : 'failed';
  }

  /**
   * Reads a VM's configuration.
   *
   * The one read this client offers, and it exists so the adapter can prove ownership before a
   * destructive snapshot operation without having to reach for the other adapter.
   *
   * @returns The configuration, or `null` when the VM does not exist.
   */
  public async config(vmid: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    try {
      return await this.request<Record<string, unknown>>(
        'GET',
        `/nodes/${this.node()}/qemu/${this.assertVmid(vmid)}/config`,
        undefined,
        signal,
      );
    } catch (error) {
      if (error instanceof ProxmoxHttpError && (error.status === 404 || error.status === 403)) {
        // 403 as well as 404: with per-VMID access control, a VMID that does not exist is
        // indistinguishable from one this token may not see, and both mean "not ours to report".
        return null;
      }
      throw error;
    }
  }

  private node(): string {
    return encodeURIComponent(this.configuration.node);
  }

  /** Refuses a VMID outside the reservation. */
  private assertVmid(vmid: number): number {
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

  /** Refuses a snapshot name that could not be safely placed in a URL path. */
  private assertSnapshotName(name: string): string {
    if (!SNAPSHOT_NAME_PATTERN.test(name) || name === SYNTHETIC_SNAPSHOT) {
      throw new ProviderTransportError('protocol_error', 'Snapshot name is invalid.', {
        retryable: false,
      });
    }
    return name;
  }

  /** One Proxmox API call. */
  private async request<T>(
    method: 'DELETE' | 'GET' | 'POST' | 'PUT',
    path: string,
    body?: URLSearchParams,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.configuration.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
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
    } catch (cause) {
      // The order matters: a caller's cancellation is not a provider problem, and a deadline is
      // not the same as an unreachable server. Only `protocol_error` implies nothing happened.
      const code = callerSignal?.aborted
        ? 'aborted'
        : timeout.aborted
          ? 'deadline_exceeded'
          : 'unavailable';
      throw new ProviderTransportError(code, 'Proxmox transport failed.', { cause });
    }

    if (!response.ok) throw new ProxmoxHttpError(response.status);

    let envelope: { data?: T };
    try {
      envelope = (await response.json()) as { data?: T };
    } catch (cause) {
      throw new ProviderTransportError('protocol_error', 'Proxmox returned invalid JSON.', {
        cause,
      });
    }
    if (!('data' in envelope)) {
      throw new ProviderTransportError('protocol_error', 'Proxmox response omitted data.', {
        retryable: false,
      });
    }
    return envelope.data as T;
  }
}
