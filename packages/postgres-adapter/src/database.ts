/**
 * The typed database schema and connection factory.
 *
 * Mirrors the ordered files in `db/migrations` as TypeScript, giving Kysely the type information it
 * needs to check every query at compile time. A column renamed in a migration but not here
 * fails the build rather than at runtime.
 *
 * The four schemas map onto the four roles in the design:
 * - `control` — authoritative write model plus the acceptance outbox
 * - `workflow` — command receipts, leases, saga state, and the workflow outbox
 * - `projection` — pre-built read documents and their consumption receipts
 * - `audit` — append-only record of who asked for what
 *
 * @see docs/architecture/data-ownership.md
 * @see docs/architecture/phase-3-persistence.md
 */
import { Kysely, PostgresDialect, sql, type ColumnType, type Generated } from 'kysely';
import { Pool } from 'pg';

/** `timestamptz`: read as `Date`, accepted as `Date` or ISO string on write. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** `json`/`jsonb`: decode with `parseJsonColumn`, since `json` arrives as text. */
type Json<T> = ColumnType<T, T | string, T | string>;
/**
 * A nullable column with no database default.
 *
 * Distinct from a bare `T | null`, which Kysely requires the caller to supply explicitly on every
 * insert. These columns are genuinely optional at insert time — PostgreSQL stores NULL when they
 * are omitted — so the insert type admits `undefined`.
 */
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;
/** A nullable `timestamptz` with no default. */
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

