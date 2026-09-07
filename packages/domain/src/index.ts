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
  | 'DISK_SHRINK_FORBIDDEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSTANCE_BUSY'
  | 'INSTANCE_NOT_FOUND'
  | 'OPERATION_NOT_FOUND'
  | 'PROFILE_DISABLED'
  | 'PROJECT_ACCESS_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'REPLAY_NOT_ALLOWED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_OWNERSHIP_MISMATCH'
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
 * @throws DomainError `VALIDATION_FAILED` for a malformed or non-IPv4 pool, a pool whose address
 *   is not the network address for its prefix, or `QUOTA_EXCEEDED` when the pool is exhausted.
 */
export function allocateIpv4(pool: Ipv4Pool, leased: ReadonlySet<string>): string {
  const [networkAddress, prefixLengthText] = pool.cidr.split('/');
  const prefixLength = Number(prefixLengthText);
  // Prefixes above /30 leave no assignable host addresses once network and broadcast are
  // excluded, so they are rejected as configuration errors rather than failing later.
  if (!networkAddress || !Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 30) {
    throw new DomainError('VALIDATION_FAILED', 'The configured IPv4 pool is invalid.');
  }

  const network = strictIpv4(networkAddress);
  const gateway = strictIpv4(pool.gateway);
  if (network === null || gateway === null) {
    throw new DomainError('VALIDATION_FAILED', 'The configured network must use IPv4.');
  }

  const unsignedNetwork = network >>> 0;
  const hostCount = 2 ** (32 - prefixLength);

  // WHY reject host bits rather than mask them off: a CIDR like `192.0.2.5/24` is an operator
  // typo, and silently treating it as `192.0.2.0/24` would allocate from a range nobody wrote
  // down. Failing here surfaces the mistake while it is still a configuration error.
  if ((unsignedNetwork & (hostCount - 1)) !== 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'The configured IPv4 pool must name a network address.',
    );
  }
  const excluded = new Set([...pool.exclusions, pool.gateway]);

  for (let offset = 1; offset < hostCount - 1; offset += 1) {
    const candidateNumber = (unsignedNetwork + offset) >>> 0;
    const candidate = [24, 16, 8, 0].map((shift) => (candidateNumber >>> shift) & 255).join('.');
    if (!excluded.has(candidate) && !leased.has(candidate)) return candidate;
  }

  throw new DomainError('QUOTA_EXCEEDED', 'No IPv4 address is available in the selected network.');
}

/**
 * Parses exactly four dotted decimal octets, or returns `null`.
 *
 * WHY not `ipaddr.parse`: it accepts the legacy `inet_aton` short forms, so `192.0.2` is read as
 * `192.0.0.2`. A provider profile carrying `192.0.2/24` would then allocate from `192.0.0.0`
 * instead of the network the operator wrote — addresses outside the project network, which
 * SAFE-024 forbids. It also throws a bare `Error` on malformed input, which would surface to a
 * caller as an unclassified failure rather than `VALIDATION_FAILED`.
 *
 * @returns The address as a signed 32-bit integer, or `null` when it is not a dotted quad.
 */
function strictIpv4(value: string): number | null {
  const octets = value.split('.');
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(octet)) return null;
    const parsed = Number(octet);
    if (parsed > 255) return null;
    result = (result << 8) | parsed;
  }
  return result;
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

/** The power transitions a tenant may request on a running instance. */
export const POWER_ACTIONS = ['start', 'shutdown', 'stop', 'reboot'] as const;

/** A requested power transition. */
export type PowerAction = (typeof POWER_ACTIONS)[number];

/**
 * Validates a requested power action.
 *
 * `shutdown` and `stop` are deliberately distinct rather than one action with a `force` flag.
 * `shutdown` asks the guest to stop itself and may take as long as the guest needs; `stop` cuts
 * power and can lose unflushed writes. Collapsing them would let a caller destroy data through a
 * parameter default.
 *
 * @throws DomainError `VALIDATION_FAILED` when the action is not one of the four.
 */
export function validatePowerAction(action: string): PowerAction {
  if (!(POWER_ACTIONS as readonly string[]).includes(action)) {
    throw new DomainError('VALIDATION_FAILED', 'The requested power action is not supported.');
  }
  return action as PowerAction;
}

/** A requested change to an instance's compute and disk sizing. */
export interface ResizeRequest {
  /** Sizing the instance currently has, read under the acceptance lock. */
  readonly current: {
    readonly cpuCount: number;
    readonly memoryMiB: number;
    readonly diskGiB: number;
  };
  /** Sizing the selected flavor defines. */
  readonly target: {
    readonly cpuCount: number;
    readonly memoryMiB: number;
    readonly diskGiB: number;
  };
}

/**
 * Validates a resize against the rules that hold regardless of provider.
 *
 * The disk rule is the important one and is asymmetric on purpose. Growing a disk is additive and
 * reversible in the sense that nothing is lost; shrinking one discards whatever lived in the
 * removed extent, and no provider can undo that. SAFE-026 therefore forbids shrink outright rather
 * than gating it behind a confirmation, because a confirmation is exactly the thing an automated
 * client would send by default.
 *
 * @throws DomainError `DISK_SHRINK_FORBIDDEN` for any reduction in disk size, or
 *   `VALIDATION_FAILED` when the request changes nothing.
 */
