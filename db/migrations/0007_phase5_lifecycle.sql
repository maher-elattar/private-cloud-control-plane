-- Phase 5: schema for the nine lifecycle capabilities.
--
-- The unblocking change is the first one. Everything else in Phase 5 waits on it.

-- ---------------------------------------------------------------------------
-- 1. One instance may have many workflows over its lifetime.
-- ---------------------------------------------------------------------------
--
-- `instance_id` was UNIQUE, which meant one workflow per instance forever. That was correct while
-- create was the only capability: an instance was created exactly once. It is wrong the moment an
-- instance can also be started, resized, and snapshotted, because each of those is a separate
-- leased, fenced workflow against the same aggregate.
--
-- The single-writer guarantee does not come from this constraint and never did. It comes from
-- `workflow.instance_leases`, which is keyed by `instance_id` and hands one instance to one worker
-- at a time regardless of how many workflow rows exist. Dropping this constraint therefore removes
-- a limitation, not a safety property.
ALTER TABLE workflow.workflows
  DROP CONSTRAINT workflows_instance_id_key;

-- The lease join and per-instance history reads still need the column indexed; the dropped unique
-- constraint had been providing that index incidentally.
CREATE INDEX workflows_instance ON workflow.workflows (instance_id, created_at DESC);

-- The command kind was previously discoverable only as `command->>'schemaName'`, which cannot be
-- indexed usefully and cannot be constrained. The dispatcher selects on it, so it becomes a column.
ALTER TABLE workflow.workflows
  ADD COLUMN action text NOT NULL DEFAULT 'create_instance';

-- Every existing row predates Phase 5 and is by definition a create.
UPDATE workflow.workflows SET action = 'create_instance';

-- The default existed only to make the column addition safe against existing rows. Requiring it
-- explicitly from here on means a new capability cannot silently inherit create's identity.
ALTER TABLE workflow.workflows
  ALTER COLUMN action DROP DEFAULT,
  ADD CONSTRAINT workflows_action_check CHECK (
    action IN (
      'create_instance',
      'power_instance',
      'resize_instance',
      'create_snapshot',
      'rollback_snapshot',
      'delete_snapshot',
      'retain_instance',
      'purge_instance',
      'reconcile_instance'
    )
  );

