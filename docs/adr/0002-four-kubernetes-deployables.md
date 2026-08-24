# ADR-0002: Use Four Kubernetes Application Deployables

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-001` through `SRS-FR-081`, `SRS-NFR-012`, `SRS-NFR-015`, `SRS-NFR-023`, `SRS-NFR-034`, `SRS-ARC-004`

## Context

The system needs independent control over synchronous API traffic, Kafka-driven workflows, privileged provider access, and scheduled observation. Splitting every resource or action into a service would add deployment, contract, and operational burden without creating useful autonomy for the MVP. A single process would combine incompatible scaling, permission, failure, and availability profiles.

## Decision

The Kubernetes application consists of exactly four deployables for the MVP:

| Deployable | Responsibility | Scaling signal | Privileged dependencies |
| --- | --- | --- | --- |
| Control API | REST acceptance and queries, authentication and authorization, catalog, idempotency, desired state, operation projections | HTTP demand and resource utilization | PostgreSQL; Kafka only for projection consumption |
| Provisioning Orchestrator | Kafka command handling, workflow lease, checkpoints, retries, compensation, workflow events | Kafka lag through KEDA, capped by provider concurrency | PostgreSQL, Kafka, Provider gRPC |
| Proxmox Provider | Provider translation, task submission and query, live observation, ownership enforcement | Resource utilization and bounded RPC concurrency | Proxmox API and its credential |
| Reconciler | Scheduled and requested observations, drift classification, unknown-outcome resolution, manual-review creation | Scheduled work and bounded reconciliation backlog | PostgreSQL and Provider gRPC |

Each deployable has its own entry point, container image target, Kubernetes ServiceAccount, network policy, configuration schema, health endpoints, telemetry resource identity, resource limits, and deployment manifest in the live repository.

Shared TypeScript packages may contain contracts, domain primitives, observability setup, persistence interfaces, and test utilities. A shared package cannot perform process startup, read another deployable's private configuration, or bypass a service/data ownership boundary.

Debezium, Kafka, PostgreSQL, KEDA, and the observability components are platform dependencies, not application deployables. The AWS Lambda functions belong to the bounded AWS reference slice and do not change the four-deployable Kubernetes decision.

## Consequences

### Positive

- API replicas do not scale with Kafka lag or hold provider credentials.
- Provider concurrency remains independently bounded when Orchestrator replicas increase.
- Reconciliation outages and schedules are isolated from command acceptance.
- The deployment count stays small enough to operate and explain end to end.

### Negative

- Internal gRPC and event contracts require compatibility testing.
- End-to-end behavior crosses multiple processes and needs correlated telemetry.
- PostgreSQL is shared physically, so roles and schemas must enforce logical ownership.

## Rejected Alternatives

### One modular monolith

Rejected because synchronous, consumer, provider, and scheduled work require different credentials, scaling, and failure isolation.

### Service per resource or operation

Rejected because separate instance, network, snapshot, power, resize, and audit services would multiply operational surface without independent ownership teams or scaling needs.

### Separate outbox publisher application

Rejected because Debezium provides the PostgreSQL outbox publication function without adding application-owned polling and deployment lifecycle.

## Verification

- Repository dependency rules match the four boundaries.
- The live repository declares four application workloads with distinct identities and policies.
- Only the Provider deployment can resolve the Proxmox credential or reach the provider endpoint.
- KEDA scales only the Orchestrator consumer, subject to a configured maximum and provider semaphore.
