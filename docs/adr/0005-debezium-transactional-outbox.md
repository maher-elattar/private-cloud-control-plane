# ADR-0005: Publish PostgreSQL Outbox Records With Debezium

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-025`, `SRS-FR-057` through `SRS-FR-063`, `SRS-NFR-001` through `SRS-NFR-003`, `SRS-ARC-002`

## Context

Command acceptance must atomically persist domain state and a message while remaining available when Kafka is down. Writing PostgreSQL and Kafka directly from the API is a dual write: either side can succeed alone. A custom polling publisher would solve that atomicity gap but add application code, polling load, lock ownership, scaling, and a fifth operational process.

The platform already runs Kubernetes and will operate Kafka declaratively. Change data capture can publish committed outbox rows without placing Kafka availability in the accepting request path.

## Decision

Use a PostgreSQL transactional outbox captured by Debezium and routed to versioned Kafka topics.

Each state-owning deployable writes its domain change and an immutable outbox row in the same local PostgreSQL transaction. The outbox row contains:

- Unique event ID
- Aggregate type and ID
- Event schema name and major version
- Project, operation, correlation, and causation identity
- Occurrence time and trace context
- Partition key
- Validated, size-bounded JSON payload

Outbox tables contain no credential, private initialization data, raw authorization header, or large binary field. Events are immutable after commit.

Debezium receives a dedicated replication identity and captures only declared outbox tables. The connector applies an outbox event router configuration and produces to an explicit topic allowlist with the row's event ID and partition key. Schema history, connector offsets, replication slot state, and Kafka Connect availability are monitored.

Publication remains at-least-once. Consumers deduplicate by event ID; Debezium offset state is not a domain completion record. Outbox records are retained long enough to diagnose and recover publication gaps, then removed by an explicit retention process only after the recovery horizon.

The Control API never waits for or contacts Kafka during command acceptance. Readiness distinguishes PostgreSQL, which is required for acceptance, from Kafka and Debezium, whose outage creates backlog but not data loss.

## Consequences

### Positive

- A single PostgreSQL commit decides command acceptance and message durability.
- Kafka downtime does not create a dual-write loss window.
- Publication behavior is reusable across Control API, Orchestrator, and Reconciler schemas.
- Connector lag and outbox age expose delivery health directly.

### Negative

- PostgreSQL logical replication, slots, Kafka Connect, and connector state require operational ownership.
- A stalled replication slot can retain WAL and threaten database capacity.
- Database schema and connector routing configuration must evolve together.
- Duplicate publication remains possible and must be handled by consumers.

## Rejected Alternatives

### Publish to Kafka after committing PostgreSQL

Rejected because process or broker failure between writes loses the command unless an outbox still exists.

### Publish to Kafka before committing PostgreSQL

Rejected because consumers may observe work whose authoritative state later rolls back.

### Build an application polling publisher

Rejected for the MVP because Debezium demonstrates CDC operations and avoids custom lock, poll, and scale logic. This can be reconsidered if CDC complexity exceeds measured value.

### Use a database trigger to call Kafka

Rejected because it couples transaction health to an external broker and is difficult to operate and test safely.

## Verification

- Stop Kafka, accept commands, confirm committed outbox growth, restore Kafka, and verify one logical result per event ID.
- Restart Connect and reset a test connector offset in an isolated environment to prove duplicate tolerance.
- Alert tests cover old outbox rows, connector failure, replication lag, and excessive retained WAL.
- Contract tests verify topic, key, headers, envelope, redaction, and unsupported schema handling.
