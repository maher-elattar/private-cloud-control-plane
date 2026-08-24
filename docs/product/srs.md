# Software Requirements Specification

## Document Control

| Field | Value |
| --- | --- |
| System | Private Cloud Control Plane |
| Version | 0.1 |
| Status | Baseline for architecture and contract design |
| Normative language | `must`, `must not`, `should`, and `may` are intentional |
| Related product definition | [Product Requirements Document](prd.md) |
| Scope authority | [Scope Baseline](scope-baseline.md) |

## Purpose

This specification defines externally observable behavior and quality constraints for the MVP. It is intentionally independent of controller, database library, Kafka client, and Proxmox SDK choices. Architecture decisions allocate these requirements to deployables and technologies in separate records.

## System Boundary

The system begins at the public REST and gRPC interfaces and ends at:

- The provider-neutral gRPC boundary implemented by the Proxmox adapter
- The Kafka command and event interfaces consumed and produced by control-plane workloads
- The PostgreSQL source of truth and derived projections
- The OpenTelemetry export boundary
- The bounded AWS command-ingress and event-publication path

The Kubernetes foundation, hypervisor host lifecycle, commercial systems, and tenant workloads inside provisioned VMs are external to the system.

## Actors and External Systems

| ID | Actor or system | Relationship |
| --- | --- | --- |
| ACT-001 | Tenant Developer | Submits and reads project-scoped instance operations |
| ACT-002 | Platform Administrator | Manages catalog and provider profiles, recovery, retention, and purge |
| ACT-003 | Site Reliability Engineer | Observes, diagnoses, and recovers distributed workflows |
| EXT-001 | Identity Provider | Supplies authenticated identity and claims; implementation is outside the MVP |
| EXT-002 | Proxmox VE | First compute provider; all access passes through the provider adapter |
| EXT-003 | Kafka | Durable asynchronous command and event transport |
| EXT-004 | PostgreSQL | Kubernetes control-plane source of truth |
| EXT-005 | Observability Backends | Prometheus, Tempo, Loki, and Grafana receive or query telemetry |
| EXT-006 | AWS | Hosts the bounded API Gateway, Lambda, DynamoDB, SQS, S3, KMS, and CloudWatch slice |

## Definitions

| Term | Definition |
| --- | --- |
| Desired state | State requested and accepted by the control plane |
| Observed state | Latest provider state obtained through the provider boundary |
| Operation | Durable record of one requested mutation and its progress/outcome |
| Command | Versioned instruction for asynchronous workflow execution |
| Event | Versioned statement that a domain or operation fact occurred |
| Outbox | Records written atomically with domain state and published asynchronously |
| Inbox receipt | Consumer-side record proving an event ID has already been handled |
| Unknown outcome | Provider call may have succeeded, but the control plane cannot yet prove success or failure |
| Manual review | Terminal workflow classification requiring an authorized operator decision |
| Provider profile | Server-side allowlist and credential reference for one provider target |

## Functional Requirements

### Identity, Projects, and Authorization

| ID | Requirement |
| --- | --- |
| SRS-FR-001 | The system must require an authenticated identity for every non-health endpoint. |
| SRS-FR-002 | The system must authorize every read and mutation against a project and an explicit role. |
| SRS-FR-003 | A Tenant Developer must be unable to read or mutate resources belonging only to another project. |
| SRS-FR-004 | Only a Platform Administrator may create or modify catalog entries, provider profiles, retention policy, replay requests, or purge requests. |
| SRS-FR-005 | The system must record the authenticated actor, project, action, target, request outcome, and operation ID for every mutation. |
| SRS-FR-006 | The MVP must provide one seeded project named `lab-sandbox`; the domain must permit additional projects without changing provider contracts. |

### Catalog, Provider Profiles, and Quotas

| ID | Requirement |
| --- | --- |
| SRS-FR-007 | The system must expose project-visible image, flavor, and network catalog queries using provider-neutral identifiers. |
| SRS-FR-008 | An image must map server-side to an enabled provider profile and an allowlisted provider template. |
| SRS-FR-009 | A flavor must define CPU, memory, and minimum disk values and must not expose provider configuration fields. |
| SRS-FR-010 | A network must define an IPv4 pool, prefix, gateway, DNS configuration, and allocation exclusions. |
| SRS-FR-011 | A provider profile must remain mutation-disabled until its endpoint, cluster, node, template, storage, bridge, VMID range, network, and credential reference pass the lab activation gate. |
| SRS-FR-012 | The system must reject a requested mutation that exceeds project instance, CPU, memory, disk, IPv4, or snapshot quota before a provider mutation occurs. |
| SRS-FR-013 | Caller-supplied provider node, template, storage, bridge, VMID, endpoint, or credential values must never override catalog or provider-profile values. |

