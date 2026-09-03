# Phase 4 Persistence and Delivery Identity

Phase 4 keeps the four logical PostgreSQL owners from Phase 3 and changes only how records cross
those ownership boundaries. `control` still accepts tenant intent, `workflow` still owns provider
execution, and `projection` still owns API read models. Kafka transports commands and facts; it does
not make one service a writer of another service's tables.

## Outbox Shape

`control.outbox` and `workflow.outbox` deliberately have the same columns so one Debezium connector
configuration can route both tables safely.

| Column | Purpose |
| --- | --- |
| `outbox_id` | Unique physical CDC row; a replay always receives a new value |
| `event_id` | Stable logical event identity used by domain deduplication |
| `topic` | Explicit allowlisted destination rather than a name derived from payload data |
| `partition_key` | Instance identity for provisioning or project identity for audit ordering |
| `schema_name`, `schema_version` | Consumer compatibility decision |
| `payload` | Complete validated versioned envelope |
| `tracingspancontext` | Serialized W3C carrier restored by Debezium tracing |
| `replay_generation` | Zero for normal delivery; incremented only by governed replay |
| `occurred_at`, `created_at` | Domain occurrence and physical outbox insertion times |

Outbox updates are forbidden by convention. Debezium filters deletes, and cleanup remains disabled
until connector lag and the recovery horizon can be measured safely.

## Transactional Audit Facts

The service that performs a state change writes both its append-only `audit.entries` row and an
`audit.recorded` envelope to its own outbox before commit. Control API facts retain the authenticated
actor and role. Orchestrator facts use the fixed service identity `provisioning-orchestrator`; they do
not pretend to know the original actor after the command boundary. Replay facts carry the replay
request UUID as `reasonReference`, while the reason text remains in restricted owner storage.

Audit facts use new event IDs and generation zero because they are new facts, not replays of the
provisioning command. Their causation ID points to the command, terminal event, or replay request
that produced the decision. This gives the archive a walkable causal chain without high-cardinality
metric labels or fabricated broker metadata.

## Inbox and Offset Boundary

Command and projection receipts use `(consumer_name, event_id, replay_generation)` as their primary
key and also retain non-null Kafka topic, partition, and offset. A consumer performs these steps:

1. Validate the Kafka key, headers, envelope, schema, and size.
2. Insert or find the receipt and apply the owning state change in one PostgreSQL transaction.
3. Commit the next Kafka offset only after that transaction commits.

A process failure between steps two and three is expected. Kafka redelivers the record and the
receipt turns it into a recorded duplicate with no repeated provider effect.

## Workflow Scheduling

Kafka admission creates the workflow and receipt. It does not keep the Kafka record open through
provider execution. `workflow.workflows` remains a leased and fenced durable scheduler with:

- `stage_attempt` and `retry_started_at` for bounded per-stage retry
- the provider resource and task references required to resume after restart
- `trace_context` for the next short-lived transition span
- `replay_generation` connecting an approved redelivery to its inbox receipt

The logical command event ID remains unique on the workflow row. Governed replay preserves that event
ID and admits a new generation only after the current deployment validates the stored original
command. `workflow.replay_requests` binds the administrative request to the exact command hash,
generation, and physical workflow outbox ID. Authorization writes that outbox row and changes the
dead letter to `replay_requested` in one transaction; it does not create an inbox receipt or reopen
work. Only a matching later Kafka record may record the generation receipt and create or resume the
checkpointed workflow. This means every command receipt is physical delivery evidence.

An incompatible replay request is durably marked `rejected` and consumed, while the original dead
letter stays open at its current generation; an operator must deploy compatibility and submit a fresh
attributed request. A syntactically valid generation with no matching authority, payload hash, or
outbox ID is quarantined without raw-payload retention and cannot invoke the provider.

Outbox backlog gauges compare immutable producer rows with consumer-owned inbox or projection
receipts. This is consumption evidence used by drills, not a CDC publisher acknowledgement, and it
does not replace Kafka offsets. No consumer updates a producer-owned outbox row.

## Migration Safety

`tools/db/migrate.mjs` discovers numbered SQL files, takes a PostgreSQL advisory lock, verifies SHA-256
checksums, and records each successful migration in `public.schema_migrations` in the same transaction
as its SQL. It can adopt the original untracked Phase 3 schema exactly once before applying Phase 4.

Local verification applies all numbered migrations to a clean PostgreSQL 16 database, applies the
runner a second time, and separately verifies adoption of an existing Phase 3 database. Migration
`0005` removes legacy coordinate-free replay placeholders before making command broker coordinates
mandatory and adds the durable replay-authority table.

See [Phase 4 Messaging and Observability](phase-4-messaging-and-observability.md) for the full event
path and [Phase 4 Failure Recovery](../runbooks/phase-4-failure-recovery.md) for operational use.
