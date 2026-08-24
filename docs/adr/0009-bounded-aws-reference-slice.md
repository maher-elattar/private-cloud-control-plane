# ADR-0009: Bound the AWS Reference Slice at Reliable Command Delivery

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-082` through `SRS-FR-091`, `SRS-NFR-020`, `SRS-NFR-032`, `SRS-NFR-035`, `SRS-NFR-036`, `SRS-ARC-008`, `SRS-ARC-009`

## Context

The primary control plane runs on the existing Kubernetes platform and demonstrates PostgreSQL, Kafka, Debezium, KEDA, provider workflows, and OpenTelemetry. A focused AWS implementation should demonstrate cloud architecture judgment, transactional serverless patterns, IAM, failure handling, operational visibility, and cost control without duplicating the full platform or forcing the Proxmox management path through long-running Lambda invocations.

A second complete control plane would double contracts, persistence, orchestration, security, deployment, and test scope. A token Lambda that performs an unrelated calculation would add technology without architectural relevance.

## Decision

Build a bounded AWS command-delivery reference slice with the same provider-neutral command identity and envelope concepts as the Kubernetes path:

1. API Gateway validates, authorizes, throttles, and invokes a command-handler Lambda.
2. The handler uses one DynamoDB transaction to write idempotent command/operation state and an explicit outbox item.
3. DynamoDB Streams invokes an outbox-relay Lambda with event filtering, bounded concurrency, partial batch failure, and duplicate-safe processing.
4. The relay publishes a provider-neutral command to SQS FIFO using stable message group and deduplication identities.
5. Failed SQS work reaches an encrypted dead-letter queue with an authorized, audited redrive procedure.
6. EventBridge Scheduler invokes a watchdog Lambda that conditionally marks overdue pending operations without racing a terminal completion.
7. Minimized audit events are archived to an encrypted, private S3 bucket with retention and lifecycle policy.
8. CloudWatch logs, metrics, alarms, dashboard, X-Ray-compatible trace context where practical, and a synthetic canary cover acceptance, relay, retry, timeout, and dead-letter behavior.

No Lambda executes long-running Proxmox provisioning. The slice ends when a durable ordered command is available, a pending command times out, or audit evidence is archived. An optional future bridge may transfer the SQS command into the Kubernetes command path, but it is not required for MVP acceptance and cannot create a second aggregate authority.

Infrastructure is declared with Terraform in `private-cloud-platform-live`. It uses one sandbox account boundary, least-privilege role per function, short-lived CI federation, encryption, point-in-time recovery where applicable, log retention, cost-allocation tags, reserved concurrency, a budget alarm, and a documented destroy procedure. Static AWS access keys are prohibited.

## Consequences

### Positive

- The AWS work demonstrates DynamoDB transactions, Streams, Lambda event-source failure semantics, SQS FIFO and DLQ, IAM, S3 lifecycle, CloudWatch, and cost governance in one coherent workflow.
- It compares two valid outbox implementations without replacing the Kubernetes source of truth.
- Serverless execution remains short, bounded, reproducible, and inexpensive.
- The shared command identity permits contract comparison and future bridging.

### Negative

- The AWS slice is not a second provider runtime and cannot provision a VM independently.
- DynamoDB and SQS behavior require separate integration and failure tests.
- OpenTelemetry parity with the Kubernetes stack is limited by managed-service boundaries; CloudWatch remains the native operational view.

## Rejected Alternatives

### Run the complete Proxmox workflow in Lambda

Rejected because provider tasks are long-running, have unknown outcomes, need checkpoint recovery, and require controlled hybrid network access.

### Rebuild Kafka, PostgreSQL, and all four services on AWS

Rejected because it duplicates the primary architecture and exceeds the bounded learning and portfolio objective.

### Add an unrelated Lambda function

Rejected because it would not demonstrate a meaningful cloud boundary or compare persistence and outbox strategies.

### Use DynamoDB Streams as the only durable outbox record

Rejected because the explicit outbox item makes command intent, relay status, watchdog behavior, and operational inspection first-class while remaining in the same transaction as acceptance.

## Verification

- Terraform can create and destroy the slice reproducibly in the sandbox account.
- One hundred duplicate accepts produce one logical operation and one logical FIFO command identity.
- Mixed-success stream batches retry only failed records; poison work reaches the DLQ without blocking successful records.
- Watchdog and late-completion races preserve exactly one terminal operation state through conditional writes.
- IAM tests deny unrelated resource actions; public S3 access and static credentials are absent.
- The dashboard, alarms, cost tags, budget alarm, restore evidence, and destroy record are retained with the deployment verification.
