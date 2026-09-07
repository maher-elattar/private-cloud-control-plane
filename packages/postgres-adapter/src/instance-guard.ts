/**
 * The per-instance concurrency guard shared by every mutating lifecycle capability.
 *
 * PATTERN — pessimistic row lock plus a state precondition, inside the acceptance transaction.
 * SAFE-010 requires that at most one mutating workflow holds an instance at a time. The workflow
 * *lease* enforces that during execution, but a lease only exists once a command has been
 * consumed from Kafka. Between acceptance and consumption there is a window where a second
 * request could be accepted for the same instance, and both would then be durable intent. This
 * guard closes that window at the point of acceptance.
 *
 * @see docs/architecture/safety-invariants.md
 */
import { DomainError } from '@private-cloud/domain';
import type { Transaction } from 'kysely';
import type { PostgresDatabase } from './database.js';

/** Open transaction handle, matching the private alias used by the stores. */
type Tx = Transaction<PostgresDatabase>;

/**
 * Lifecycle states from which a tenant may request a further mutation.
 *
 * Everything else is either mid-workflow (`provisioning`, `updating`, `purge_pending`), terminal
 * (`purged`), or explicitly not safe to act on automatically (`manual_review`, `unknown_outcome`).
 * `retained` is excluded because a soft-deleted instance has had tenant access detached; the only
 * legitimate next step is an administrative purge, which takes its own path.
 */
const MUTABLE_LIFECYCLE_STATES: readonly string[] = ['active', 'failed'];

/** The instance row a mutating capability has locked for the rest of its transaction. */
export interface GuardedInstance {
  readonly id: string;
  readonly projectId: string;
  readonly lifecycleState: string;
  readonly providerProfileId: string;
  readonly flavorId: string;
  readonly desiredCpuCount: number;
  readonly desiredMemoryMib: number;
  readonly desiredDiskGib: number;
  readonly retentionDeadline: Date | null;
  /** The operation whose id is in this instance's provider ownership markers. */
  readonly createOperationId: string | null;
}

/**
 * Locks one instance and asserts it can accept a new mutation.
 *
 * `FOR UPDATE` is what makes the check meaningful: without it two concurrent requests both read
 * `active_operation_id IS NULL`, both pass, and both commit an operation. The lock makes the
 * loser wait until the winner has committed its `active_operation_id`, at which point it sees the
 * instance is busy.
 *
 * @param tx The acceptance transaction. The lock is held until it commits or rolls back.
 * @param projectId Project the caller is authorized for; an instance in another project is
 *   reported as missing rather than forbidden, so the guard does not confirm its existence.
 * @param instanceId Target instance.
 * @returns The locked instance row.
 * @throws DomainError `INSTANCE_NOT_FOUND` when no such instance exists in this project,
 *   or `INSTANCE_BUSY` when an operation is already in flight or the lifecycle state does not
 *   permit a further mutation.
 */
export async function lockInstanceForMutation(
  tx: Tx,
  projectId: string,
  instanceId: string,
): Promise<GuardedInstance> {
  const row = await tx
    .selectFrom('control.instances')
    .select([
      'id',
      'project_id',
      'lifecycle_state',
      'active_operation_id',
      'provider_profile_id',
      'flavor_id',
      'desired_cpu_count',
      'desired_memory_mib',
      'desired_disk_gib',
      'retention_deadline',
      'create_operation_id',
    ])
    .where('id', '=', instanceId)
    .where('project_id', '=', projectId)
    .forUpdate()
    .executeTakeFirst();

  if (!row) {
    throw new DomainError('INSTANCE_NOT_FOUND', 'The requested instance does not exist.');
  }
  if (row.active_operation_id !== null) {
    throw new DomainError(
      'INSTANCE_BUSY',
      'Another operation is already in progress for this instance.',
    );
  }
  if (!MUTABLE_LIFECYCLE_STATES.includes(row.lifecycle_state)) {
    // Deliberately the same code and message as an in-flight operation. Both mean "not now", and
    // distinguishing them would tell a tenant more about internal state than they need.
    throw new DomainError(
      'INSTANCE_BUSY',
      'The instance is not in a state that accepts this operation.',
    );
  }

  return {
    id: row.id,
    projectId: row.project_id,
    lifecycleState: row.lifecycle_state,
    providerProfileId: row.provider_profile_id,
    flavorId: row.flavor_id,
    desiredCpuCount: row.desired_cpu_count,
    desiredMemoryMib: Number(row.desired_memory_mib),
    desiredDiskGib: Number(row.desired_disk_gib),
    retentionDeadline: row.retention_deadline ? new Date(row.retention_deadline) : null,
    createOperationId: row.create_operation_id,
  };
}
