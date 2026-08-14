# Product Requirements Document

## Document Control

| Field | Value |
| --- | --- |
| Product | Private Cloud Control Plane |
| Version | 0.1 |
| Status | Scope baseline |
| Primary audience | Platform engineers, backend engineers, SREs, security reviewers, and technical evaluators |
| Runtime context | Controlled private-cloud lab with an existing Kubernetes foundation |

## Summary

The Private Cloud Control Plane provides a reliable, observable interface for virtual-machine lifecycle operations without exposing callers to hypervisor-specific APIs or long-running provider tasks.

Callers submit commands through REST or gRPC and receive an operation identifier without waiting for the provider workflow to finish. The platform persists desired state, publishes commands reliably, performs provider work asynchronously, records progress, and reconciles provider observations back into the control-plane view.

The first provider is Proxmox. The product model remains provider-neutral. A bounded AWS serverless path accepts the same class of command and demonstrates an alternative transactional command store and event-publication mechanism without moving long-running Proxmox execution into Lambda.

## Problem

Private-cloud automation often begins as synchronous scripts or billing-system extensions. That model creates several operational problems:

- A caller remains coupled to provider latency during clone, resize, snapshot, or power operations.
- A process crash can leave an operation half-complete with no durable checkpoint.
- Writing application state and sending a message as separate actions can lose work or publish work that was never committed.
- Retried requests or duplicate messages can create duplicate infrastructure.
- Provider timeouts make the outcome ambiguous and unsafe to retry blindly.
- Manual provider changes create drift between intended and actual state.
- Queue backlog, provider saturation, and stuck work are difficult to diagnose without cross-service correlation.
- Hypervisor-specific identifiers leak into upstream systems and make future provider changes expensive.

The product must make these failure modes explicit and recoverable while keeping the live-provider scope small enough for safe lab validation.

## Product Principles

1. **Acknowledge durable intent, not provider completion.** Command latency must not depend on clone or task-polling latency.
2. **Assume duplicate delivery.** Correctness comes from idempotency, ownership checks, inbox receipts, and persisted checkpoints.
3. **Treat unknown as a real outcome.** A timeout is not proof of failure and must not trigger an unsafe duplicate mutation.
4. **Separate desired and observed state.** Provider drift is visible and classified before any correction is attempted.
5. **Keep provider details at the edge.** Public and domain contracts do not expose Proxmox task, node, or API data types.
6. **Prefer recovery evidence over feature count.** A small lifecycle with complete failure, telemetry, and runbook behavior is more valuable than broad endpoint coverage.
7. **Fail closed for live mutations.** Missing or ambiguous provider allowlist data disables writes.
8. **Do not automate destructive reconciliation.** Destructive actions require explicit administrative intent and matching ownership proof.

## Personas

### PER-001: Tenant Developer

**Context:** Builds or tests workloads and needs compute without direct Proxmox access.

**Goals:**

- Discover approved images, flavors, and networks.
- Request an instance through a stable API.
- Track long-running progress without keeping a request open.
- Perform routine power, resize, and snapshot operations.
- Understand whether the instance is ready, failed, retained, or requires operator help.

**Must not need:**

- Proxmox credentials, node names, storage names, template VMIDs, or task IDs
- Knowledge of Kafka, outbox relays, or workflow checkpoints
- Permission to purge retained provider resources

### PER-002: Platform Administrator

**Context:** Owns the provider integration, project catalog, quotas, live safety boundary, and recovery controls.

**Goals:**

- Configure a narrow provider profile and approved catalog.
- Prevent operations outside the lab project and provider allowlist.
- Inspect and replay failed asynchronous work safely.
- Distinguish retryable, permanent, and unknown outcomes.
- Approve purge only when database and provider ownership agree.
- Validate the same command contract through the bounded AWS path.

**Must not need:**

- Billing, pricing, order, or customer-account workflows
- Automatic node scoring, host lifecycle, migration, or storage balancing

### PER-003: Site Reliability Engineer

**Context:** Operates the control plane during backlog, dependency failure, task timeout, drift, or telemetry degradation.

