import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export type DomainErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSTANCE_BUSY'
  | 'INSTANCE_NOT_FOUND'
  | 'OPERATION_NOT_FOUND'
  | 'PROFILE_DISABLED'
  | 'PROJECT_ACCESS_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'VALIDATION_FAILED';

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface Ipv4Pool {
  readonly cidr: string;
  readonly gateway: string;
  readonly exclusions: readonly string[];
}

/** Returns the first usable address after applying protocol, gateway, exclusion, and lease rules. */
export function allocateIpv4(pool: Ipv4Pool, leased: ReadonlySet<string>): string {
  const [networkAddress, prefixLengthText] = pool.cidr.split('/');
  const prefixLength = Number(prefixLengthText);
  if (!networkAddress || !Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 30) {
    throw new DomainError('VALIDATION_FAILED', 'The configured IPv4 pool is invalid.');
  }

  const parsed = ipaddr.parse(networkAddress);
  if (parsed.kind() !== 'ipv4' || ipaddr.parse(pool.gateway).kind() !== 'ipv4') {
    throw new DomainError('VALIDATION_FAILED', 'The configured network must use IPv4.');
  }

  const bytes = parsed.toByteArray();
  const network =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const unsignedNetwork = network >>> 0;
  const hostCount = 2 ** (32 - prefixLength);
  const excluded = new Set([...pool.exclusions, pool.gateway]);

  for (let offset = 1; offset < hostCount - 1; offset += 1) {
    const candidateNumber = (unsignedNetwork + offset) >>> 0;
    const candidate = [24, 16, 8, 0].map((shift) => (candidateNumber >>> shift) & 255).join('.');
    if (!excluded.has(candidate) && !leased.has(candidate)) return candidate;
  }

  throw new DomainError('QUOTA_EXCEEDED', 'No IPv4 address is available in the selected network.');
}

export interface CreateInstanceValues {
  readonly imageId: string;
  readonly flavorId: string;
  readonly networkId: string;
  readonly hostname: string;
  readonly sshPublicKeys?: readonly string[];
}

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const hostnamePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function validateCreateInstance(values: CreateInstanceValues): void {
  if (
    ![values.imageId, values.flavorId, values.networkId].every((value) => slugPattern.test(value))
  ) {
    throw new DomainError('VALIDATION_FAILED', 'Catalog identifiers are invalid.');
  }
  if (!hostnamePattern.test(values.hostname)) {
    throw new DomainError('VALIDATION_FAILED', 'Hostname is invalid.');
  }
  if ((values.sshPublicKeys?.length ?? 0) > 5) {
    throw new DomainError('VALIDATION_FAILED', 'At most five SSH public keys are accepted.');
  }
  if (new Set(values.sshPublicKeys ?? []).size !== (values.sshPublicKeys?.length ?? 0)) {
    throw new DomainError('VALIDATION_FAILED', 'SSH public keys must be unique.');
  }
  for (const key of values.sshPublicKeys ?? []) {
    if (key.length < 32 || key.length > 8192 || /[\r\n\0]/.test(key)) {
      throw new DomainError('VALIDATION_FAILED', 'An SSH public key is invalid.');
    }
  }
}