### Command Acceptance and Operation Tracking

| ID | Requirement |
| --- | --- |
| SRS-FR-014 | Every mutation request must include an idempotency key. |
| SRS-FR-015 | The system must bind an idempotency key to the actor, project, operation type, target aggregate, and canonical request hash. |
| SRS-FR-016 | Repeating a request with the same idempotency scope and canonical body must return the original operation without creating new work. |
| SRS-FR-017 | Reusing an idempotency key with a different canonical request must return a conflict and create no work. |
| SRS-FR-018 | Every accepted mutation must create a durable operation before acknowledging the request. |
| SRS-FR-019 | A successful command-acceptance response must contain an operation ID, target resource ID, acceptance timestamp, and operation-status location. |
| SRS-FR-020 | Command acceptance must not wait for Kafka publication, orchestrator execution, or provider completion. |
| SRS-FR-021 | A caller must be able to read one operation and list operations for an authorized project or instance. |
| SRS-FR-022 | An operation response must expose state, requested action, target, progress stage, accepted/start/update/completion timestamps, safe error category, and manual-review status. |
| SRS-FR-023 | Administrative operation views must expose correlation, causation, retry, checkpoint, dead-letter, and provider-task references without exposing credentials. |

### Instance Creation and IPv4 Allocation

| ID | Requirement |
| --- | --- |
| SRS-FR-024 | A create request must accept a project, provider-neutral image, flavor, network, hostname, and optional supported SSH public keys. |
| SRS-FR-025 | The create acceptance transaction must atomically persist the instance desired state, operation, idempotency record, and outbox record. |
| SRS-FR-026 | The system must allocate at most one IPv4 lease to an instance using a uniqueness constraint and transactional ownership update. |
| SRS-FR-027 | The allocator must exclude network, broadcast, gateway, reserved, out-of-pool, and actively leased addresses. |
| SRS-FR-028 | The workflow must revalidate IPv4 availability against authoritative leases and current provider observation immediately before writing provider network configuration. |
| SRS-FR-029 | The provider workflow must create a full clone from the server-side allowlisted template inside the configured VMID range. |
| SRS-FR-030 | The provider workflow must apply flavor CPU, memory, minimum disk, the allowlisted bridge, one IPv4 configuration, DNS settings, hostname, and accepted SSH keys. |
| SRS-FR-031 | The workflow must add immutable control-plane ownership markers containing environment, project ID, instance ID, and create-operation ID. |
| SRS-FR-032 | The workflow must persist the returned provider task reference before polling or waiting for that task. |
| SRS-FR-033 | A successful create workflow must update observed state and complete the operation only after provider observation proves the owned VM exists with the accepted identity. |
| SRS-FR-034 | A create failure before provider mutation must release any lease created by that failed workflow and must not call provider cleanup. |
| SRS-FR-035 | A create failure after proven provider creation must attempt compensation only for the resource created by the current workflow. |
| SRS-FR-036 | If provider creation may have succeeded but ownership or outcome cannot be proven, the operation must enter unknown-outcome reconciliation or manual review and must not submit another create automatically. |

### Instance Query and Lifecycle

| ID | Requirement |
| --- | --- |
| SRS-FR-037 | An authorized caller must be able to list project instances and read one instance by provider-neutral ID. |
| SRS-FR-038 | An instance response must distinguish desired state, observed state, lifecycle state, IPv4 lease, active operation, last reconciliation, and drift classification. |
| SRS-FR-039 | The system must support asynchronous start, graceful shutdown, stop, and reboot operations. |
| SRS-FR-040 | A power request already satisfied by verified observed state may complete as an idempotent no-op. |
| SRS-FR-041 | The system must support asynchronous CPU and memory resize within the selected flavor and project quota rules. |
| SRS-FR-042 | The system must support disk growth up to the project and provider-profile limit. |
| SRS-FR-043 | The system must reject disk shrink before publishing a provider command. |
| SRS-FR-044 | At most one mutating workflow may hold the operation lease for an instance at a time. |
| SRS-FR-045 | A conflicting mutation must be rejected or remain unstarted until the existing instance workflow reaches a safe release point. |

### Snapshot Lifecycle

