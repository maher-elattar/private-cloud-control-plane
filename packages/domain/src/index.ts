/**
 * Framework-free domain rules: error codes, canonical hashing, IPv4 allocation, validation.
 *
 * The innermost layer. It imports nothing from NestJS, no database driver, and no vendor SDK —
 * only Node's `crypto` and an IP parsing library. Nx enforces this: `layer:domain` may depend
 * only on `layer:domain`.
 *
 * Everything here is deterministic and synchronous, which is what makes it trivially testable
 * and safe to call from inside a database transaction.
 *
 * @see docs/architecture/glossary.md
 */
import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';

/**
 * Every business failure the control plane can express.
 *
 * A closed union rather than free-form strings, so each transport can exhaustively map them:
 * `api-exception.filter.ts` to HTTP statuses, `grpc-errors.ts` to gRPC statuses. Adding a code
 * breaks both mappings at compile time, which is the point — a new failure mode cannot
 * silently fall through to a generic 500.
 */
export type DomainErrorCode =
  | 'ADMIN_REQUIRED'
  | 'DEAD_LETTER_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSTANCE_BUSY'
  | 'INSTANCE_NOT_FOUND'
  | 'OPERATION_NOT_FOUND'
  | 'PROFILE_DISABLED'
  | 'PROJECT_ACCESS_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'REPLAY_NOT_ALLOWED'
  | 'VALIDATION_FAILED';

/**
 * A business rule violation, as opposed to a bug or an infrastructure failure.
 *
 * Messages are written for tenants and must never carry internal detail — both exception
 * mappers pass them straight through to callers.
 */
export class DomainError extends Error {
  /**
   * @param code Stable machine-readable code, mapped per transport.
   * @param message Tenant-safe description.
   * @param details Optional structured context for logs.
   */
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Recursively rewrites a value into canonical form: keys sorted, `undefined` dropped.
 *
 * The sort is what makes hashing stable. `JSON.stringify` preserves insertion order, so
 * `{a:1,b:2}` and `{b:2,a:1}` would otherwise produce different strings — and therefore
 * different hashes — for the same request.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      // Dropped rather than preserved: `JSON.stringify` already omits `undefined`, so keeping
      // it here would make the canonical form disagree with the serialised one.
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

/** Serialises a value with sorted keys, so equal values always produce equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/**
 * Content hash of a value, independent of key order.
 *
 * The basis of idempotency. `acceptCreate` stores this hash against the caller's
 * `Idempotency-Key`, so a retry that means the same thing is recognised as a retry — even if
 * the client's JSON serialiser ordered the fields differently — while a key reused for
 * genuinely different input is caught as a conflict.
 *
 * Also used as `payload_hash` in `workflow.command_receipts` to detect a redelivered command
 * whose content has changed.
 */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** An IPv4 pool with its gateway and any addresses held back from allocation. */
export interface Ipv4Pool {
  /** Network in CIDR form, for example `10.20.0.0/24`. */
  readonly cidr: string;
  /** Gateway address, always excluded from allocation. */
  readonly gateway: string;
  /** Additional addresses reserved for infrastructure. */
  readonly exclusions: readonly string[];
}

/**
 * Returns the first usable address after applying protocol, gateway, exclusion, and lease rules.
 *
 * Walks the pool from the lowest host address upward and returns the first that is neither
 * excluded nor already leased. Lowest-first makes allocation deterministic, which keeps tests
 * reproducible and makes an allocation easy to reason about after the fact.
 *
 * The bit arithmetic converts the network address to a 32-bit integer so candidates can be
 * produced by simple addition. `>>> 0` forces an unsigned reading — JavaScript's bitwise
 * operators work on *signed* 32-bit integers, so any address at or above `128.0.0.0` would
 * otherwise come out negative.
 *
 * The loop deliberately spans `1` to `hostCount - 1`, skipping the network address at offset
 * `0` and the broadcast address at the top; neither is assignable to a host.
 *
 * Callers must serialise concurrent allocation on the same network — see
 * `PostgresControlPlaneStore.reserveIpv4Address`. This function is pure and cannot prevent two
 * callers receiving the same address.
 *
 * @param leased Addresses already taken, including quarantined ones.
 * @throws DomainError `VALIDATION_FAILED` for a malformed or non-IPv4 pool, or `QUOTA_EXCEEDED`
 *   when the pool is exhausted.
 */
export function allocateIpv4(pool: Ipv4Pool, leased: ReadonlySet<string>): string {
  const [networkAddress, prefixLengthText] = pool.cidr.split('/');
  const prefixLength = Number(prefixLengthText);
  // Prefixes above /30 leave no assignable host addresses once network and broadcast are
  // excluded, so they are rejected as configuration errors rather than failing later.
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

/** The user-supplied portion of a create request, as validated by the domain. */
export interface CreateInstanceValues {
  /** Catalog image slug. */
  readonly imageId: string;
  /** Catalog flavor slug. */
  readonly flavorId: string;
  /** Catalog network slug. */
  readonly networkId: string;
  /** Guest hostname. */
  readonly hostname: string;
  /** Zero to five unique SSH public keys. */
  readonly sshPublicKeys?: readonly string[];
}

/** Catalog identifiers: lowercase, 2-63 characters, no leading hyphen. */
const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** RFC 1123 hostname label: alphanumeric ends, up to 63 characters. */
const hostnamePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Validates the user-supplied fields of a create request.
 *
 * WHY this duplicates `CreateInstanceDto`: the DTO uses `class-validator`, which only runs for
 * REST. gRPC callers bypass it entirely. This function is the check both transports share, so
 * it is the authoritative one — the DTO exists to give REST callers a field-level error at the
 * edge.
 *
 * The SSH key rules are a safety boundary, not cosmetics. Keys are injected into cloud-init,
 * so a key containing a newline or a NUL could inject additional directives into the guest's
 * configuration.
 *
 * @throws DomainError `VALIDATION_FAILED` with a message naming the offending field.
 */
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
    // The control character check is the important one: these keys are written into cloud-init,
    // where an embedded newline could introduce an unintended directive.
    if (key.length < 32 || key.length > 8192 || /[\r\n\0]/.test(key)) {
      throw new DomainError('VALIDATION_FAILED', 'An SSH public key is invalid.');
    }
  }
}
