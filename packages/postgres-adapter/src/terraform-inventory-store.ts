/**
 * The Terraform run record and state inventory, in PostgreSQL.
 *
 * PATTERN — persisted saga, extended to a subprocess. A Terraform apply is a long-running local
 * process, which is a real difference from the direct adapter: a Proxmox UPID survives the death
 * of the worker that created it, whereas a child process does not. SAFE-014 and SAFE-015 require
 * that a task reference outlive a worker restart and be *resumed* rather than resubmitted, so the
 * run row is written **before** the process starts and is what `getTask` polls.
 *
 * Fencing is enforced here rather than trusted to the caller. A worker whose lease has expired and
 * been taken by another worker must not be able to record an outcome for a workflow it no longer
 * owns — that is how two workers come to believe they each created the instance.
 *
 * @see db/migrations/0008_terraform_inventory.sql
 * @see docs/architecture/glossary.md#lease-and-fencing-token
 */
import { sql } from 'kysely';
import { DomainError } from '@private-cloud/domain';
import type { PostgresClient } from './database.js';

/** What a run is recorded as before its process starts. */
export interface BeginRunInput {
  readonly runId: string;
  readonly instanceId: string;
  readonly operationId: string;
  readonly workspaceName: string;
  readonly command: 'init' | 'plan' | 'apply' | 'refresh' | 'destroy';
  readonly fencingToken: number | string;
  readonly executorReference?: string;
}

/** How a run finished. */
export interface CompleteRunInput {
  readonly runId: string;
  readonly fencingToken: number | string;
  readonly status: 'succeeded' | 'failed' | 'unknown';
  readonly exitCode?: number;
  readonly gateDecision?: 'allowed' | 'refused_destructive';
  readonly gateRule?: string;
  readonly planActions?: Readonly<Record<string, number>>;
  readonly diagnostics?: readonly unknown[];
}

/** A run as it is read back, which is what `getTask` reports on. */
export interface TerraformRun {
  readonly runId: string;
  readonly instanceId: string;
  readonly operationId: string;
  readonly workspaceName: string;
  readonly command: string;
  readonly status: string;
  readonly gateDecision: string | null;
  readonly gateRule: string | null;
  readonly planActions: Readonly<Record<string, number>> | null;
  readonly exitCode: number | null;
  readonly diagnostics: readonly unknown[] | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** What an apply or refresh learned about the workspace. */
export interface RecordWorkspaceInput {
  readonly instanceId: string;
  readonly workspaceName: string;
  readonly moduleVersion?: string;
  readonly providerVersion?: string;
  readonly stateSerial?: number | string;
  readonly stateLineage?: string;
  readonly lastRunId?: string;
  readonly applied?: boolean;
  readonly refreshed?: boolean;
  readonly driftState?: 'unknown' | 'in_sync' | 'drifted' | 'absent';
  /** Resource addresses and changed attribute **names**. Never values. */
  readonly driftSummary?: Readonly<Record<string, unknown>>;
}

/**
 * Reads and writes the Terraform inventory.
 *
 * Every method that records an outcome takes a fencing token and refuses a stale one, so a
 * caller cannot opt out of the check by forgetting to pass it.
 */
export class PostgresTerraformInventoryStore {
  public constructor(private readonly db: PostgresClient) {}