| ID | Requirement |
| --- | --- |
| SRS-FR-046 | The system must support listing snapshots for an authorized instance. |
| SRS-FR-047 | The system must support asynchronous snapshot creation within the project snapshot quota. |
| SRS-FR-048 | The system must support asynchronous rollback to a snapshot owned by the target instance. |
| SRS-FR-049 | The system must support asynchronous deletion of a snapshot owned by the target instance. |
| SRS-FR-050 | Snapshot identifiers received from callers must be validated and resolved through instance ownership before a provider mutation. |

### Soft Delete, Retention, and Purge

| ID | Requirement |
| --- | --- |
| SRS-FR-051 | A normal delete request must transition an instance into a retained lifecycle and must not destroy the provider VM. |
| SRS-FR-052 | Soft deletion must revoke tenant mutation access, disable automatic start where supported, mark provider metadata as retained, and release or quarantine the IPv4 lease according to the recorded lifecycle stage. |
| SRS-FR-053 | The system must expose the retention deadline and purge eligibility to authorized administrators. |
| SRS-FR-054 | Only an explicit administrative purge operation may destroy a normally retained VM. |
| SRS-FR-055 | Purge must verify database ownership, provider ownership markers, VMID range, retention eligibility, and absence of active workflows immediately before provider deletion. |
| SRS-FR-056 | Any purge ownership mismatch or ambiguous provider result must prevent deletion and enter manual review. |

### Messaging, Delivery, and Workflow Recovery

| ID | Requirement |
| --- | --- |
| SRS-FR-057 | The system must publish committed outbox records to a versioned Kafka command topic without requiring the accepting API process to contact Kafka. |
| SRS-FR-058 | Each message envelope must contain event ID, schema name and version, aggregate ID, project ID, operation ID, correlation ID, causation ID, occurrence time, trace context, and typed payload. |
| SRS-FR-059 | Commands for the same instance must use the same partition key to preserve their relative Kafka order. |
| SRS-FR-060 | Each consumer must durably record an inbox receipt keyed by event ID before reporting successful handling. |
| SRS-FR-061 | Reprocessing a received event whose inbox outcome is complete must not repeat domain or provider side effects. |
| SRS-FR-062 | The orchestrator must persist workflow stage, attempt count, provider task reference, next action time, and last classified outcome at every external side-effect boundary. |
| SRS-FR-063 | After restart, the orchestrator must resume from the last safe checkpoint and must not repeat a completed provider mutation. |
| SRS-FR-064 | Failures must be classified as validation, authorization, conflict, transient, permanent, unknown outcome, compensation failure, or manual review. |
| SRS-FR-065 | Transient retries must be bounded by attempts and elapsed time and must use backoff with jitter. |
| SRS-FR-066 | Exhausted or poison work must enter a versioned dead-letter topic with the original event identity and failure context. |
| SRS-FR-067 | Administrative replay must require authorization, preserve the original event identity and causation chain, and record the replay actor and reason. |
| SRS-FR-068 | Domain and operation events must update project-readable instance and operation projections idempotently. |

### Reconciliation

| ID | Requirement |
| --- | --- |
| SRS-FR-069 | The reconciler must periodically read observed state for managed instances through the provider-neutral interface. |
| SRS-FR-070 | Reconciliation must classify missing resource, identity mismatch, stale provider task, late success, power drift, network drift, and ambiguous provider state. |
| SRS-FR-071 | Reconciliation must update observed state and drift records without overwriting desired state. |
| SRS-FR-072 | Reconciliation may complete an unknown operation only when observed ownership and state prove the intended result. |
| SRS-FR-073 | Reconciliation must not automatically destroy, shrink, detach, overwrite, or adopt a provider resource. |
| SRS-FR-074 | Dangerous or ambiguous drift must create an operator-visible manual-review item linked to the instance and operation. |

### Observability, Health, and Scaling

| ID | Requirement |
| --- | --- |
| SRS-FR-075 | REST, gRPC, database, outbox, Kafka, orchestration, provider, projection, and reconciliation work must emit OpenTelemetry telemetry at their boundaries. |
| SRS-FR-076 | Trace context must propagate through HTTP or gRPC, persisted outbox metadata, Kafka headers or envelope, orchestrator checkpoints, and provider calls. |
| SRS-FR-077 | Structured logs must include service, environment, severity, trace ID, span ID, operation ID, and applicable instance and provider-task IDs. |
| SRS-FR-078 | The system must expose API request, operation, provider, outbox, Kafka, retry, dead-letter, checkpoint, reconciliation, autoscaling, and telemetry-export metrics. |
| SRS-FR-079 | The system must expose liveness and readiness endpoints that distinguish process health from dependency readiness. |
| SRS-FR-080 | The deployment must scale orchestrator consumers from Kafka lag while respecting partition usefulness and a separate provider concurrency ceiling. |
| SRS-FR-081 | The system must provide alert inputs for old outbox work, high lag or queue residence, non-empty dead letter, stuck operation, provider error ratio, Kafka replica health, and telemetry export failure. |