**Goals:**

- Trace a command from API receipt through database commit, event publication, orchestration, provider calls, and projection update.
- See outbox age, queue residence, Kafka lag, retry rate, dead-letter depth, provider errors, and stuck operations.
- Recover from worker, broker, database, and provider failures without creating duplicate infrastructure.
- Use an actionable runbook and verify recovery from system signals.
- Observe KEDA scaling without allowing the provider concurrency limit to be exceeded.

**Must not need:**

- Direct database edits as a routine recovery mechanism
- Unbounded message replay or automatic destructive correction

## Use Cases

### UC-001: Discover Approved Capacity

**Actor:** Tenant Developer

**Preconditions:** The project and provider profile are enabled.

**Flow:** The caller lists the project’s approved images, flavors, and IPv4 network. Provider-specific identifiers are absent.

**Outcome:** The caller has valid domain identifiers for a create request.

### UC-002: Create an Instance

**Actor:** Tenant Developer

**Preconditions:** The request is authorized, within quota, and carries an idempotency key.

**Flow:** The caller submits project, image, flavor, network, and cloud-init public configuration. The platform atomically stores the instance intent, operation, and publication record, then returns an operation identifier.

**Outcome:** Exactly one workflow is eligible to create exactly one provider resource. Provider latency does not delay command acknowledgement.

### UC-003: Track Operation Progress

**Actor:** Tenant Developer or Platform Administrator

**Preconditions:** An operation identifier exists.

**Flow:** The caller reads operation state, timestamps, progress, and a safe failure category. An administrator can also see recovery classification and provider-task correlation.

**Outcome:** The operation reaches a terminal state, remains actively checkpointed, or clearly enters manual review.

### UC-004: Inspect Instances

**Actor:** Tenant Developer

**Preconditions:** The project exists.

**Flow:** The caller lists project instances or reads one instance.

**Outcome:** The response distinguishes desired state, observed state, lifecycle state, current operation, IPv4 lease, and drift status.

### UC-005: Change Power State

**Actor:** Tenant Developer

**Preconditions:** The instance is owned by the project and no conflicting mutation holds its lease.

**Flow:** The caller requests start, graceful shutdown, stop, or reboot with an idempotency key.

**Outcome:** The platform returns an operation identifier and eventually reports the observed power state. Duplicate requests do not submit duplicate provider tasks.

### UC-006: Resize Compute or Disk

**Actor:** Tenant Developer

**Preconditions:** The instance is active, owned, unlocked, and the target size is within project quota.

**Flow:** The caller changes CPU, memory, or requests disk growth.

**Outcome:** CPU and memory match the accepted target. Disk grows when requested and can never be reduced through the platform.

### UC-007: Manage Snapshots

**Actor:** Tenant Developer

**Preconditions:** The instance is active and below the project snapshot limit.

**Flow:** The caller creates, lists, rolls back, or deletes an instance snapshot.

**Outcome:** Snapshot ownership is scoped to the instance, long-running work is represented by an operation, and caller-supplied snapshot identity cannot access another instance.

### UC-008: Soft Delete an Instance

**Actor:** Tenant Developer

**Preconditions:** The instance is owned by the project.

**Flow:** The caller requests deletion. Access is detached, the IPv4 lease is released at the defined lifecycle point, and the provider resource is marked retained.

**Outcome:** The resource is no longer tenant-operable but remains available for administrative review during the retention window.

### UC-009: Purge a Retained Instance

**Actor:** Platform Administrator

**Preconditions:** Retention has elapsed, no workflow is active, database ownership exists, and live provider markers match the project and instance.

**Flow:** The administrator explicitly confirms purge.

**Outcome:** The owned provider resource is destroyed and the operation is auditable. Any ownership mismatch prevents destruction and enters manual review.

### UC-010: Detect and Classify Drift

**Actor:** Site Reliability Engineer

**Preconditions:** Desired state and provider observation exist.

**Flow:** Scheduled reconciliation compares instance identity, location, power, task, network, and existence facts.