interface ProjectTable {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface QuotaTable {
  project_id: string;
  instances: number;
  cpu_count: number;
  memory_mib: string;
  disk_gib: string;
  ipv4_addresses: number;
  snapshots: number;
  updated_at: Timestamp;
}

interface NetworkTable {
  id: string;
  name: string;
  ipv4_cidr: string;
  gateway: string;
  dns_servers: Json<string[]>;
  exclusions: Json<string[]>;
  enabled: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ProviderProfileTable {
  id: string;
  provider_type: string;
  state: string;
  endpoint: string;
  cluster_alias: string;
  compute_target: string;
  image_source_reference: string;
  storage_target: string;
  network_attachment: string;
  resource_id_minimum: string;
  resource_id_maximum: string;
  network_id: string;
  credential_reference: string;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ImageTable {
  id: string;
  name: string;
  provider_profile_id: string;
  enabled: boolean;
  architecture: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface FlavorTable {
  id: string;
  name: string;
  cpu_count: number;
  memory_mib: string;
  minimum_disk_gib: string;
  enabled: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface InstanceTable {
  id: string;
  project_id: string;
  image_id: string;
  flavor_id: string;
  network_id: string;
  provider_profile_id: string;
  hostname: string;
  ssh_public_keys: Json<string[]>;
  desired_cpu_count: number;
  desired_memory_mib: string;
  desired_disk_gib: string;
  desired_power_state: string;
  lifecycle_state: string;
  active_operation_id: Nullable<string>;
  version: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /*
   * Retention, drift, and observed state. The `Instance` API document has always published these,
   * but before Phase 5 they existed only inside `projection.instances.document` jsonb. Purge and
   * reconciliation must query them, and a guard that decides whether a VM may be destroyed does
   * not belong in a document body.
   */
  /** Operation whose id is written into this instance's provider ownership markers. */
  create_operation_id: Nullable<string>;
  retention_deadline: NullableTimestamp;
  purge_eligible: Generated<boolean>;
  drift: Generated<string>;
  last_reconciled_at: NullableTimestamp;
  observed_exists: Nullable<boolean>;
  observed_power_state: Nullable<string>;
  observed_cpu_count: Nullable<number>;
  observed_memory_mib: Nullable<string>;
  observed_disk_gib: Nullable<string>;
  observed_marker_match: Nullable<boolean>;
  observed_at: NullableTimestamp;
}

interface SnapshotTable {
  id: string;
  project_id: string;
  instance_id: string;
  name: string;
  description: string | null;
  state: string;
  /** Provider-side name, kept so an interrupted delete resumes against the right object. */
  provider_snapshot_name: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ManualReviewTable {
  id: string;
  project_id: string;
  instance_id: string;
  operation_id: string;
  category: string;
  summary: string;
  state: Generated<string>;
  evidence_reference: string | null;
  resolution: string | null;
  resolved_by: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

/** Single-row configuration; the primary key CHECK is what keeps it single-row. */
interface RetentionPolicyTable {
  id: Generated<boolean>;
  retention_hours: number;
  lease_release_mode: string;
  version: Generated<string>;
  updated_at: Timestamp;
  updated_by: string;
}

interface ProjectionSnapshotTable {
  snapshot_id: string;
  project_id: string;
  instance_id: string;
  document: Json<unknown>;
  updated_at: Timestamp;
}

interface OperationTable {
  id: string;
  project_id: string;
  action: string;
  target_type: string;
  target_id: string;
  state: string;
  stage: string;
  progress_percent: number;
  accepted_at: Timestamp;
  started_at: Timestamp | null;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
  error_category: string | null;
  error_code: string | null;
  error_message: string | null;
  manual_review_required: boolean;
}

interface Ipv4LeaseTable {
  id: string;
  project_id: string;
  instance_id: string;
  network_id: string;
  address: string;
  prefix_length: number;
  gateway: string;
  state: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface IdempotencyTable {
  actor_id: string;
  project_id: string;
  operation_type: string;
  idempotency_key: string;
  target_id: string;
  request_hash: string;
  operation_id: string;
  response: Json<unknown>;
  created_at: Timestamp;
  expires_at: Timestamp;
}

interface OutboxTable {
  outbox_id: string;
  event_id: string;
  aggregate_id: string;
  aggregate_type: string;
  schema_name: string;
  schema_version: number;
  topic: string;
  partition_key: string;
  payload: Json<unknown>;
  tracingspancontext: string;
  replay_generation: number;
  occurred_at: Timestamp;
  created_at: Timestamp;
}

interface AuditTable {
  id: string;
  project_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: string;
  operation_id: string;
  occurred_at: Timestamp;
}

interface ProjectionInstanceTable {
  instance_id: string;
  project_id: string;
  document: Json<unknown>;
  updated_at: Timestamp;
}

interface ProjectionOperationTable {
  operation_id: string;
  project_id: string;
  target_id: string;
  document: Json<unknown>;
  updated_at: Timestamp;
  /*
   * Administrative recovery metadata. These live beside the document rather than inside it
   * because `Operation` declares `additionalProperties: false`; the tenant document must stay
   * byte-identical to its published schema while the administrator route composes these on top.
   */
  correlation_id: string | null;
  causation_id: string | null;
  trace_id: string | null;
  retry_count: Generated<number>;
  checkpoint: string | null;
  dead_letter_event_id: string | null;
  /** Restricted-operational; never returned on a tenant route. */
  provider_task_reference: string | null;
}

interface ProjectionReceiptTable {
  event_id: string;
  consumer_name: string;
  replay_generation: number;
  source_topic: string | null;
  source_partition: number | null;
  source_offset: string | null;
  received_at: Timestamp;
}

interface CommandReceiptTable {
  event_id: string;
  consumer_name: string;
  replay_generation: number;
  source_topic: string | null;
  source_partition: number | null;
  source_offset: string | null;
  payload_hash: string;
  received_at: Timestamp;
  completed_at: Timestamp | null;
}

interface InstanceLeaseTable {
  instance_id: string;
  owner_id: string;
  fencing_token: string;
  leased_until: Timestamp;
  updated_at: Timestamp;
}

interface WorkflowTable {
  operation_id: string;
  event_id: string;
  project_id: string;
  instance_id: string;
  /** Which lifecycle capability this workflow executes; the dispatcher routes on it. */
  action: string;
  command: Json<unknown>;
  status: string;
  stage: string;
  attempt: number;
  stage_attempt: number;
  retry_started_at: Timestamp | null;
  replay_generation: number;
  trace_context: Json<{ readonly traceparent: string; readonly tracestate?: string }>;
  fencing_token: string;
  provider_resource_id: string | null;
  provider_task_reference: string | null;
  next_attempt_at: Timestamp;
  failure_category: string | null;
  failure_code: string | null;
  failure_message: string | null;
  last_error_category: string | null;
  last_error_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

interface ReplayRequestTable {
  id: string;
  original_event_id: string;
  actor_id: string;
  idempotency_key: string;
  request_hash: string;
  reason: string;
  correlation_id: string;
  trace_context: Json<{ readonly traceparent: string; readonly tracestate?: string }>;
  status: string;
  requested_at: Timestamp;
  updated_at: Timestamp;
}

interface WorkflowReplayRequestTable {
  replay_request_id: string;
  request_event_id: string;
  original_event_id: string;
  replay_generation: number | null;
  status: string;
  request_payload: Json<unknown>;
  authorized_command_hash: string | null;
  authorized_outbox_id: string | null;
  requested_at: Timestamp;
  decided_at: Timestamp;
  completed_at: Timestamp | null;
}

interface DeadLetterTable {
  original_event_id: string;
  dead_letter_event_id: string;
  original_schema_name: string;
  original_schema_version: number;
  aggregate_id: string;
  project_id: string;
  operation_id: string;
  original_payload: Json<unknown>;
  failure_category: string;
  failure_code: string;
  safe_message: string | null;
  attempts: number;
  replay_allowed: boolean;
  replay_generation: number;
  status: string;
  dead_lettered_at: Timestamp;
  last_replay_at: Timestamp | null;
}

interface PoisonRecordTable {
  id: string;
  consumer_name: string;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  payload_hash: string;
  failure_code: string;
  safe_message: string;
  quarantined_at: Timestamp;
}

interface ProjectionDeadLetterTable {
  original_event_id: string;
  project_id: string;
  operation_id: string;
  aggregate_id: string;
  document: Json<unknown>;
  trace_context: Json<{ readonly traceparent: string; readonly tracestate?: string }> | null;
  updated_at: Timestamp;
}

/**
 * Every table Kysely may query, keyed by its qualified name.
 *
 * Adding a table to a migration without adding it here means it simply cannot be queried —
 * the type system rejects the table name.
 */
export interface PostgresDatabase {
  'control.projects': ProjectTable;
  'control.quotas': QuotaTable;
  'control.networks': NetworkTable;
  'control.provider_profiles': ProviderProfileTable;
  'control.images': ImageTable;
  'control.flavors': FlavorTable;
  'control.instances': InstanceTable;
  'control.operations': OperationTable;
  'control.ipv4_leases': Ipv4LeaseTable;
  'control.idempotency_records': IdempotencyTable;
  'control.outbox': OutboxTable;
  'control.replay_requests': ReplayRequestTable;
  'audit.entries': AuditTable;
  'workflow.command_receipts': CommandReceiptTable;
  'workflow.instance_leases': InstanceLeaseTable;
  'workflow.workflows': WorkflowTable;
  'workflow.outbox': OutboxTable;
  'workflow.dead_letters': DeadLetterTable;
  'workflow.replay_requests': WorkflowReplayRequestTable;
  'workflow.poison_records': PoisonRecordTable;
  'projection.instances': ProjectionInstanceTable;
  'control.snapshots': SnapshotTable;
  'control.manual_reviews': ManualReviewTable;
  'control.retention_policy': RetentionPolicyTable;
  'projection.operations': ProjectionOperationTable;
  'projection.snapshots': ProjectionSnapshotTable;
  'projection.event_receipts': ProjectionReceiptTable;
  'projection.dead_letters': ProjectionDeadLetterTable;
  'projection.poison_records': PoisonRecordTable;
}

/**
 * Creates a pooled Kysely client.
 *
 * The pool is sized for the Phase 3 services, each of which runs one request-handling path
 * plus at most one background poller. `connectionTimeoutMillis` is deliberately short so a
 * database outage surfaces as a fast, retryable failure rather than a hung request holding a
 * workflow lease open.
 *
 * Callers own the returned client's lifecycle and must `destroy()` it on shutdown — see the
 * lifecycle providers in each service's `app.module.ts`.
 */
export function createPostgresDatabase(connectionString: string): Kysely<PostgresDatabase> {
  return new Kysely<PostgresDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    }),
  });
}

/** A connected, schema-typed Kysely client. */
export type PostgresClient = Kysely<PostgresDatabase>;

/** Longest a readiness probe will wait for the database before reporting the pod not ready. */
const READINESS_PROBE_TIMEOUT_MS = 2_000;

/**
 * Answers whether the database is reachable, for a Kubernetes readiness probe.
 *
 * Bounded by its own timeout rather than the pool's 5-second connection timeout. WHY: a readiness
 * probe that outlives its own probe interval stacks up in the kubelet and turns a slow database
 * into an apparently hung pod, which is a different and much harder incident than a database
 * being slow.
 *
 * The query is `SELECT 1` on purpose. Anything that touches a real table would make readiness
 * depend on migration state, and a pod that reports itself unready because a migration has not run
 * yet cannot be the pod that tells an operator why.
 *
 * @param {PostgresClient} database Connected client to probe.
 * @param {number} [timeoutMs] Deadline; defaults to {@link READINESS_PROBE_TIMEOUT_MS}.
 * @returns {Promise<boolean>} `true` when the database answered inside the deadline.
 */
export async function isDatabaseReachable(
  database: PostgresClient,
  timeoutMs: number = READINESS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), timeoutMs);
  });
  try {
    return await Promise.race([sql`SELECT 1`.execute(database).then(() => true), deadline]).catch(
      () => false,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