### AWS Reference Slice

| ID | Requirement |
| --- | --- |
| SRS-FR-082 | The AWS command endpoint must accept the same provider-neutral command identity, idempotency, operation, correlation, and event-envelope concepts as the Kubernetes path. |
| SRS-FR-083 | Command acceptance must use one DynamoDB transaction to persist aggregate or operation state and an explicit outbox item. |
| SRS-FR-084 | DynamoDB Streams must invoke a relay that publishes outbox work to SQS FIFO using a stable deduplication and ordering identity. |
| SRS-FR-085 | The stream relay must treat duplicate records as harmless and must not publish duplicate logical commands. |
| SRS-FR-086 | The stream relay must support partial batch failure so successful records are not retried with failed records. |
| SRS-FR-087 | Poison SQS work must reach a dead-letter queue and support an authorized, audited redrive. |
| SRS-FR-088 | A scheduled watchdog must identify operations that exceed their allowed pending duration and record a timeout outcome without running Proxmox work. |
| SRS-FR-089 | Audit records must be archivable to encrypted S3 storage with an explicit lifecycle policy. |
| SRS-FR-090 | The AWS slice must expose CloudWatch logs, metrics, alarms, and a dashboard for acceptance, relay, retry, timeout, and dead-letter behavior. |
| SRS-FR-091 | No AWS Lambda function in the MVP may execute long-running Proxmox provisioning. |

## Non-Functional Requirements

### Reliability and Consistency

| ID | Requirement |
| --- | --- |
| SRS-NFR-001 | No command whose acceptance transaction committed may be lost during Kafka unavailability. |
| SRS-NFR-002 | The API must remain able to accept commands while Kafka is unavailable, subject to PostgreSQL availability and explicit outbox capacity protection. |
| SRS-NFR-003 | The system must make no exactly-once delivery claim; correctness must tolerate at-least-once publication and consumption. |
| SRS-NFR-004 | Replaying one create request or event 100 times must result in one instance aggregate and at most one provider VM. |
| SRS-NFR-005 | Killing an orchestrator while it polls a provider task must permit another instance to resume the stored task without resubmission. |
| SRS-NFR-006 | Database transactions must preserve invariants across instance state, operations, idempotency, outbox, inbox, leases, and checkpoints. |
| SRS-NFR-007 | Dependency timeouts must be finite and explicitly configured; an unbounded provider or database wait is prohibited. |
| SRS-NFR-008 | Clock-based durations must use UTC instants and monotonic process timers where applicable; ordering correctness must not depend on synchronized wall clocks alone. |

### Performance and Backpressure

| ID | Requirement |
| --- | --- |
| SRS-NFR-009 | Under the defined fake-provider test with 1,000 concurrent virtual users, command acknowledgement p95 must be at most 300 ms with a non-injected error rate below 1%. |
| SRS-NFR-010 | Testing must ramp toward 2,000 virtual users and record the first saturated component rather than assuming the target is sustainable. |
| SRS-NFR-011 | Command request bodies and event payloads must have explicit size limits; cloud-init secrets or large binary content must not be placed on Kafka. |
| SRS-NFR-012 | Provider concurrency must remain bounded even when Kafka partitions and KEDA permit more consumer replicas. |
| SRS-NFR-013 | Performance reporting must separate API acknowledgement, outbox delivery, queue residence, provider execution, and end-to-end operation duration. |

### Security and Privacy

| ID | Requirement |
| --- | --- |
| SRS-NFR-014 | External API traffic must use the existing trusted TLS termination path. |
| SRS-NFR-015 | Service accounts, provider credentials, database roles, Kafka principals, and AWS roles must have least privilege for their assigned boundary. |
| SRS-NFR-016 | Provider profiles with missing or ambiguous allowlist configuration must fail closed. |
| SRS-NFR-017 | Credentials, private keys, cloud-init secrets, authorization headers, console tickets, and session material must not appear in API responses, Kafka messages, logs, traces, metrics, dashboards, or repository history. |
| SRS-NFR-018 | Tenant-safe error responses must be bounded, redacted, and based on stable error categories. |
| SRS-NFR-019 | Administrative recovery and destructive requests must be attributable to an authenticated actor and retained in the audit history. |
| SRS-NFR-020 | CI and hybrid AWS access must use short-lived identity; static AWS access keys are prohibited. |

