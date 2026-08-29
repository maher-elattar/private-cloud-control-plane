CREATE TABLE projection.poison_records (
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

-- Governed replay creates a logical generation receipt without a second physical Kafka record.
-- Keep broker-coordinate uniqueness for real deliveries while permitting coordinate-free receipts.
ALTER TABLE workflow.command_receipts
  DROP CONSTRAINT command_receipts_source_record_unique;
CREATE UNIQUE INDEX command_receipts_source_record_unique
  ON workflow.command_receipts (consumer_name, source_topic, source_partition, source_offset)
  WHERE source_topic IS NOT NULL AND source_partition IS NOT NULL AND source_offset IS NOT NULL;