export function validateResize(request: ResizeRequest): void {
  if (request.target.diskGiB < request.current.diskGiB) {
    throw new DomainError('DISK_SHRINK_FORBIDDEN', 'Disk size can grow but never shrink.');
  }
  const unchanged =
    request.target.cpuCount === request.current.cpuCount &&
    request.target.memoryMiB === request.current.memoryMiB &&
    request.target.diskGiB === request.current.diskGiB;
  if (unchanged) {
    // WHY reject rather than accept as a no-op: a resize that changes nothing still takes the
    // instance lock, submits a provider mutation, and blocks other operations for its duration.
    // Refusing it keeps a retry loop from holding an instance busy indefinitely.
    throw new DomainError('VALIDATION_FAILED', 'The requested sizing matches the current sizing.');
  }
}

/** Snapshot names Proxmox accepts, and which cannot collide with its synthetic `current` entry. */
const snapshotNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/**
 * Validates a caller-supplied snapshot name.
 *
 * `current` is refused because Proxmox injects an entry by that name into every snapshot listing
 * to mark the live state. A real snapshot sharing the name would be indistinguishable from it, and
 * a rollback targeting the wrong one is not recoverable.
 *
 * @throws DomainError `VALIDATION_FAILED` for a malformed or reserved name.
 */
export function validateSnapshotName(name: string): void {
  if (!snapshotNamePattern.test(name)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Snapshot name must be 1 to 63 characters of letters, digits, dot, dash, or underscore.',
    );
  }
  if (name.toLowerCase() === 'current') {
    throw new DomainError('VALIDATION_FAILED', 'The snapshot name "current" is reserved.');
  }
}

/** The desired state a reconciliation compares against, as recorded by the control plane. */
export interface DesiredSnapshot {
  readonly lifecycleState: string;
  readonly powerState: 'running' | 'stopped' | 'unchanged';
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly diskGiB: number;
}

/** What the provider actually reports, or absence. */
export interface ObservedSnapshot {
  readonly exists: boolean;
  readonly powerState: 'running' | 'stopped' | 'suspended' | 'unknown';
  readonly markerMatch: boolean;
  readonly cpuCount?: number | undefined;
  readonly memoryMiB?: number | undefined;
  readonly diskGiB?: number | undefined;
}

/** How a reconciliation classifies the difference it found. */
export type DriftClassification =
  | 'none'
  | 'missing_resource'
  | 'identity_mismatch'
  | 'stale_task'
  | 'late_success'
  | 'power_drift'
  | 'network_drift'
  | 'ambiguous';

/** A classified difference, and whether correcting it would destroy anything. */
export interface DriftFinding {
  readonly classification: DriftClassification;
  /**
   * Whether an automatic correction would be destructive.
   *
   * SAFE-029 forbids reconciliation from correcting destructive drift automatically, so this flag
   * is what a consumer uses to decide between acting and raising a manual review. It is not a
   * severity: `power_drift` is often more urgent than `identity_mismatch`, but only one of them is
   * safe to fix without a human.
   */
  readonly dangerous: boolean;
}

/**
 * Classifies the difference between desired and observed state.
 *
 * Pure, so the interesting cases can be enumerated in tests rather than staged against a provider.
 *
 * The ordering matters and is not arbitrary. Identity is checked before absence, because a VM
 * whose ownership markers do not match is not evidence about *our* instance at all — treating it
 * as present would be worse than treating it as missing. Absence is checked before sizing, because
 * comparing the CPU count of a machine that does not exist is meaningless.
 */
export function classifyDrift(desired: DesiredSnapshot, observed: ObservedSnapshot): DriftFinding {
  // A provider resource carrying someone else's markers, or none. Never safe to touch.
  if (observed.exists && !observed.markerMatch) {
    return { classification: 'identity_mismatch', dangerous: true };
  }
  if (!observed.exists) {
    // Absence is expected once an instance has been purged; anywhere else it is the most serious
    // finding reconciliation can make, and it is never automatically correctable.
    if (desired.lifecycleState === 'purged') return { classification: 'none', dangerous: false };
    return { classification: 'missing_resource', dangerous: true };
  }
  if (observed.powerState === 'unknown') {
    return { classification: 'ambiguous', dangerous: true };
  }
  if (desired.powerState !== 'unchanged' && observed.powerState !== desired.powerState) {
    // Correctable: starting or stopping a VM to match accepted intent destroys nothing, though a
    // consumer may still choose to act only on an operator's instruction.
    return { classification: 'power_drift', dangerous: false };
  }
  if (
    (observed.cpuCount !== undefined && observed.cpuCount !== desired.cpuCount) ||
    (observed.memoryMiB !== undefined && observed.memoryMiB !== desired.memoryMiB)
  ) {
    return { classification: 'network_drift', dangerous: false };
  }
  if (observed.diskGiB !== undefined && observed.diskGiB < desired.diskGiB) {
    // A disk smaller than desired can be grown; a disk *larger* is not drift, because growth is
    // the only direction this system permits and a tenant may have grown it outside our record.
    return { classification: 'network_drift', dangerous: false };
  }
  return { classification: 'none', dangerous: false };
}
