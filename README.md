# Private Cloud Control Plane

A provider-neutral control plane for asynchronous virtual-machine lifecycle management. The system accepts REST and gRPC commands, persists desired state, publishes work through a transactional outbox, reconciles provider state, and exposes correlated traces, metrics, and logs.

The primary runtime target is an existing Kubernetes cluster. Proxmox is the first provider adapter, not a domain dependency. A bounded AWS serverless path will implement the same command and event contracts with DynamoDB, Lambda, and SQS.

## Repository Boundary

This repository owns application source, shared contracts, database migrations, automated tests, and product and architecture documentation. Kubernetes runtime state, observability deployments, and AWS infrastructure belong in a separate GitOps repository. Cluster bootstrap and foundational services remain in the existing foundation repository.

See:

- [Scope baseline](docs/product/scope-baseline.md)
- [Capability assessment](docs/product/capability-assessment.md)
- [Safety invariants](docs/architecture/safety-invariants.md)
- [Lab boundary](docs/architecture/lab-boundary.md)
- [Repository boundaries](docs/architecture/repository-boundaries.md)

## Current State

The product scope and safety boundary are frozen. No runtime application code is included yet.
