# ADR-0012: Keep Delivery State and Telemetry Context Explicit

- Status: Accepted
- Date: 2026-08-27
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-057` through `SRS-FR-068`, `SRS-FR-075` through `SRS-FR-079`, `SRS-NFR-001` through `SRS-NFR-008`, `SRS-NFR-021` through `SRS-NFR-024`

## Context

Phase 3 proves the provider workflow without Kafka by reading commands and events directly from
PostgreSQL outbox tables. Phase 4 replaces those temporary cross-service reads with Debezium and
Kafka. Neither Kafka offsets nor trace context can be kept open across a provider workflow that may
wait, retry, or survive a process restart.

Administrative replay adds a second identity problem. The logical event ID must remain stable for
audit and domain idempotency, while an authorized redelivery must still be distinguishable from an
ordinary broker duplicate.

## Decision

- Outbox rows have a unique physical `outbox_id` and a stable logical `event_id`.
- Inbox identity is `(consumer_name, event_id, replay_generation)`. Normal delivery uses generation
  zero. Only the authoritative dead-letter recovery transaction may allocate a higher generation.
- Kafka consumers disable auto-commit. A record offset is advanced only after the owning database
  transaction commits. A crash in the remaining offset-commit gap produces a harmless duplicate.
- Kafka transports commands and facts between owners. Provider task scheduling, delay, lease, and
  fencing remain durable PostgreSQL workflow responsibilities; no partition is held while waiting.
- Every outbox row stores W3C trace context in both the versioned envelope and the serialized carrier
  consumed by Debezium's tracing transformation.
- A workflow checkpoint stores the span context that explains it. The next short-lived transition
  restores that context instead of keeping one span open through an asynchronous wait.
- All Node.js services send traces and metrics over OTLP to the OpenTelemetry Collector. Prometheus
  scrapes only the Collector's consolidated endpoint, and applications never depend on telemetry
  availability for correctness.
- Metric labels are bounded operational classifications. Resource, project, event, operation,
  provider-task, address, credential, and tenant-configuration identities are prohibited labels.

## Consequences

### Positive

- Broker duplicates, consumer crashes, and authorized replay have distinct durable semantics.
- Long-running provider work cannot stall a Kafka partition or lose its retry schedule on rebalance.
- A trace can cross database CDC and resume after process restarts without fabricating a continuous
  long-lived span.
- Trace exemplars can explain a latency histogram without putting high-cardinality IDs in metrics.

### Negative

- Outbox, inbox, and workflow schemas carry additional delivery and trace metadata.
- The application owns custom Kafka span boundaries because KafkaJS has no transaction spanning the
  database and provider effects.
- Local verification requires Kafka, Connect, Collector, Tempo, Prometheus, and Grafana containers.

## Rejected Alternatives

### Hold Kafka records until provider completion

Rejected because provider operations outlive consumer session and rebalance budgets and would cause
head-of-line blocking for every instance sharing the partition.

### Deduplicate only by physical outbox row ID

Rejected because an accidental second outbox row could repeat a provider mutation. Logical identity
remains the safety key; replay generation is granted only by the recovery workflow.

### Export directly from services to Prometheus or Tempo

Rejected because it couples every service to backend-specific topology and bypasses centralized
batching, retry, filtering, and redaction controls.

## Verification

- Stop Kafka before and after command acceptance, then prove recovery from the committed outbox.
- Stop consumers before database commit and after commit but before offset commit.
- Inject ordinary duplicates and prove one provider resource; authorize a compatible replay and prove
  a new generation with the original event ID; prove an incompatible replay is consumed and rejected
  without closing the original dead letter.
- Query Tempo for the known request trace and Prometheus for the expected counters and histograms.
- Scan exported attributes and labels for prohibited fixture values.

The measured local results are recorded in
[Phase 4 Local Verification](../verification/phase-4-local-verification.md).
