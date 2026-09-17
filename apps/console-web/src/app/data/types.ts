/**
 * View models for the console.
 *
 * Presentation shapes, flattened from the contract's desired/observed pair by
 * `view-model.ts`. They are not the wire types, so a route never has to branch on transport
 * detail — but every field here traces to something the API actually returns.
 *
 * **`null` means "the API reported nothing", and it is never substituted with a zero.** The
 * earlier version of this file promised `trafficUsedTb`, `trafficIncludedTb`, `networkZone` and
 * `labels`, none of which exist anywhere in the control plane, and typed the sizing fields as
 * plain numbers that were read from field names the contract does not have — so they rendered as
 * `0`. A console cannot distinguish a measurement of zero from an absence of measurement unless
 * its types do.
 */

/** Lifecycle as the UI needs to render it: a dot colour and, while building, a progress bar. */
export type InstanceStatus = 'running' | 'off' | 'provisioning' | 'error';

/** ISO 3166-1 alpha-2, narrowed to the countries the catalog has locations in. */
export type CountryCode = 'de' | 'fi' | 'sg' | 'us';

export type Flavor = {
  readonly id: string;
  readonly name: string;
  readonly vcpus: number;
  readonly memoryGb: number;
  readonly diskGb: number;
  readonly trafficTb: number;
  readonly architecture: string;
  readonly category: 'shared' | 'dedicated';
  readonly pricePerHour: number;
  readonly pricePerMonth: number;
  readonly isNew?: boolean;
};

export type Location = {
  readonly id: string;
  readonly city: string;
  readonly country: string;
  readonly networkZone: string;
  readonly countryCode: CountryCode;
  readonly surchargePerMonth?: number;
};

export type Image = {
  readonly id: string;
  readonly family: string;
  readonly versions: readonly string[];
  readonly logo: string;
};

export type Instance = {
  readonly id: string;
  /** The instance's hostname. The contract has no separate display name. */
  readonly name: string;
  readonly status: InstanceStatus;
  /** Read from the instance's active operation. Absent when nothing is in flight. */
  readonly progressPercent?: number;
  readonly flavorId: string;
  readonly flavorName: string;
  readonly architecture: string | null;

  /** Requested sizing, from the flavour the instance names. */
  readonly vcpus: number | null;
  readonly memoryGb: number | null;
  readonly diskGb: number | null;

  /**
   * Sizing the provider actually reported.
   *
   * Shown alongside the requested values rather than instead of them, because the two disagreeing
   * is drift — the thing the reconciler exists to surface — and a console that displays only one
   * of them cannot show it.
   */
  readonly observedVcpus: number | null;
  readonly observedMemoryGb: number | null;
  readonly observedDiskGb: number | null;

  readonly imageId: string;
  readonly imageName: string;
  readonly networkId: string;
  readonly networkName: string;

  readonly ipv4: string | null;
  /** `active`, `quarantined` or `released`. A quarantined lease is held back after a failed release. */
  readonly ipv4State: 'active' | 'quarantined' | 'released' | null;
  /** Always `null`: this deployment leases IPv4 only and has no IPv6 allocator. */
  readonly ipv6: string | null;

  readonly pricePerMonth: number;
  readonly lifecycleState: string;
  readonly drift: string;
  readonly retentionDeadline: string | null;
  readonly activeOperationId: string | null;
  readonly createdAt: string;
};

/**
 * An address that is owned by the project rather than by a server.
 *
 * It survives the server it is attached to and can be reassigned to another one in the same
 * network zone, which is what makes it useful for failover.
 */
export type FloatingIp = {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly protocol: 'ipv4' | 'ipv6';
  readonly locationId: string;
  readonly locationCity: string;
  readonly networkZone: string;
  /** `null` while the address is held by the project but not routed to a server. */
  readonly assignedTo: string | null;
  readonly reverseDnsEntries: number;
  readonly pricePerMonth: number;
};

export type ActivityEntry = {
  readonly id: string;
  readonly message: string;
  readonly at: string;
  readonly state: 'succeeded' | 'running' | 'failed';
  /** The operation this entry is, so a failure can be opened for its detail. */
  readonly operationId: string;
  readonly targetId: string;
  /** One of the contract's stable codes, when the operation failed. */
  readonly errorCode?: string;
};

/** A disk image is still being written, or is ready to restore from. */
export type ImageStatus = 'creating' | 'available';

/**
 * A stored disk image.
 *
 * Snapshots and backups share this shape — they differ in lifecycle, not structure. A snapshot is
 * taken on demand and outlives its server; a backup is one of a rotating set of automatic copies.
 */
export type DiskImage = {
  readonly id: string;
  readonly description: string;
  readonly name: string;
  /**
   * `null` always: the contract carries no snapshot size.
   *
   * The earlier version showed 2.1% of the server's disk, which looked like a measurement and was
   * arithmetic on an unrelated number.
   */
  readonly sizeGb: number | null;
  readonly createdAt: string;
  readonly instanceId: string;
  readonly status: ImageStatus;
  /** The contract's own five-state value, for a label more precise than the two-state status. */
  readonly state: 'creating' | 'available' | 'rolling_back' | 'deleting' | 'failed';
};

export type Snapshot = DiskImage;
export type Backup = DiskImage;

/**
 * What the create wizard collects.
 *
 * Only the first four reach the API — `CreateInstanceRequest` is exactly
 * `{ imageId, flavorId, networkId, hostname, sshPublicKeys }` and the API sets
 * `forbidNonWhitelisted`, so one extra property is a hard rejection rather than a field quietly
 * dropped. The wizard's remaining steps are roadmap placeholders and are marked as such in the UI.
 */
export type CreateInstanceInput = {
  readonly hostname: string;
  readonly flavorId: string;
  readonly imageId: string;
  readonly networkId: string;
  readonly sshPublicKeys: readonly string[];
};
