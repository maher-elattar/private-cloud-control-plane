# ADR-0004: Design Kafka Delivery for At-Least-Once Semantics

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-057` through `SRS-FR-068`, `SRS-FR-076`, `SRS-FR-080`, `SRS-NFR-001` through `SRS-NFR-005`, `SRS-ARC-003`

## Context

Kafka decouples command acceptance from long-running provider work and retains work while consumers are unavailable. Producer retries, consumer restarts, rebalance, connector recovery, and dead-letter replay can all deliver a logical event more than once. External provider APIs cannot participate in Kafka transactions.

An exactly-once claim would therefore be misleading even if a broker feature suppressed some duplicate records. The control plane must remain correct when the same logical command is seen repeatedly and when a worker stops at any side-effect boundary.

## Decision

Kafka is treated as an at-least-once transport. Correctness is implemented in application state:

- Every envelope has a globally unique stable event ID, versioned schema identity, aggregate ID, project ID, operation ID, correlation and causation IDs, occurrence time, and trace context.
- All commands affecting one instance use the instance ID as partition key.
- Each consumer group stores an inbox receipt keyed by consumer identity and event ID.
- Domain transition, workflow checkpoint, inbox completion, and any emitted outbox event commit atomically where they share an owner.
- Provider task references are persisted before polling. Restart resumes the known task rather than resubmitting it.
- An instance workflow lease with a fencing version prevents concurrent provider mutations across replicas.
- Unsupported major versions and invalid envelopes are rejected without invoking domain or provider behavior.
- Retries are classified, bounded by attempt and elapsed time, and delayed with backoff and jitter.
- Exhausted or poison work moves to a versioned dead-letter topic. Replay requires an authorized reason, retains original event identity, and creates a new replay audit/causation record.

Kafka retention is an operational recovery window, not the permanent source of instance truth. PostgreSQL owns desired, workflow, observation, and projection state.

KEDA may scale consumers from lag, but maximum replicas, partition count, database capacity, and a separate provider concurrency semaphore limit effective work.

## Consequences

### Positive

- The failure model matches broker, connector, and provider reality.
- Duplicate delivery and worker termination become normal tested cases.
- Broker outages do not require the API to coordinate with consumers.
- Event identity provides a consistent audit and trace chain.

### Negative

- Consumers require durable inbox and checkpoint storage.
- Eventual consistency is visible to clients through operation resources.
- Operational replay is a privileged workflow rather than a simple topic copy.

## Rejected Alternatives

### Claim end-to-end exactly-once processing

Rejected because Proxmox and other external effects cannot join a Kafka transaction, and timeout can leave their outcome unknown.

### Use auto-commit consumer offsets as completion proof

Rejected because a crash can commit before state or side effects complete, or repeat work after they complete.

### Rely on Kafka ordering for all concurrency control

Rejected because rebalances, administrative replay, multiple topics, and scheduled reconciliation can create concurrent work outside one partition stream.

## Verification

- Delivering a create event 100 times yields one aggregate and at most one provider VM.
- Terminating a consumer before and after each checkpoint resumes without duplicate submission.
- Same-instance ordering and cross-instance concurrency are measured with multiple partitions.
- Poison, unsupported-version, retry exhaustion, dead-letter, and audited replay paths have integration tests.