**Outcome:** Drift is classified as benign, actionable, ambiguous, missing, or dangerous. Destructive correction is never automatic.

### UC-011: Recover Asynchronous Work

**Actor:** Site Reliability Engineer or Platform Administrator

**Preconditions:** Work is delayed, failed, duplicated, dead-lettered, or interrupted.

**Flow:** The operator follows the operation correlation chain, verifies ownership and provider state, then retries, replays, resumes, compensates, or sends the operation to manual review.

**Outcome:** Recovery is bounded, auditable, and does not create a second provider resource.

### UC-012: Observe Backpressure and Scaling

**Actor:** Site Reliability Engineer

**Preconditions:** A controlled load uses the fake provider.

**Flow:** Command rate creates Kafka lag. Dashboards show acknowledgement latency, outbox age, queue residence, lag, replica count, provider concurrency, and completion rate while KEDA adjusts orchestrator replicas.

**Outcome:** The backlog drains, the provider concurrency ceiling remains enforced, and saturation is visible before commands are lost.

### UC-013: Diagnose One Operation End to End

**Actor:** Site Reliability Engineer

**Preconditions:** An operation identifier or trace identifier is known.

**Flow:** The operator moves from an API span to database, outbox, Kafka, orchestration, provider, and projection spans, then pivots to correlated logs and metrics.

**Outcome:** The operator can identify where time was spent and which component owns the current state without searching by raw provider credentials or unbounded metric labels.

### UC-014: Accept a Command Through AWS

**Actor:** Platform Administrator

**Preconditions:** The sandbox AWS stack is deployed and the caller is authorized.

**Flow:** API Gateway invokes a command Lambda. One DynamoDB transaction stores aggregate and outbox items. DynamoDB Streams invokes a relay that publishes an idempotent message to SQS FIFO; timeout monitoring and audit archiving run independently.

**Outcome:** Duplicate stream records are harmless, partial batch failure retries only failed records, poison work reaches a dead-letter queue, and no long-running Proxmox task runs in Lambda.

## Capability Trace

| Use case | Capability basis | Primary safety controls |
| --- | --- | --- |
| UC-001 | SRC-003, SRC-004, NEW-001, NEW-002 | SAFE-001, SAFE-002, SAFE-003, SAFE-027 |
| UC-002 | SRC-002, SRC-007, SRC-008, SRC-009, SRC-023, SRC-025, NEW-003 through NEW-006 | SAFE-008 through SAFE-025 |
| UC-003 | SRC-022, SRC-023, NEW-006 | SAFE-014, SAFE-015, SAFE-017 through SAFE-022 |
| UC-004 | SRC-010, SRC-019, NEW-007 | SAFE-001, SAFE-004, SAFE-029 |
| UC-005 | SRC-012, SRC-024 | SAFE-008 through SAFE-010, SAFE-014 through SAFE-018 |
| UC-006 | SRC-014, SRC-015 | SAFE-010, SAFE-016, SAFE-026, SAFE-027 |
| UC-007 | SRC-016, SRC-024 | SAFE-001, SAFE-006, SAFE-008 through SAFE-010 |
| UC-008 | SRC-026 | SAFE-004, SAFE-023, SAFE-028 |
| UC-009 | SRC-030 | SAFE-004 through SAFE-007, SAFE-028 |
| UC-010 | SRC-019, SRC-035, SRC-039, SRC-040, NEW-007 | SAFE-018, SAFE-021, SAFE-029 |
| UC-011 | SRC-022 through SRC-025, SRC-031, SRC-038, NEW-003 through NEW-006 | SAFE-012 through SAFE-022, SAFE-031 through SAFE-034 |
| UC-012 | NEW-008 through NEW-012 | SAFE-030, SAFE-033, SAFE-034 |
| UC-013 | SRC-031, NEW-008, NEW-009 | SAFE-031 through SAFE-034 |
| UC-014 | NEW-013, NEW-014 | SAFE-008, SAFE-009, SAFE-017, SAFE-031, SAFE-035, SAFE-036 |

