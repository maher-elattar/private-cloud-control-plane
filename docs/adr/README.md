# Architecture Decision Records

Architecture Decision Records capture decisions that constrain implementation or operations. An accepted ADR is immutable: a later decision supersedes it with a new record and links both records.

## Status Definitions

- `Proposed`: under review and not yet binding
- `Accepted`: binding for implementation
- `Superseded`: replaced by a later ADR
- `Rejected`: considered but not selected

## Index

| ID | Decision | Status |
| --- | --- | --- |
| [ADR-0001](0001-provider-neutral-control-plane.md) | Keep the control plane provider-neutral | Accepted |
| [ADR-0002](0002-four-kubernetes-deployables.md) | Use four Kubernetes application deployables | Accepted |
| [ADR-0003](0003-postgresql-and-dynamodb-persistence-ports.md) | Isolate PostgreSQL and DynamoDB behind persistence ports | Accepted |
| [ADR-0004](0004-kafka-at-least-once-delivery.md) | Design Kafka delivery for at-least-once semantics | Accepted |
| [ADR-0005](0005-debezium-transactional-outbox.md) | Publish PostgreSQL outbox records with Debezium | Accepted |
| [ADR-0006](0006-explicit-provider-placement.md) | Use explicit provider placement for the MVP | Accepted |
| [ADR-0007](0007-soft-delete-and-guarded-purge.md) | Make normal deletion soft and purge guarded | Accepted |
| [ADR-0008](0008-non-destructive-reconciliation.md) | Keep automatic reconciliation non-destructive | Accepted |
| [ADR-0009](0009-bounded-aws-reference-slice.md) | Bound the AWS reference slice at reliable command delivery | Accepted |
| [ADR-0010](0010-versioned-contracts-and-compatibility.md) | Version external contracts and generate language types | Accepted |
| [ADR-0011](0011-provider-port-and-deterministic-fake.md) | Isolate providers behind a deterministic lifecycle port | Accepted |
| [ADR-0012](0012-phase-4-delivery-and-telemetry-runtime.md) | Keep delivery state and telemetry context explicit | Accepted |

## Required ADR Content

Every record states context, decision, consequences, rejected alternatives, and links to the requirements it governs. Implementation changes that violate an accepted decision require a superseding ADR before merge.
