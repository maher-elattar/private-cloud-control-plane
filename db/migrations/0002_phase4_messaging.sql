CREATE TABLE control.outbox_phase4 (
  outbox_id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  schema_name text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  topic text NOT NULL CHECK (topic IN (
    'provisioning.commands.v1',
    'provisioning.events.v1',
    'provisioning.dlq.v1',
    'reconciliation.events.v1',
    'audit.events.v1'
  )),
  partition_key text NOT NULL,
  payload jsonb NOT NULL,
  tracingspancontext text NOT NULL,
  replay_generation integer NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (event_id, replay_generation)
);

INSERT INTO control.outbox_phase4 (
  outbox_id, event_id, aggregate_id, aggregate_type, schema_name, schema_version, topic,
  partition_key, payload, tracingspancontext, replay_generation, occurred_at, created_at
)
SELECT
  event_id, event_id, aggregate_id, aggregate_type, schema_name, schema_version,
  'provisioning.commands.v1', partition_key, payload,
  'traceparent=' || (payload #>> '{traceContext,traceparent}') || E'\n' ||
    CASE
      WHEN payload #>> '{traceContext,tracestate}' IS NULL THEN ''
      ELSE 'tracestate=' || (payload #>> '{traceContext,tracestate}') || E'\n'
    END,
  0, occurred_at, occurred_at
FROM control.outbox;

DROP TABLE control.outbox;
ALTER TABLE control.outbox_phase4 RENAME TO outbox;
CREATE INDEX control_outbox_order ON control.outbox (created_at, outbox_id);
CREATE INDEX control_outbox_logical_identity ON control.outbox (event_id, replay_generation);

CREATE TABLE workflow.outbox_phase4 (LIKE control.outbox INCLUDING ALL);

INSERT INTO workflow.outbox_phase4 (
  outbox_id, event_id, aggregate_id, aggregate_type, schema_name, schema_version, topic,
  partition_key, payload, tracingspancontext, replay_generation, occurred_at, created_at
)
SELECT
  event_id, event_id, aggregate_id, 'instance', schema_name, 1, 'provisioning.events.v1',
  aggregate_id::text, payload,
  'traceparent=' || (payload #>> '{traceContext,traceparent}') || E'\n' ||
    CASE
      WHEN payload #>> '{traceContext,tracestate}' IS NULL THEN ''
      ELSE 'tracestate=' || (payload #>> '{traceContext,tracestate}') || E'\n'
    END,
  0, occurred_at, occurred_at
FROM workflow.outbox;

DROP TABLE workflow.outbox;
ALTER TABLE workflow.outbox_phase4 RENAME TO outbox;
ALTER INDEX workflow.outbox_phase4_pkey RENAME TO outbox_pkey;
ALTER TABLE workflow.outbox RENAME CONSTRAINT outbox_phase4_event_id_replay_generation_key
  TO outbox_event_id_replay_generation_key;
CREATE INDEX workflow_outbox_order ON workflow.outbox (created_at, outbox_id);
CREATE INDEX workflow_outbox_logical_identity ON workflow.outbox (event_id, replay_generation);

ALTER TABLE workflow.command_receipts DROP CONSTRAINT command_receipts_pkey;
ALTER TABLE workflow.command_receipts
  ADD COLUMN replay_generation integer NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  ADD COLUMN source_topic text,
  ADD COLUMN source_partition integer CHECK (source_partition >= 0),
  ADD COLUMN source_offset bigint CHECK (source_offset >= 0),
  ADD CONSTRAINT command_receipts_pkey
    PRIMARY KEY (consumer_name, event_id, replay_generation),
  ADD CONSTRAINT command_receipts_source_record_unique
    UNIQUE NULLS NOT DISTINCT (consumer_name, source_topic, source_partition, source_offset);

ALTER TABLE projection.event_receipts DROP CONSTRAINT event_receipts_pkey;
ALTER TABLE projection.event_receipts
  ADD COLUMN replay_generation integer NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  ADD COLUMN source_topic text,
  ADD COLUMN source_partition integer CHECK (source_partition >= 0),
  ADD COLUMN source_offset bigint CHECK (source_offset >= 0),
  ADD CONSTRAINT event_receipts_pkey
    PRIMARY KEY (consumer_name, event_id, replay_generation),
  ADD CONSTRAINT event_receipts_source_record_unique
    UNIQUE NULLS NOT DISTINCT (consumer_name, source_topic, source_partition, source_offset);

ALTER TABLE workflow.workflows
  ADD COLUMN replay_generation integer NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  ADD COLUMN stage_attempt integer NOT NULL DEFAULT 0 CHECK (stage_attempt >= 0),
  ADD COLUMN retry_started_at timestamptz,
  ADD COLUMN trace_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_error_category text,
  ADD COLUMN last_error_code text;

UPDATE workflow.workflows
SET trace_context = command->'traceContext'
WHERE command ? 'traceContext';

CREATE TABLE control.replay_requests (
  id uuid PRIMARY KEY,
  original_event_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 512),
  correlation_id uuid NOT NULL,
  trace_context jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'published', 'completed')),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (actor_id, idempotency_key)
);

CREATE TABLE workflow.dead_letters (
  original_event_id uuid PRIMARY KEY,
  dead_letter_event_id uuid NOT NULL UNIQUE,
  original_schema_name text NOT NULL,
  original_schema_version integer NOT NULL,
  aggregate_id uuid NOT NULL,
  project_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  original_payload jsonb NOT NULL,
  failure_category text NOT NULL,
  failure_code text NOT NULL,
  safe_message text,
  attempts integer NOT NULL CHECK (attempts > 0),
  replay_allowed boolean NOT NULL,
  replay_generation integer NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  status text NOT NULL CHECK (status IN ('open', 'replay_requested', 'replayed', 'closed')),
  dead_lettered_at timestamptz NOT NULL,
  last_replay_at timestamptz
);

CREATE TABLE workflow.poison_records (
  id uuid PRIMARY KEY,
  consumer_name text NOT NULL,
  source_topic text NOT NULL,
  source_partition integer NOT NULL CHECK (source_partition >= 0),
  source_offset bigint NOT NULL CHECK (source_offset >= 0),
  payload_hash char(64) NOT NULL,
  failure_code text NOT NULL,
  safe_message text NOT NULL,
  quarantined_at timestamptz NOT NULL,
  UNIQUE (consumer_name, source_topic, source_partition, source_offset)
);

CREATE TABLE projection.dead_letters (
  original_event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX workflow_dead_letters_status
  ON workflow.dead_letters (status, dead_lettered_at DESC);
CREATE INDEX projection_dead_letters_project
  ON projection.dead_letters (project_id, updated_at DESC);