## Success Measures

These are acceptance targets until a measured report replaces them. They must not be presented as achieved results before evidence exists.

### Reliability

| ID | Target |
| --- | --- |
| SM-REL-001 | During a controlled 30-minute Kafka outage, every successfully acknowledged command remains durably represented and publishes after recovery. |
| SM-REL-002 | Replaying the same create command or Kafka event 100 times results in one instance aggregate and at most one provider resource. |
| SM-REL-003 | Killing the orchestrator during provider task polling resumes the stored task after restart without submitting the provider mutation again. |
| SM-REL-004 | A provider timeout with no conclusive observation enters manual review and never triggers an automatic duplicate create or purge. |
| SM-REL-005 | A failed create compensates only resources created by that workflow and preserves both the original and compensation outcomes. |
| SM-REL-006 | Dead-letter replay requires explicit authorization, is auditable, and remains idempotent. |

### Performance and Backpressure

| ID | Target |
| --- | --- |
| SM-PERF-001 | With the fake provider and 1,000 concurrent virtual users, command acknowledgement has p95 latency at or below 300 ms and a non-injected error rate below 1%. |
| SM-PERF-002 | A controlled ramp toward 2,000 virtual users identifies and records the first saturated component without exceeding the configured provider concurrency ceiling. |
| SM-PERF-003 | Kafka lag causes orchestrator scale-out from the configured minimum, and the backlog drains after input stops. Replica count never exceeds useful partition or provider limits. |
| SM-PERF-004 | The load report separates API acknowledgement latency, outbox delivery time, queue residence time, and end-to-end operation duration. |

### Operability

| ID | Target |
| --- | --- |
| SM-OPS-001 | Every accepted mutation returns an operation ID and stores correlation, causation, and trace context. |
| SM-OPS-002 | A sampled create operation can be followed across API, database, outbox, Kafka, orchestrator, provider, and projection spans. |
| SM-OPS-003 | Logs for a sampled operation are queryable by operation and trace identifiers and contain no credentials or cloud-init secrets. |
| SM-OPS-004 | Alerts exist for old outbox records, consumer lag, non-empty dead-letter queue, stuck operations, provider error ratio, Kafka replica health, and telemetry export failure. |
| SM-OPS-005 | Each alert used in the failure drills links to a runbook with verification and recovery steps. |
| SM-OPS-006 | Reconciliation detects an externally changed power state and a missing provider resource without performing a destructive correction. |

### Delivery, Security, and AWS

| ID | Target |
| --- | --- |
| SM-DEL-001 | A fresh Argo CD reconciliation can deploy the Kubernetes runtime from declarative state without workstation-side cluster mutation. |
| SM-DEL-002 | Application promotion uses immutable image digests and a reviewed change in the live repository. |
| SM-DEL-003 | No secret value or static AWS access key exists in either repository history. |
| SM-AWS-001 | Terraform creates and destroys the bounded AWS sandbox repeatably. |
| SM-AWS-002 | Duplicate DynamoDB Stream records do not create duplicate SQS commands. |
| SM-AWS-003 | Partial batch failure retries only unsuccessful stream records, and a poison record reaches the dead-letter queue. |
| SM-AWS-004 | DynamoDB point-in-time recovery, encryption, TTL where appropriate, log retention, alarms, tags, and a budget alarm are verifiable. |

## MVP Boundary

### Included

- The four Kubernetes deployables defined in the scope baseline
- One seeded lab project and project-scoped authorization
- One enabled Proxmox provider profile after the lab activation gate passes
- One Ubuntu 24.04 image, a small flavor set, and one IPv4 network
- REST and gRPC command and query interfaces
- Versioned Kafka command, event, audit, and dead-letter contracts
- Create, list, inspect, power, CPU/memory resize, disk growth, and snapshot lifecycle
- Operation history, progress, stable error categories, and manual-review state
- Transactional outbox, inbox deduplication, workflow checkpoints, bounded retry, compensation, and replay
- Soft deletion, retention, and guarded administrative purge
- Desired/observed reconciliation and non-destructive drift reporting
- OpenTelemetry, Prometheus, Tempo, Loki, Grafana, alerts, and runbooks
- KEDA Kafka-lag scaling with provider concurrency protection
- Fake-provider load and failure testing plus a small live-provider validation set
- The bounded AWS command, outbox, queue, watchdog, and audit slice

