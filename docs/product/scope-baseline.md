# Scope Baseline

## Product Definition

The Private Cloud Control Plane is a provider-neutral system that accepts virtual-machine lifecycle commands, records desired state, executes long-running provider workflows asynchronously, reconciles observed state, and gives operators enough telemetry and recovery controls to understand every outcome.

Proxmox is the first provider implementation. It is isolated behind a gRPC provider contract so provider-specific paths, task identifiers, errors, and data transfer objects never enter the public API or core domain.

## Portfolio Outcome

The finished system must demonstrate engineering judgment in these areas:

- Contract-first REST, gRPC, and event-driven interfaces
- Transactional state changes and reliable event publication
- At-least-once delivery with idempotent consumers
- Persisted workflow checkpoints, bounded retries, and manual recovery
- Desired-versus-observed reconciliation without destructive automation
- Backpressure visibility and Kafka-lag scaling with KEDA
- End-to-end OpenTelemetry correlation across synchronous and asynchronous boundaries
- Declarative Kubernetes delivery through Argo CD
- A bounded AWS serverless implementation of the same command contracts
- Measured load, failure, recovery, and SLO evidence

The result is described as production-oriented and validated in a controlled lab. It is not described as production grade.

## Deployable Boundary

The Kubernetes implementation has four deployables:

| Deployable | Owns | Must Not Own |
| --- | --- | --- |
| Control API | Projects, catalog, desired instance state, operation records, idempotency records, transactional outbox, REST, gRPC | Provider-specific DTOs, long-running provider polling |
| Provisioning orchestrator | Kafka command consumption, inbox deduplication, workflow checkpoints, retries, compensation, event emission | Public API, provider credentials exposed to callers |
| Proxmox provider | Provider-neutral gRPC implementation, Proxmox authentication, task submission and polling, error translation | Projects, public authorization, Kafka workflow state |
| Reconciler | Periodic observed-state reads, drift classification, stale-operation detection, non-destructive recovery proposals | Automatic purge, automatic destructive correction |

Catalog, IP lease, snapshot, audit, authentication, and notification concerns remain modules inside these deployables unless measured evidence later justifies another process boundary.

## Core MVP

### Product and Catalog

- Minimal projects with a seeded lab project
- Provider profiles with explicit allowlists
- Images backed by approved Proxmox templates
- Flavors defining CPU, memory, and disk ceilings
- IPv4 network definitions and one lease per instance
- Project quotas enforced before provider mutation

### Instance Lifecycle

- Create from an allowlisted image using a full clone
- List and inspect instances and current operations
- Start, graceful shutdown, stop, and reboot
- Resize CPU and memory within quota
- Grow disk, never shrink it
- Create, list, delete, and roll back snapshots
- Soft delete and retain provider resources
- Explicit administrative purge guarded by ownership evidence

### Distributed Workflow

- Immediate command acknowledgement with an operation identifier
- Atomic desired-state, operation, and outbox writes
- Kafka command and event contracts with per-instance ordering
- Inbox receipts and idempotency for every consumer
- Persisted provider task references and workflow checkpoints
- Bounded retry categories, dead-letter handling, and administrative replay
- Unknown outcomes routed to manual review rather than blind retry
- Periodic desired-versus-observed reconciliation and drift reporting

### Platform Evidence

- OpenTelemetry traces, structured logs, and low-cardinality metrics
- Prometheus, Grafana, Tempo, and Loki views
- Outbox delivery time, queue residence time, consumer lag, operation duration, and provider error signals
- KEDA scaling from Kafka lag with a provider concurrency ceiling
- Load tests against the fake provider and tightly capped live-provider tests
- Failure drills for broker outage, duplicate delivery, worker loss, provider timeout, database failover, and telemetry outage

### AWS Reference Slice

- API Gateway HTTP API and command Lambda
- DynamoDB transaction containing aggregate and outbox items
- DynamoDB Streams relay Lambda with idempotency and partial-batch failure handling
- SQS FIFO queue and dead-letter queue
- EventBridge Scheduler watchdog for timed-out operations
- S3 audit archive, KMS, CloudWatch, IAM, budgets, and cost tags
- Terraform and short-lived CI identity

The AWS slice accepts commands and demonstrates reliable publication. It does not run long Proxmox provisioning inside Lambda.

## Stretch Backlog

- Adopt an existing VM after collision and ownership validation
- Backup create, restore, and deletion
- Short-lived browser console sessions
- Read-only node-local inventory agent
- Minimal read-only operator interface
- IPv6
- A second fake or real provider implementation

Stretch work begins only after the core lifecycle, recovery, observability, and evidence gates pass.

## Reference Only

These behaviors inform invariants or tests but are not copied as features:

- Durable SQLite callback outbox used by a node-local agent
- HMAC-signed, idempotent inventory ingestion
- Full and partial inventory reconciliation
- IP conflict and stale-observation classification
- Provider task progress capture and customer-safe error redaction
- Compensating cleanup after partial provisioning failure

## Removed

- Billing, invoices, pricing, collections, coupons, and payments
- Hosting-product and checkout behavior
- Automatic placement scoring or weighted scheduling
- Live migration and storage balancing
- Hypervisor host, SDN, physical network, or storage lifecycle management
- LXC provisioning
- GPU, PCI, USB, and advanced device passthrough
- Image building
- Customer password management
- Multi-region active-active operation
- Service mesh and custom identity platform
- A workflow engine in addition to Kafka and persisted checkpoints
- EKS, MSK, Control Tower, and Transit Gateway deployments

## Scope Change Rule

A new capability enters the core only when it satisfies all of the following:

1. It strengthens the control-plane, reliability, observability, Kubernetes, or AWS architecture story.
2. It fits an existing deployable and does not create a service solely for organizational neatness.
3. Its contracts, authorization, idempotency, failure behavior, telemetry, tests, and recovery procedure are defined first.
4. It can be demonstrated safely inside the lab boundary.
5. It displaces an item of comparable effort or remains in the stretch backlog.
