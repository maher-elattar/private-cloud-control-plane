-- Terraform-backed provisioning: the run record and the state inventory.
--
-- Two things live here, and the distinction between them is the point.
--
-- `terraform_remote_state` is created but never written by this system. It is the schema the
-- Terraform `pg` backend manages itself, and the control plane's only relationship with it is to
-- read metadata for the inventory. Creating it here rather than letting the backend create it is
-- what allows the grants below to exist before the first apply.
--
-- `terraform.workspaces` and `terraform.runs` are ours. They record what the control plane
-- believes about each workspace and every invocation it made, so that an operator can answer
-- "what has this system provisioned, and does it still match reality" without shelling out to
-- Terraform.
--
-- @see terraform-provisioning-plan.md
-- @see terraform-provisioning-checkpoints.md

-- ---------------------------------------------------------------------------
-- 1. The backend's own schema, and the roles that bound it
-- ---------------------------------------------------------------------------
--
-- **Terraform state is credential material.** `states.data` holds every attribute of every
-- resource, which for this module includes the cloud-init password and any SSH key material. It
-- is a secret store that happens to be JSON, and it is treated as one: the runner writes it, the
-- application reads only enough to report inventory, and nothing else touches it at all.
--
-- WHY roles rather than trusting the application not to write: the inventory API is a read path
-- that will be extended by people who did not write this comment. A grant is a boundary; an
-- intention is not.

CREATE SCHEMA IF NOT EXISTS terraform_remote_state;

-- Idempotent role creation. `CREATE ROLE` has no `IF NOT EXISTS`, and a migration that fails on a
-- second application is a migration that cannot be re-run after a partial failure.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terraform_runner') THEN
    CREATE ROLE terraform_runner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_application') THEN
    CREATE ROLE control_plane_application NOLOGIN;
  END IF;
END
$$;

-- The runner owns the backend schema: the `pg` backend creates its own `states` table on first
-- use, and it must be able to.
GRANT USAGE, CREATE ON SCHEMA terraform_remote_state TO terraform_runner;

-- The application may look into the schema but holds no table privileges at all yet, because the
-- table does not exist. Default privileges cover the table the backend creates later.
GRANT USAGE ON SCHEMA terraform_remote_state TO control_plane_application;

-- WHY default privileges rather than a grant on `states`: the backend creates that table on its
-- first apply, which happens long after this migration. A grant now would fail; a default
-- privilege applies to whatever the runner creates afterwards.
ALTER DEFAULT PRIVILEGES FOR ROLE terraform_runner IN SCHEMA terraform_remote_state
  GRANT SELECT ON TABLES TO control_plane_application;

-- ---------------------------------------------------------------------------
-- 2. `terraform.runs` — one row per Terraform invocation
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS terraform;

CREATE TABLE terraform.runs (
  -- The identifier handed back to the workflow as its `providerTaskReference`. SAFE-014 requires
  -- this row to exist before the process starts, so that a worker restart resumes the run rather
  -- than submitting a second one.
  run_id uuid PRIMARY KEY,

  instance_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  workspace_name text NOT NULL,

  command text NOT NULL,
  CONSTRAINT runs_command CHECK (command IN ('init', 'plan', 'apply', 'refresh', 'destroy')),

  -- Copied from the workflow lease. A runner whose token is stale must not be able to record an
  -- outcome for a workflow that has since been claimed by someone else.
  fencing_token bigint NOT NULL,

  -- Kubernetes Job name, or a local process identifier. What `getTask` polls.
  executor_reference text,

  status text NOT NULL,
  CONSTRAINT runs_status CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),

  -- The plan gate's decision, and the rule that refused when it refused.
  --
  -- `refused_destructive` is not an error state: it is the designed abort. Nothing was applied,
  -- and the workflow goes to `manual_review` rather than retrying into the same refusal.
  gate_decision text,
  CONSTRAINT runs_gate_decision CHECK (gate_decision IN ('allowed', 'refused_destructive')),
  gate_rule text,

  -- Action counts from the plan, never the plan itself. The plan document contains resource
  -- attribute values, which is the same secret material as state.
  plan_actions jsonb,
  CONSTRAINT runs_plan_actions CHECK (plan_actions IS NULL OR jsonb_typeof(plan_actions) = 'object'),

  exit_code integer,

  -- Redacted `-json` diagnostics only. WHY a column and not a log line: a failed apply's
  -- diagnostics are the operator's only account of what the provider refused, and a log that
  -- rotates loses it. Redaction happens before the write, not on read.
  diagnostics jsonb,
  CONSTRAINT runs_diagnostics CHECK (diagnostics IS NULL OR jsonb_typeof(diagnostics) = 'array'),

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,

  -- **Both timestamps must come from the database clock.** `started_at` defaults to `now()`, so
  -- a `finished_at` computed in the application is being compared against a different clock, and
  -- any skew rejects a legitimately finished run. Writers set `finished_at = now()`.
  CONSTRAINT runs_finished_after_started CHECK (finished_at IS NULL OR finished_at >= started_at),
  -- A terminal run has an outcome; a running one does not yet.
  CONSTRAINT runs_terminal_has_finished CHECK (
    (status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL)
  )
);