### Excluded From MVP

- Existing-VM adoption
- Backup lifecycle
- Browser console
- Node-local inventory agent
- Operator web interface
- IPv6
- A second real provider

These remain optional backlog items and do not block completion.

## Non-Goals

- Replacing Proxmox, Kubernetes, or an infrastructure-as-a-service suite
- Billing, pricing, invoicing, customer checkout, subscriptions, or payment collection
- Automatic node placement, scheduling optimization, or capacity forecasting
- VM live migration, storage balancing, or high-availability orchestration
- Hypervisor host, cluster, storage, bridge, SDN, VLAN, or physical network management
- LXC, bare-metal, GPU, PCI, USB, or passthrough provisioning
- Image construction or patch management
- Full tenant identity lifecycle or a custom identity provider
- A service mesh or mandatory internal mTLS for the lab
- Multi-region or multi-cluster active-active operation
- Running Proxmox provisioning inside Lambda
- Deploying EKS, MSK, Organizations, Control Tower, or Transit Gateway
- Claiming exactly-once message delivery
- Claiming production-grade status from controlled lab evidence

## Constraints and Assumptions

- The Kubernetes foundation, Gateway API, TLS termination, Argo CD, and Longhorn already exist and remain owned outside this repository.
- Runtime Kubernetes and AWS desired state is owned by the separate live repository.
- Kafka, PostgreSQL, KEDA, and the observability stack are deployed declaratively through that live repository.
- The MVP uses one Proxmox node, one image, one network, and a reserved VMID range to keep live testing bounded.
- High-volume tests use a deterministic fake provider. Real provider runs are explicitly capped.
- PostgreSQL is the authoritative Kubernetes data store. DynamoDB is an alternate adapter used only by the bounded AWS path.
- Delivery is at-least-once. Consumer idempotency is part of the product contract.
- External TLS uses the existing Gateway and certificate platform. Internal service-mesh security is outside scope.
- Actual provider endpoint, node, template, storage, bridge, subnet, and credential references must be supplied and verified before live writes are enabled.

## Risks and Product Responses

| Risk | Product response |
| --- | --- |
| Duplicate create after timeout | Persist provider task and ownership markers; reconcile unknown outcome before retry |
| Kafka outage | Commit intent and outbox atomically; publish after recovery |
| Consumer crash | Persist inbox and workflow checkpoint; resume instead of resubmit |
| Provider overload during KEDA scale-out | Enforce provider concurrency independently of replica count |
| IP collision | Unique lease plus provider observation immediately before network mutation |
| Destructive drift correction | Report drift only; require explicit administrative action |
| Accidental purge of unrelated VM | Require VMID range, database ownership, and live marker match |
| Telemetry cardinality explosion | Keep entity identifiers out of metric labels and use trace/log fields instead |
| Secret leakage | Redaction tests and prohibition of secrets in events, telemetry, and source control |
| AWS scope expansion | Keep the serverless path to command acceptance, publication, timeout, and audit |

## MVP Completion Conditions

The MVP is complete only when:

1. Every included use case has approved contracts, authorization, idempotency, failure behavior, telemetry, tests, and an operator recovery path.
2. All safety invariants applicable to a mutating capability have automated evidence.
3. Broker outage, duplicate delivery, worker termination, provider timeout, database failover, drift, dead-letter replay, and telemetry outage drills have recorded results.
4. Load results distinguish acknowledgement, publication, queue, provider, and completion latency.
5. A complete create trace and its correlated logs are captured.
6. Argo CD deployment, KEDA scaling, dashboards, alerts, and the AWS sandbox are reproducible from their authoritative repositories.
7. Known limitations and unmeasured targets remain explicit.
