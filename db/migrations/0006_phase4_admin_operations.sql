-- Phase 4, checkpoint 9B: the administrative read surface.
--
-- Two problems this closes.
--
-- First, `GET /v1/admin/operations/{operationId}` returns `AdministrativeOperation`, which is
-- `Operation` plus correlation, causation, trace, retry, checkpoint, dead-letter, and
-- provider-task fields. `Operation` declares `additionalProperties: false`, so the projected
-- document cannot carry them. They arrive on workflow events the projection already consumes;
-- they simply had nowhere to land. Storing them beside the document keeps the tenant-facing
-- document byte-identical to its published schema while giving administrators the recovery
-- metadata, and it does so without the control API reading workflow-owned tables.
--
-- Second, every paginated read ordered by `updated_at DESC` with no supporting index, which is a
-- sequential scan plus a sort on every page. Keyset pagination makes that worse, not better,
-- without a matching composite index: the seek predicate can only be satisfied by an index whose
-- column order and direction match the ORDER BY exactly.

ALTER TABLE projection.operations
  ADD COLUMN correlation_id uuid,
  ADD COLUMN causation_id uuid,
  -- Lowercase hex, matching the W3C trace-id form the API publishes.
  ADD COLUMN trace_id char(32),
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN checkpoint text,
  ADD COLUMN dead_letter_event_id uuid,
  -- Restricted-operational. Returned only on the administrator route, never to a tenant.
  ADD COLUMN provider_task_reference text;

-- Keyset pagination indexes. Each one matches an ORDER BY exactly, including direction, so the
-- seek predicate becomes an index range scan instead of a filter over a sorted result.
CREATE INDEX projection_operations_project_page
  ON projection.operations (project_id, updated_at DESC, operation_id DESC);

CREATE INDEX projection_instances_project_page
  ON projection.instances (project_id, updated_at DESC, instance_id DESC);

CREATE INDEX projection_dead_letters_page
  ON projection.dead_letters (updated_at DESC, original_event_id DESC);

CREATE INDEX audit_entries_page
  ON audit.entries (occurred_at DESC, id DESC);

-- The audit read narrows by project or operation before ordering, so each filter needs its own
-- leading column; a single composite index cannot serve both narrowings.
CREATE INDEX audit_entries_project_page
  ON audit.entries (project_id, occurred_at DESC, id DESC);

CREATE INDEX audit_entries_operation_page
  ON audit.entries (operation_id, occurred_at DESC, id DESC);