CREATE INDEX workflows_action_ready ON workflow.workflows (action, status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- 2. Operation target types become enforceable.
-- ---------------------------------------------------------------------------
-- The contract has always declared six values; nothing enforced them, so a typo in a new
-- capability would have produced an operation the API could not serialise.
ALTER TABLE control.operations
  ADD CONSTRAINT operations_target_type_check CHECK (
    target_type IN (
      'instance',
      'snapshot',
      'provider_profile',
      'retention_policy',
      'dead_letter',
      'manual_review'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Instance state the API document already publishes.
-- ---------------------------------------------------------------------------
-- `Instance` carries observed state, drift, retention, and purge eligibility, but those lived only
-- inside `projection.instances.document` jsonb. Reconciliation and purge need to query them, and a
-- jsonb document is the wrong place to enforce a guard that decides whether a VM may be destroyed.
ALTER TABLE control.instances
  -- The operation that created this instance, and therefore the `createOperationId` written into
  -- its provider ownership markers. Every later capability must present the *create* operation's
  -- id, not its own, or the provider correctly refuses to touch a resource it cannot match.
  ADD COLUMN create_operation_id uuid,
  ADD COLUMN retention_deadline timestamptz,
  ADD COLUMN purge_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN drift text NOT NULL DEFAULT 'none' CHECK (
    drift IN (
      'none',
      'missing_resource',
      'identity_mismatch',
      'stale_task',
      'late_success',
      'power_drift',
      'network_drift',
      'ambiguous'
    )
  ),
  ADD COLUMN last_reconciled_at timestamptz,
  ADD COLUMN observed_exists boolean,
  ADD COLUMN observed_power_state text CHECK (
    observed_power_state IN ('running', 'stopped', 'suspended', 'unknown')
  ),
  ADD COLUMN observed_cpu_count integer CHECK (observed_cpu_count >= 0),
  ADD COLUMN observed_memory_mib bigint CHECK (observed_memory_mib >= 0),
  ADD COLUMN observed_disk_gib bigint CHECK (observed_disk_gib >= 0),
  ADD COLUMN observed_marker_match boolean,
  ADD COLUMN observed_at timestamptz;

-- Reconciliation sweeps by staleness, and purge sweeps by expiry; both are range scans.
CREATE INDEX instances_reconciliation ON control.instances (last_reconciled_at NULLS FIRST);
CREATE INDEX instances_retention ON control.instances (retention_deadline)
  WHERE retention_deadline IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE control.snapshots (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES control.projects(id),
  instance_id uuid NOT NULL REFERENCES control.instances(id),
  name text NOT NULL,
  description text,
  state text NOT NULL CHECK (state IN ('creating', 'available', 'rolling_back', 'deleting', 'failed')),
  -- Provider-side identity, kept so an interrupted delete can be resumed against the right object.
  provider_snapshot_name text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Proxmox rejects a duplicate snapshot name on one VM, so the database must too rather than
  -- discovering the conflict after a provider call.
  UNIQUE (instance_id, name)
);
CREATE INDEX snapshots_instance ON control.snapshots (instance_id, created_at DESC);

CREATE TABLE projection.snapshots (
  snapshot_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX projection_snapshots_instance_page
  ON projection.snapshots (instance_id, updated_at DESC, snapshot_id DESC);

-- ---------------------------------------------------------------------------
-- 5. Manual review.
-- ---------------------------------------------------------------------------
-- The safety invariants route every ambiguous outcome here rather than to an automatic
-- compensation. Until now there was nowhere for those to land and no way for an operator to
-- resolve one, so `manual_review` was a terminal state with no queue behind it.
CREATE TABLE control.manual_reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES control.projects(id),
  instance_id uuid NOT NULL REFERENCES control.instances(id),
  operation_id uuid NOT NULL REFERENCES control.operations(id),
  category text NOT NULL CHECK (
    category IN (
      'unknown_outcome',
      'identity_mismatch',
      'ambiguous_drift',
      'purge_guard',
      'compensation_failure'
    )
  ),
  summary text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  evidence_reference text,
  resolution text,
  resolved_by text,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  -- One operation raises at most one review; a redelivery must not open a second.
  UNIQUE (operation_id)
);
CREATE INDEX manual_reviews_open ON control.manual_reviews (state, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Retention policy.
-- ---------------------------------------------------------------------------
-- Single-row configuration. The CHECK on `id` is what keeps it single-row: a second insert has
-- nowhere to go, so no code path can create a competing policy.
CREATE TABLE control.retention_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  retention_hours integer NOT NULL CHECK (retention_hours BETWEEN 1 AND 8760),
  lease_release_mode text NOT NULL CHECK (
    lease_release_mode IN ('quarantine_until_purge', 'release_on_retain')
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL
);

-- A default so retention behaviour is defined before an administrator ever sets it. Quarantining
-- the address until purge is the conservative half of the choice: it cannot hand a retained
-- instance's address to a new one while the old VM still exists.
INSERT INTO control.retention_policy (
  id, retention_hours, lease_release_mode, version, updated_at, updated_by
)
VALUES (true, 168, 'quarantine_until_purge', 1, now(), 'system:default')
ON CONFLICT (id) DO NOTHING;

-- Backfill from the operation journal for instances created before this column existed.
UPDATE control.instances instance
SET create_operation_id = (
  SELECT operation.id
  FROM control.operations operation
  WHERE operation.target_id = instance.id
    AND operation.target_type = 'instance'
    AND operation.action = 'create_instance'
  ORDER BY operation.accepted_at
  LIMIT 1
)
WHERE instance.create_operation_id IS NULL;