-- `getTask` polls by run id, which the primary key covers. These two serve the inventory: the most
-- recent run for a workspace, and every run for an operation.
CREATE INDEX runs_workspace ON terraform.runs (workspace_name, started_at DESC);
CREATE INDEX runs_operation ON terraform.runs (operation_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 3. `terraform.workspaces` — one row per instance, the inventory spine
-- ---------------------------------------------------------------------------

CREATE TABLE terraform.workspaces (
  instance_id uuid PRIMARY KEY REFERENCES control.instances (id),

  -- One workspace per instance. This is what makes Terraform's concurrency model compatible with
  -- the control plane's: the `pg` backend locks state with a Postgres advisory lock keyed on the
  -- state row, so with one workspace per instance that lock covers exactly one instance — the
  -- same granularity as the SAFE-010 per-instance lease. A shared state would serialise every
  -- instance mutation in the fleet behind one lock.
  workspace_name text NOT NULL UNIQUE,

  module_version text,
  provider_version text,

  -- Read back from the state document after each apply. A serial that moved without a run of ours
  -- means someone else wrote this workspace.
  state_serial bigint,
  state_lineage text,

  last_run_id uuid REFERENCES terraform.runs (run_id),
  last_applied_at timestamptz,
  last_refreshed_at timestamptz,

  drift_state text NOT NULL DEFAULT 'unknown',
  CONSTRAINT workspaces_drift_state CHECK (
    drift_state IN ('unknown', 'in_sync', 'drifted', 'absent')
  ),

  -- Resource addresses and changed attribute *names*. Never values.
  --
  -- WHY the distinction is enforced by convention here and asserted in tests rather than by a
  -- constraint: Postgres cannot tell an attribute name from an attribute value. What it can do is
  -- refuse anything that is not an object, which at least keeps the shape predictable.
  drift_summary jsonb,
  CONSTRAINT workspaces_drift_summary CHECK (
    drift_summary IS NULL OR jsonb_typeof(drift_summary) = 'object'
  ),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The reconciler sweeps by drift state, oldest observation first.
CREATE INDEX workspaces_drift ON terraform.workspaces (drift_state, last_refreshed_at NULLS FIRST);

-- ---------------------------------------------------------------------------
-- 4. Grants on our own tables
-- ---------------------------------------------------------------------------
--
-- The application reads and writes the inventory; it is control-plane data. The asymmetry that
-- matters is above: state is the runner's, and the application can only read it.

GRANT USAGE ON SCHEMA terraform TO control_plane_application, terraform_runner;
GRANT SELECT, INSERT, UPDATE ON terraform.runs TO control_plane_application, terraform_runner;
GRANT SELECT, INSERT, UPDATE ON terraform.workspaces TO control_plane_application, terraform_runner;

-- Deliberately no DELETE anywhere in this schema. A run record is evidence, and a workspace row
-- outliving its instance is a finding rather than garbage — it means state exists for something
-- the control plane believes is gone, which is exactly what an operator needs to see.
