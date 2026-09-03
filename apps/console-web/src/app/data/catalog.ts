/**
 * Static catalog used when the control API is unreachable.
 *
 * Mirrors the shape (not the branding) of a real provider catalog so the create flow can be
 * exercised offline and during visual review. The live catalog comes from
 * `/v1/projects/{id}/catalog/{flavors,images,networks}`.
 */
import type { Flavor, Image, Location } from './types';

export const FLAVORS: readonly Flavor[] = [
  {
    id: 'cpx12',
    name: 'CPX12',
    vcpus: 1,
    memoryGb: 2,
    diskGb: 40,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'shared',
    pricePerHour: 0.018,
    pricePerMonth: 11.49,
    isNew: true,
  },
  {
    id: 'cpx22',
    name: 'CPX22',
    vcpus: 2,
    memoryGb: 4,
    diskGb: 80,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'shared',
    pricePerHour: 0.031,
    pricePerMonth: 19.49,
  },
  {
    id: 'cpx32',
    name: 'CPX32',
    vcpus: 4,
    memoryGb: 8,
    diskGb: 160,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'shared',
    pricePerHour: 0.057,
    pricePerMonth: 35.49,
  },
  {
    id: 'cpx42',
    name: 'CPX42',
    vcpus: 8,
    memoryGb: 16,
    diskGb: 320,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'shared',
    pricePerHour: 0.111,
    pricePerMonth: 69.49,
  },
  {
    id: 'cpx52',
    name: 'CPX52',
    vcpus: 12,
    memoryGb: 24,
    diskGb: 480,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'shared',
    pricePerHour: 0.161,
    pricePerMonth: 100.49,
  },
  {
    id: 'cpx62',
    name: 'CPX62',
    vcpus: 16,
    memoryGb: 32,
    diskGb: 640,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'shared',
    pricePerHour: 0.208,
    pricePerMonth: 129.99,
  },
  {
    id: 'ccx13',
    name: 'CCX13',
    vcpus: 2,
    memoryGb: 8,
    diskGb: 80,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'dedicated',
    pricePerHour: 0.032,
    pricePerMonth: 20.49,
  },
  {
    id: 'ccx23',
    name: 'CCX23',
    vcpus: 4,
    memoryGb: 16,
    diskGb: 160,
    trafficTb: 20,
    architecture: 'AMD',
    category: 'dedicated',
    pricePerHour: 0.063,
    pricePerMonth: 39.99,
  },
  {
    id: 'ccx33',
    name: 'CCX33',
    vcpus: 8,
    memoryGb: 32,
    diskGb: 240,
    trafficTb: 30,
    architecture: 'AMD',
    category: 'dedicated',
    pricePerHour: 0.125,
    pricePerMonth: 78.99,
  },
  {
    id: 'ccx43',
    name: 'CCX43',
    vcpus: 16,
    memoryGb: 64,
    diskGb: 360,
    trafficTb: 40,
    architecture: 'AMD',
    category: 'dedicated',
    pricePerHour: 0.25,
    pricePerMonth: 156.99,
  },
];

/** IPv4 addresses are billed separately from the server itself. */
export const IPV4_PRICE_PER_MONTH = 0.5;

/** Automatic daily backups are priced as a percentage of the server plan. */
export const BACKUP_PRICE_RATIO = 0.2;

/** Snapshots are billed on stored size rather than on the server's plan. */
export const SNAPSHOT_PRICE_PER_GB = 0.0143;

/**
 * Floating IPs are billed per address per month, independently of any server.
 *
 * IPv4 costs more than IPv6 because the exhausted v4 space carries a scarcity premium.
 */
export const FLOATING_IP_PRICE_PER_MONTH = { ipv4: 3, ipv6: 1 } as const;

export const LOCATIONS: readonly Location[] = [
  {
    id: 'nbg1',
    city: 'Nuremberg',
    country: 'Germany',
    networkZone: 'eu-central',
    countryCode: 'de',
  },
  {
    id: 'fsn1',
    city: 'Falkenstein',
    country: 'Germany',
    networkZone: 'eu-central',
    countryCode: 'de',
  },
  {
    id: 'hel1',
    city: 'Helsinki',
    country: 'Finland',
    networkZone: 'eu-central',
    countryCode: 'fi',
  },
  {
    id: 'sin1',
    city: 'Singapore',
    country: 'Singapore',
    networkZone: 'ap-southeast',
    countryCode: 'sg',
    surchargePerMonth: 7,
  },
  {
    id: 'hil1',
    city: 'Hillsboro, OR',
    country: 'United States',
    networkZone: 'us-west',
    countryCode: 'us',
  },
  {
    id: 'ash1',
    city: 'Ashburn, VA',
    country: 'United States',
    networkZone: 'us-east',
    countryCode: 'us',
  },
];

export const IMAGES: readonly Image[] = [
  { id: 'ubuntu', family: 'Ubuntu', versions: ['26.04', '24.04', '22.04'], logo: '#E95420' },
  { id: 'fedora', family: 'Fedora', versions: ['44', '43'], logo: '#51A2DA' },
  { id: 'debian', family: 'Debian', versions: ['13', '12'], logo: '#A80030' },
  { id: 'centos', family: 'CentOS', versions: ['Stream 10', 'Stream 9'], logo: '#9CCD2A' },
  { id: 'rocky', family: 'Rocky Linux', versions: ['10', '9'], logo: '#10B981' },
  { id: 'alma', family: 'AlmaLinux', versions: ['10', '9'], logo: '#0F4266' },
  { id: 'opensuse', family: 'openSUSE', versions: ['16', '15.6'], logo: '#73BA25' },
];

/** Derives the console's default server name, e.g. `ubuntu-2gb-hel1-1`. */
export function defaultInstanceName(
  image: string,
  memoryGb: number,
  location: string,
  index = 1,
): string {
  return `${image.toLowerCase().replace(/\s+/g, '')}-${memoryGb}gb-${location}-${index}`;
}

/**
 * Asserts a catalog is non-empty.
 *
 * WHY: the catalogs above are module constants, but `noUncheckedIndexedAccess` still types an
 * index read as possibly-undefined. Resolving that once here keeps every call site free of
 * non-null assertions, and an empty catalog is a build-time mistake worth failing loudly on.
 */
function requireFirst<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (!first) throw new Error(`The ${what} catalog is empty`);
  return first;
}

export const DEFAULT_FLAVOR = requireFirst(FLAVORS, 'flavor');
export const DEFAULT_LOCATION = requireFirst(LOCATIONS, 'location');
export const DEFAULT_IMAGE = requireFirst(IMAGES, 'image');

/** Resolves a flavor id, falling back to the catalog default for unknown ids. */
export function findFlavor(id: string | null | undefined): Flavor {
  return FLAVORS.find((candidate) => candidate.id === id) ?? DEFAULT_FLAVOR;
}

/** Resolves a location id, falling back to the catalog default for unknown ids. */
export function findLocation(id: string | null | undefined): Location {
  return LOCATIONS.find((candidate) => candidate.id === id) ?? DEFAULT_LOCATION;
}

/** Resolves an image id, falling back to the catalog default for unknown ids. */
export function findImage(id: string | null | undefined): Image {
  return IMAGES.find((candidate) => candidate.id === id) ?? DEFAULT_IMAGE;
}

/** The newest version of an image family — the version preselected in the wizard. */
export function latestVersion(image: Image): string {
  return requireFirst(image.versions, `${image.family} version`);
}