### Observability and Operability

| ID | Requirement |
| --- | --- |
| SRS-NFR-021 | Every accepted mutation and provider operation must be correlated with an operation ID and trace ID. |
| SRS-NFR-022 | Metrics must use bounded labels; project, instance, operation, task, IP, and raw exception values must not be labels. |
| SRS-NFR-023 | OpenTelemetry Collector or backend unavailability must not prevent command acceptance or provider workflow progress. |
| SRS-NFR-024 | Telemetry export failures must be observable locally through bounded logs and metrics. |
| SRS-NFR-025 | Every actionable alert included in the MVP must link to a versioned runbook. |
| SRS-NFR-026 | Failure and load reports must contain measured results and must distinguish targets from achieved values. |

### Maintainability and Compatibility

| ID | Requirement |
| --- | --- |
| SRS-NFR-027 | Core domain and public contracts must compile and test without importing Proxmox-specific types or libraries. |
| SRS-NFR-028 | REST, gRPC, and event contracts must be versioned and checked for incompatible change in continuous integration. |
| SRS-NFR-029 | Consumers must reject unsupported major schema versions and tolerate documented additive fields in supported versions. |
| SRS-NFR-030 | Each mutating capability must have unit, contract, integration, duplicate-delivery, failure, telemetry, and recovery coverage appropriate to its boundary. |
| SRS-NFR-031 | Architecture decisions, contracts, diagrams, runbooks, and security documentation must change in the same review as behavior they describe. |

### Deployment, Recovery, and Cost

| ID | Requirement |
| --- | --- |
| SRS-NFR-032 | Kubernetes and AWS runtime changes must be declarative, source controlled, reviewed, repeatable, and followed by recorded verification. |
| SRS-NFR-033 | Application promotion must use immutable image digests through the live GitOps repository; workstation deployment is not an MVP delivery path. |
| SRS-NFR-034 | Kubernetes workloads must define resource requests, limits, disruption behavior, and failure-domain placement appropriate to their statefulness. |
| SRS-NFR-035 | The bounded AWS slice must be reproducibly creatable and destroyable with Terraform. |
| SRS-NFR-036 | AWS resources must use encryption, log retention, recovery settings, cost-allocation tags, and a budget alarm appropriate to the sandbox. |
| SRS-NFR-037 | Recovery drills must cover Kafka outage, duplicate event, orchestrator loss, provider timeout and late success, database failover, drift, telemetry outage, and dead-letter replay. |
| SRS-NFR-038 | High-load validation must use the fake provider; a live-provider run must never exceed the recorded cap in the lab boundary. |

## Allocated Architecture Constraints

These are implementation allocations, not user-facing product behavior. They require accepted architecture decisions before implementation.

| ID | Constraint |
| --- | --- |
| SRS-ARC-001 | The Kubernetes control-plane source of truth is PostgreSQL. |
| SRS-ARC-002 | Kafka command publication uses a PostgreSQL transactional outbox captured by Debezium. |
| SRS-ARC-003 | Kafka provides at-least-once transport; consumer inbox records provide deduplication. |
| SRS-ARC-004 | The system has four Kubernetes deployables: Control API, Provisioning Orchestrator, Proxmox Provider, and Reconciler. |
| SRS-ARC-005 | Placement is explicit through provider profiles and catalog mappings; automatic placement scoring is excluded. |
| SRS-ARC-006 | Normal deletion is soft deletion followed by retention and explicit guarded purge. |
| SRS-ARC-007 | Reconciliation is non-destructive by default. |
| SRS-ARC-008 | DynamoDB is an alternate command-store port used only by the bounded AWS slice. |
| SRS-ARC-009 | The AWS slice ends at reliable command publication, timeout handling, audit, and an optional bridge; it does not duplicate the full Kubernetes control plane. |

## Acceptance Evidence

A requirement is not considered verified by implementation alone. Evidence must be retained as applicable through:

- Contract compatibility reports
- Unit and integration test results
- Deterministic fake-provider scenarios
- Controlled live-provider verification
- Kafka outage and duplicate-delivery results
- Trace, log, metric, dashboard, and alert captures
- KEDA scaling evidence
- Argo CD reconciliation evidence
- Terraform plan/apply/destroy evidence
- Load and resilience reports
- Versioned recovery runbooks
