CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS workflow;
CREATE SCHEMA IF NOT EXISTS projection;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE control.projects (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE control.quotas (
  project_id uuid PRIMARY KEY REFERENCES control.projects(id),
  instances integer NOT NULL CHECK (instances >= 0),
  cpu_count integer NOT NULL CHECK (cpu_count >= 0),
  memory_mib bigint NOT NULL CHECK (memory_mib >= 0),
  disk_gib bigint NOT NULL CHECK (disk_gib >= 0),
  ipv4_addresses integer NOT NULL CHECK (ipv4_addresses >= 0),
  snapshots integer NOT NULL CHECK (snapshots >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE control.networks (
  id text PRIMARY KEY,
  name text NOT NULL,
  ipv4_cidr cidr NOT NULL,
  gateway inet NOT NULL,
  dns_servers jsonb NOT NULL CHECK (jsonb_typeof(dns_servers) = 'array'),
  exclusions jsonb NOT NULL CHECK (jsonb_typeof(exclusions) = 'array'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE control.provider_profiles (
  id text PRIMARY KEY,
  provider_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('disabled', 'validation_pending', 'validated', 'active', 'validation_failed')),
  endpoint text NOT NULL,
  cluster_alias text NOT NULL,
  compute_target text NOT NULL,
  image_source_reference text NOT NULL,
  storage_target text NOT NULL,
  network_attachment text NOT NULL,
  resource_id_minimum bigint NOT NULL,
  resource_id_maximum bigint NOT NULL,
  network_id text NOT NULL REFERENCES control.networks(id),
  credential_reference text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (resource_id_minimum <= resource_id_maximum)
);

CREATE TABLE control.images (
  id text PRIMARY KEY,
  name text NOT NULL,
  provider_profile_id text NOT NULL REFERENCES control.provider_profiles(id),
  enabled boolean NOT NULL DEFAULT true,
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'arm64')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE control.flavors (
  id text PRIMARY KEY,
  name text NOT NULL,
  cpu_count integer NOT NULL CHECK (cpu_count > 0),
  memory_mib bigint NOT NULL CHECK (memory_mib >= 512),
  minimum_disk_gib bigint NOT NULL CHECK (minimum_disk_gib >= 8),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE control.instances (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES control.projects(id),
  image_id text NOT NULL REFERENCES control.images(id),
  flavor_id text NOT NULL REFERENCES control.flavors(id),
  network_id text NOT NULL REFERENCES control.networks(id),
  provider_profile_id text NOT NULL REFERENCES control.provider_profiles(id),
  hostname text NOT NULL,
  ssh_public_keys jsonb NOT NULL CHECK (jsonb_typeof(ssh_public_keys) = 'array'),
  desired_cpu_count integer NOT NULL,
  desired_memory_mib bigint NOT NULL,
  desired_disk_gib bigint NOT NULL,
  desired_power_state text NOT NULL DEFAULT 'running',
  lifecycle_state text NOT NULL DEFAULT 'pending',
  active_operation_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE control.operations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES control.projects(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  state text NOT NULL,
  stage text NOT NULL,
  progress_percent integer NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
  accepted_at timestamptz NOT NULL,
  started_at timestamptz,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_category text,
  error_code text,
  error_message text,
  manual_review_required boolean NOT NULL DEFAULT false
);

ALTER TABLE control.instances
  ADD CONSTRAINT instances_active_operation_fk
  FOREIGN KEY (active_operation_id) REFERENCES control.operations(id);

CREATE TABLE control.ipv4_leases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES control.projects(id),
  instance_id uuid NOT NULL UNIQUE REFERENCES control.instances(id),
  network_id text NOT NULL REFERENCES control.networks(id),
  address inet NOT NULL,
  prefix_length integer NOT NULL CHECK (prefix_length BETWEEN 1 AND 32),
  gateway inet NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'quarantined', 'released')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX ipv4_leases_active_address
  ON control.ipv4_leases (network_id, address)
  WHERE state IN ('active', 'quarantined');

CREATE TABLE control.idempotency_records (
  actor_id text NOT NULL,
  project_id uuid NOT NULL,
  operation_type text NOT NULL,
  idempotency_key text NOT NULL,
  target_id uuid NOT NULL,
  request_hash char(64) NOT NULL,
  operation_id uuid NOT NULL REFERENCES control.operations(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, project_id, operation_type, idempotency_key)
);

CREATE TABLE control.outbox (
  event_id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  schema_name text NOT NULL,
  schema_version integer NOT NULL,
  partition_key text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX control_outbox_order ON control.outbox (occurred_at, event_id);

CREATE TABLE audit.entries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL,
  operation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE workflow.command_receipts (
  event_id uuid PRIMARY KEY,
  consumer_name text NOT NULL,
  payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE workflow.instance_leases (
  instance_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL,
  leased_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workflow.workflows (
  operation_id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  project_id uuid NOT NULL,
  instance_id uuid NOT NULL UNIQUE,
  command jsonb NOT NULL,
  status text NOT NULL,
  stage text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  fencing_token bigint NOT NULL,
  provider_resource_id text,
  provider_task_reference text,
  next_attempt_at timestamptz NOT NULL,
  failure_category text,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX workflows_ready ON workflow.workflows (status, next_attempt_at);

CREATE TABLE workflow.outbox (
  event_id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  schema_name text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX workflow_outbox_order ON workflow.outbox (occurred_at, event_id);

CREATE TABLE projection.event_receipts (
  event_id uuid PRIMARY KEY,
  consumer_name text NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE projection.instances (
  instance_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE projection.operations (
  operation_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  target_id uuid NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
