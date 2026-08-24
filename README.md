# Private Cloud Control Plane

A provider-neutral control plane for asynchronous virtual-machine lifecycle management. The system accepts REST commands, coordinates provider work over an internal gRPC boundary, persists desired state, publishes work through a transactional outbox, reconciles provider state, and exposes correlated traces, metrics, and logs.

The primary runtime target is an existing Kubernetes cluster. Proxmox is the first provider adapter, not a domain dependency. A bounded AWS serverless path will implement the same command and event contracts with DynamoDB, Lambda, and SQS.

## Repository Boundary

This repository owns application source, shared contracts, database migrations, automated tests, and product and architecture documentation. Kubernetes runtime state, observability deployments, and AWS infrastructure belong in a separate GitOps repository. Cluster bootstrap and foundational services remain in the existing foundation repository.

The repository boundaries and promotion contract are defined in [Repository Boundaries](docs/architecture/repository-boundaries.md).

## Documentation Map

### Product and Requirements

- [Scope Baseline](docs/product/scope-baseline.md): frozen MVP boundary, capability priorities, and excluded work
- [Capability Assessment](docs/product/capability-assessment.md): reusable behavior and provider integration assessment
- [Product Requirements Document](docs/product/prd.md): problem, personas, use cases, success measures, non-goals, and MVP definition
- [Software Requirements Specification](docs/product/srs.md): numbered functional, non-functional, and architecture requirements
- [Requirements Traceability](docs/product/requirements-traceability.md): requirement-to-use-case, architecture, evidence, and verification mapping

### Architecture and Safety

- [Safety Invariants](docs/architecture/safety-invariants.md): mandatory ownership, delivery, provider, resource, and telemetry rules
- [Lab Boundary](docs/architecture/lab-boundary.md): exact live-provider scope and activation gate
- [C4 Model](docs/architecture/c4-model.md): system context and container views
- [Create-Instance Sequence](docs/architecture/create-instance-sequence.md): acceptance, outbox, workflow, provider, and projection path
- [Failure Sequences](docs/architecture/failure-sequences.md): broker outage, provider timeout, duplicate delivery, and compensation behavior
- [State Machines](docs/architecture/state-machines.md): instance, desired power, observed provider, and operation lifecycles
- [Data Ownership Map](docs/architecture/data-ownership.md): authoritative writers, schemas, topics, transactions, and AWS ownership

### Security and Decisions

- [Trust Boundaries](docs/security/trust-boundaries.md): identities, crossings, required controls, and network intent
- [Threat Model](docs/security/threat-model.md): assets, STRIDE threats, abuse cases, controls, and residual risk
- [Architecture Decision Records](docs/adr/README.md): accepted decisions that constrain implementation

## Current State

Phase 1 is complete: product requirements, software requirements, traceability, architecture, failure behavior, lifecycle models, security boundaries, data ownership, and foundational decisions are baselined. No runtime application code is included yet.
