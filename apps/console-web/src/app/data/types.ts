/**
 * View models for the console.
 *
 * These are presentation shapes, deliberately not the wire types from `@private-cloud/contracts`.
 * The API client maps contract responses into these so routes never branch on transport details
 * and the mock adapter can satisfy the same interface.
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
  readonly name: string;
  readonly status: InstanceStatus;
  /** Populated only while `status === 'provisioning'`. */
  readonly progressPercent?: number;
  readonly flavorId: string;
  readonly flavorName: string;
  readonly architecture: string;
  readonly diskGb: number;
  readonly vcpus: number;
  readonly memoryGb: number;
  readonly imageName: string;
  readonly locationId: string;
  readonly locationCity: string;
  readonly networkZone: string;
  readonly ipv4: string | null;
  readonly ipv6: string | null;
  readonly pricePerMonth: number;
  readonly trafficUsedTb: number;
  readonly trafficIncludedTb: number;
  readonly createdAt: string;
  readonly labels: Readonly<Record<string, string>>;
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
  readonly sizeGb: number;
  readonly createdAt: string;
  readonly instanceId: string;
  readonly status: ImageStatus;
  /** Populated only while `status === 'creating'`. */
  readonly progressPercent?: number;
};

export type Snapshot = DiskImage;
export type Backup = DiskImage;

export type CreateInstanceInput = {
  readonly name: string;
  readonly flavorId: string;
  readonly locationId: string;
  readonly imageId: string;
  readonly imageVersion: string;
  readonly useIpv4: boolean;
  readonly useIpv6: boolean;
  readonly usePrivateNetwork: boolean;
  readonly backups: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly cloudConfig: string;
};
