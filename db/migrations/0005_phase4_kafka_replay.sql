CREATE TABLE workflow.replay_requests (
  replay_request_id uuid PRIMARY KEY,
  request_event_id uuid NOT NULL UNIQUE,
  original_event_id uuid NOT NULL,
  replay_generation integer CHECK (replay_generation > 0),
  status text NOT NULL CHECK (status IN ('authorized', 'completed', 'rejected')),
  request_payload jsonb NOT NULL,
  authorized_command_hash char(64),
  authorized_outbox_id uuid,
  requested_at timestamptz NOT NULL,
  decided_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (
    (
      status = 'rejected'
      AND replay_generation IS NULL
      AND authorized_command_hash IS NULL
      AND authorized_outbox_id IS NULL
      AND completed_at IS NOT NULL
    )
    OR
    (
      status = 'authorized'
      AND replay_generation IS NOT NULL
      AND authorized_command_hash IS NOT NULL
      AND authorized_outbox_id IS NOT NULL
      AND completed_at IS NULL
    )
    OR
    (
      status = 'completed'
      AND replay_generation IS NOT NULL
      AND authorized_command_hash IS NOT NULL
      AND authorized_outbox_id IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX workflow_replay_generation_authority
  ON workflow.replay_requests (original_event_id, replay_generation)
  WHERE replay_generation IS NOT NULL;
CREATE INDEX workflow_replay_request_status
  ON workflow.replay_requests (status, decided_at);

-- Earlier Phase 4 builds recorded an in-process replay as a coordinate-free inbox receipt. A
-- command receipt now proves a physical Kafka delivery, so remove those historical placeholders
-- before enforcing the invariant for every subsequent generation.
DELETE FROM workflow.command_receipts
WHERE source_topic IS NULL OR source_partition IS NULL OR source_offset IS NULL;

ALTER TABLE workflow.command_receipts
  ALTER COLUMN source_topic SET NOT NULL,
  ALTER COLUMN source_partition SET NOT NULL,
  ALTER COLUMN source_offset SET NOT NULL;
