# ADR-0003: Isolate PostgreSQL and DynamoDB Behind Persistence Ports

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-025`, `SRS-FR-060` through `SRS-FR-068`, `SRS-FR-082` through `SRS-FR-090`, `SRS-NFR-006`, `SRS-NFR-027`, `SRS-ARC-001`, `SRS-ARC-008`

## Context

PostgreSQL is the Kubernetes control plane's source of truth and supports relational constraints, transactional leases, and the Debezium outbox. The AWS reference slice uses DynamoDB to demonstrate a cloud-native transactional command store and stream-driven outbox. Their transaction and concurrency models differ significantly.

Pretending both stores are interchangeable through a generic CRUD repository would hide the guarantees needed for idempotency, ownership, and command acceptance. Importing database clients throughout the domain would make those guarantees difficult to test and would spread implementation details across services.

## Decision

Application use cases depend on narrow capability-oriented persistence ports. Examples include:

- Accept an idempotent instance command atomically
- Acquire or renew an instance workflow lease with a fencing version
- Persist a workflow checkpoint and emitted fact atomically
- Record an inbox result once
- Apply a versioned observation and append a drift event
- Complete a pending operation only if its state and version still match

The PostgreSQL adapters implement Kubernetes use cases using explicit transactions, constraints, locking or compare-and-set versions, and logical schemas from the data ownership map. Database migrations are owned in this repository and execute through a controlled delivery job rather than application startup races.

The DynamoDB adapter implements only the bounded AWS command-acceptance and watchdog capabilities. Command state and its outbox item are written in one `TransactWriteItems` operation using conditional expressions. It is not required to implement relational workflow leases, projections, IP allocation, or the full Kubernetes control plane.

Ports express domain outcomes such as accepted, idempotent replay, version conflict, lease conflict, or not found. They do not expose SQL strings, ORM models, DynamoDB attribute maps, table names, or provider types.

Transaction boundaries remain explicit in the use-case method. A unit-of-work abstraction cannot allow an open transaction to cross Kafka, gRPC, Proxmox, or SQS calls.

## Consequences

### Positive

- Domain tests can prove behavior with deterministic in-memory fakes while integration tests prove real store semantics.
- PostgreSQL and DynamoDB use their native concurrency controls without forcing false feature parity.
- Database clients, credentials, retries, and telemetry stay at adapter boundaries.
- Storage choices can be explained as deliberate runtime decisions rather than technology substitution.

### Negative

- Each adapter requires dedicated integration and failure tests.
- Capability ports contain more purpose-specific methods than a generic repository.
- In-memory test doubles cannot substitute for transaction and concurrency tests against real engines.

## Rejected Alternatives

### One generic CRUD repository for both databases

Rejected because it cannot faithfully express PostgreSQL constraints and DynamoDB conditional transactions without leaking or discarding guarantees.

### DynamoDB for the Kubernetes control plane

Rejected because the MVP's workflow leases, projections, relational ownership, and Debezium pipeline fit the existing Kubernetes PostgreSQL platform and do not justify an external cloud dependency.

### Direct database access in controllers and consumers

Rejected because it mixes transport, domain, and persistence concerns and makes atomic acceptance rules difficult to enforce consistently.

## Verification

- Domain packages compile without PostgreSQL, ORM, or AWS SDK imports.
- PostgreSQL integration tests prove unique idempotency, active IP lease, inbox, lease fencing, checkpoint, and outbox constraints under concurrency.
- DynamoDB integration tests prove atomic acceptance, conditional duplicate handling, and watchdog/completion races.
- A test fails if an external side effect is attempted while a database transaction is open.