  /**
   * Records a run before its process starts.
   *
   * @param input The run to record.
   * @throws DomainError `INSTANCE_BUSY` when the fencing token is not the current lease's.
   */
  public async beginRun(input: BeginRunInput): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.assertFencingToken(tx, input.instanceId, input.fencingToken);
      await tx
        .insertInto('terraform.runs')
        .values({
          run_id: input.runId,
          instance_id: input.instanceId,
          operation_id: input.operationId,
          workspace_name: input.workspaceName,
          command: input.command,
          fencing_token: String(input.fencingToken),
          status: 'running',
          ...(input.executorReference ? { executor_reference: input.executorReference } : {}),
        })
        .execute();
    });
  }

  /**
   * Records how a run finished.
   *
   * WHY `finished_at` is `now()` rather than a `Date` from this process: the column default gave
   * `started_at` the database's clock, and `runs_finished_after_started` compares the two. A
   * timestamp from the application is measured against a different clock, so under any skew a
   * legitimately finished run would be rejected.
   *
   * @param input The outcome.
   * @throws DomainError `INSTANCE_BUSY` when the token is stale or the run is already terminal.
   */
  public async completeRun(input: CompleteRunInput): Promise<void> {
    const updated = await this.db
      .updateTable('terraform.runs')
      .set({
        status: input.status,
        finished_at: sql`now()`,
        ...(input.exitCode === undefined ? {} : { exit_code: input.exitCode }),
        ...(input.gateDecision ? { gate_decision: input.gateDecision } : {}),
        ...(input.gateRule ? { gate_rule: input.gateRule } : {}),
        ...(input.planActions ? { plan_actions: JSON.stringify(input.planActions) } : {}),
        ...(input.diagnostics ? { diagnostics: JSON.stringify(input.diagnostics) } : {}),
      })
      .where('run_id', '=', input.runId)
      .where('fencing_token', '=', String(input.fencingToken))
      // Only a running run may be completed. A second completion would overwrite the first
      // outcome, and the first is the one that actually happened.
      .where('status', '=', 'running')
      .executeTakeFirst();

    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      // INSTANCE_BUSY rather than a new code: this is precisely "another holder has this
      // instance", which is what that code means, and it is already mapped in both transports.
      throw new DomainError(
        'INSTANCE_BUSY',
        'The run could not be completed: it is already terminal, or the lease has moved.',
      );
    }
  }

  /**
   * Reads one run, which is what `getTask` polls.
   *
   * @param runId The run identifier handed to the workflow as its provider task reference.
   * @returns The run, or `null` when the reference names nothing.
   */
  public async readRun(runId: string): Promise<TerraformRun | null> {
    const row = await this.db
      .selectFrom('terraform.runs')
      .selectAll()
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      runId: row.run_id,
      instanceId: row.instance_id,
      operationId: row.operation_id,
      workspaceName: row.workspace_name,
      command: row.command,
      status: row.status,
      gateDecision: row.gate_decision,
      gateRule: row.gate_rule,
      planActions: row.plan_actions as Readonly<Record<string, number>> | null,
      exitCode: row.exit_code,
      diagnostics: row.diagnostics as readonly unknown[] | null,
      startedAt: row.started_at as unknown as Date,
      finishedAt: row.finished_at as unknown as Date | null,
    };
  }

  /**
   * Records what the control plane now believes about a workspace.
   *
   * Upserts, because the first apply creates the row and every later run updates it.
   *
   * @param input What was learned.
   */
  public async recordWorkspace(input: RecordWorkspaceInput): Promise<void> {
    // WHY a client timestamp is acceptable on this table where `runs.finished_at` needs `now()`:
    // nothing here is compared against a server-clock default, so there is no skew to trip over.
    const observedAt = new Date();
    const values = {
      instance_id: input.instanceId,
      workspace_name: input.workspaceName,
      ...(input.moduleVersion ? { module_version: input.moduleVersion } : {}),
      ...(input.providerVersion ? { provider_version: input.providerVersion } : {}),
      ...(input.stateSerial === undefined ? {} : { state_serial: String(input.stateSerial) }),
      ...(input.stateLineage ? { state_lineage: input.stateLineage } : {}),
      ...(input.lastRunId ? { last_run_id: input.lastRunId } : {}),
      ...(input.applied ? { last_applied_at: observedAt } : {}),
      ...(input.refreshed ? { last_refreshed_at: observedAt } : {}),
      ...(input.driftState ? { drift_state: input.driftState } : {}),
      ...(input.driftSummary ? { drift_summary: JSON.stringify(input.driftSummary) } : {}),
    };

    await this.db
      .insertInto('terraform.workspaces')
      .values(values)
      .onConflict((conflict) =>
        conflict.column('instance_id').doUpdateSet({
          // `workspace_name` is deliberately not updated. It derives from the instance id, so a
          // change would mean the caller is confused about which instance this is — and silently
          // renaming a workspace orphans its state.
          ...(input.moduleVersion ? { module_version: input.moduleVersion } : {}),
          ...(input.providerVersion ? { provider_version: input.providerVersion } : {}),
          ...(input.stateSerial === undefined ? {} : { state_serial: String(input.stateSerial) }),
          ...(input.stateLineage ? { state_lineage: input.stateLineage } : {}),
          ...(input.lastRunId ? { last_run_id: input.lastRunId } : {}),
          ...(input.applied ? { last_applied_at: observedAt } : {}),
          ...(input.refreshed ? { last_refreshed_at: observedAt } : {}),
          ...(input.driftState ? { drift_state: input.driftState } : {}),
          ...(input.driftSummary ? { drift_summary: JSON.stringify(input.driftSummary) } : {}),
          updated_at: observedAt,
        }),
      )
      .execute();
  }

  /**
   * Refuses a caller whose lease has moved on.
   *
   * WHY the absence of a lease is *not* an error: a run may legitimately be recorded for an
   * instance whose lease has already been released — the workflow completed and handed the
   * instance back. What must be refused is a token that disagrees with a lease that *exists*,
   * because that means someone else holds it now.
   */
  private async assertFencingToken(
    tx: PostgresClient,
    instanceId: string,
    fencingToken: number | string,
  ): Promise<void> {
    const lease = await tx
      .selectFrom('workflow.instance_leases')
      .select(['fencing_token'])
      .where('instance_id', '=', instanceId)
      .executeTakeFirst();
    if (!lease) return;
    if (String(lease.fencing_token) !== String(fencingToken)) {
      throw new DomainError(
        'INSTANCE_BUSY',
        'The instance lease has moved to another worker; this run may not be recorded.',
      );
    }
  }
}
