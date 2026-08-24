# Threat Model

## Document Control

| Field | Value |
| --- | --- |
| Scope | Kubernetes control plane, Proxmox provider boundary, delivery path, observability stack, and bounded AWS reference slice |
| Method | Asset and trust-boundary review using STRIDE categories |
| Review trigger | Contract, trust boundary, credential scope, destructive workflow, or external dependency change |
| Related boundary register | [Trust Boundaries](trust-boundaries.md) |

## Security Objectives

1. A tenant can observe and mutate only resources authorized to its project.
2. An accepted command is durable, attributable, idempotent, and recoverable without creating duplicate provider resources.
3. Only allowlisted, positively owned lab resources can be mutated or purged.
4. Credentials and sensitive initialization data do not cross into contracts, events, telemetry, or source control.
5. Compromise of one deployable does not automatically grant every control-plane, provider, cluster, or AWS capability.
6. Administrative recovery remains explicit, reviewed, and auditable.

## Protected Assets

| ID | Asset | Required property |
| --- | --- | --- |
| AST-01 | Tenant identity, roles, and project membership | Authenticity and authorization integrity |
| AST-02 | Instance desired state, observed state, operations, and retention state | Integrity, availability, and attribution |
| AST-03 | Idempotency records, workflow leases, inbox receipts, checkpoints, and outbox records | Integrity and durable uniqueness |
| AST-04 | IPv4 leases and provider VMID allocation | Exclusive ownership and recoverability |
| AST-05 | Proxmox endpoint, credential, task reference, and ownership markers | Confidentiality and integrity |
| AST-06 | Kafka commands, events, dead-letter work, and replay history | Integrity, ordering identity, and bounded availability |
| AST-07 | Audit records and administrative reasons | Immutability, attribution, retention, and availability |
| AST-08 | Source, image artifacts, GitOps desired state, and CI identity | Provenance and integrity |
| AST-09 | Logs, metrics, traces, dashboards, and alerts | Confidentiality, integrity, and operational availability |
| AST-10 | AWS IAM roles, DynamoDB command state, Streams, SQS, and S3 archive | Least privilege, integrity, and recoverability |

## Threat Register

Risk is qualitative for the MVP lab: `High` can violate ownership or cause destructive provider action; `Medium` can corrupt control-plane behavior or materially reduce detection; `Low` has bounded effect under current scope.

| ID | STRIDE | Scenario and impact | Principal controls | Detection and evidence | Residual risk |
| --- | --- | --- | --- | --- | --- |
| THR-001 | Spoofing | A forged or replayed token is accepted as a tenant or administrator. | Validate signature, issuer, audience, expiry, and role claims at TB-03; short token lifetime; strong administrator authentication. | Authentication failure metrics and negative token tests. | Medium |
| THR-002 | Elevation | A valid tenant changes a project identifier to access another project's instances or operations. | Resolve target ownership from durable state; project authorization on every read and mutation; deny-by-default roles. | Cross-project API test suite and attributed denial logs. | High |
| THR-003 | Tampering | An idempotency key is reused with a different request to redirect a prior operation. | Bind key to actor, project, action, target, and canonical request hash; reject mismatch transactionally. | Conflict metric and canonicalization tests. | Low |
| THR-004 | Denial of service | Oversized requests, unbounded keys, or high-cardinality fields exhaust API, Kafka, or telemetry resources. | Gateway throttles, payload and header limits, bounded identifiers, event-size limits, bounded metric attributes. | Rejection metrics, cardinality alerts, and load tests. | Medium |
| THR-005 | Tampering | A caller supplies a Proxmox node, template, storage, bridge, VMID, or endpoint outside the lab boundary. | Provider-neutral contracts; server-side catalog resolution; disabled-by-default provider profiles and exact allowlists. | Validation tests and provider activation record. | High |
| THR-006 | Elevation | A compromised API or Orchestrator calls Proxmox directly with broad credentials. | Only Provider workload receives the secret and network route; distinct service identities; direct egress denied. | Secret-mount audit and network-policy connectivity test. | High |
| THR-007 | Information disclosure | Provider credentials, SSH private material, cloud-init data, console tickets, or headers appear in events or telemetry. | Allowlist contract fields; structured redaction at source and collector; no secret-bearing outbox columns; repository scanning. | Redaction tests, telemetry sampling, and secret scan. | High |
| THR-008 | Tampering | A forged or malformed Kafka command invokes an unauthorized or incompatible handler. | Topic ACLs, producer identity, envelope and major-version validation, project/aggregate checks, payload limits. | Unsupported-version and unauthorized-producer tests. | Medium |
| THR-009 | Tampering | Duplicate or reordered messages repeat provider actions. | Stable event IDs, instance partition key, durable inbox, operation lease, persisted checkpoints and task references. | Duplicate-delivery and ordering tests; duplicate-suppression metric. | Medium |
| THR-010 | Repudiation | A dead-letter replay or destructive operation cannot be tied to an administrator and reason. | Authenticated admin role, reason requirement, preserved causation, append-only audit entry. | Replay/purge audit query and negative authorization tests. | Medium |
| THR-011 | Tampering | Two workers concurrently mutate one instance after a lease race or stale lease takeover. | Database-enforced lease uniqueness, fencing token or version, bounded lease, checkpoint transaction, provider concurrency ceiling. | Concurrency integration tests and lease-conflict metric. | High |
| THR-012 | Tampering | An outbox or inbox status is marked complete without the associated domain transition. | Same-database atomic transaction for domain state, receipt/checkpoint, and emitted outbox records; constrained state transitions. | Transaction rollback and crash-point tests. | Medium |
| THR-013 | Denial of service | Kafka outage grows the PostgreSQL outbox until storage or replication capacity is exhausted. | Capacity thresholds, WAL/slot monitoring, old-outbox alert, admission protection, recovery runbook. | Outbox age/size and replication-lag alerts; outage drill. | Medium |
| THR-014 | Tampering | Provider timeout is blindly retried and creates a second VM. | Treat timeout as unknown, persist task reference before polling, query task and ownership markers, reconcile or require review. | Timeout/late-success failure test and duplicate-resource check. | High |
| THR-015 | Elevation | A foreign VM is adopted because its name, IP address, node, or VMID resembles a managed instance. | Require full immutable ownership marker set; never infer ownership from mutable attributes; ambiguous state enters review. | Foreign-resource reconciliation test. | High |
| THR-016 | Tampering | A forged ownership marker causes a foreign VM to be deleted during compensation or purge. | Require database ownership plus matching live markers, allowed VMID range, workflow provenance, retention eligibility, and no active lease. | Pre-delete decision audit and mismatch tests. | High |
| THR-017 | Tampering | Concurrent allocation gives the same IPv4 address or VMID to two instances. | Database uniqueness, transactional allocation, provider collision observation immediately before mutation, quarantine on ambiguity. | Allocation-race tests and collision alert. | High |
| THR-018 | Elevation | Provider adapter parameters enable host, cluster, network, storage, or identity administration outside MVP scope. | Narrow provider-neutral interface; least-privilege Proxmox role; allowlisted methods and values; prohibited operations absent from contracts. | Provider contract review and permission-denial canary. | High |
| THR-019 | Denial of service | Kafka lag drives KEDA replicas beyond provider or database capacity. | Separate provider semaphore, consumer replica ceiling, partition-aware scaling, database connection budget, backpressure. | Lag, saturation, provider concurrency, and pool metrics. | Medium |
| THR-020 | Tampering | Reconciliation overwrites desired state or automatically destroys a resource to remove drift. | Separate desired and observed ownership; non-destructive reconciliation; explicit admin workflow for purge and recovery. | Drift tests and review-item audit. | High |
| THR-021 | Information disclosure | Trace propagation accepts arbitrary baggage or records secret query/header values. | Allowlisted propagation fields, baggage limits, HTTP/gRPC semantic sanitization, collector redaction. | Trace-content tests and attribute-count alerts. | Medium |
| THR-022 | Denial of service | Telemetry backend outage blocks commands or provisioning. | Asynchronous bounded exporter queues, finite timeouts, fail-open telemetry, local dropped-export signal. | Collector/backend outage drill. | Low |
| THR-023 | Tampering | A malicious dependency or image reaches the cluster. | Lockfile, dependency and image scanning, build provenance, immutable digest promotion, protected live-repository review. | CI policy results, attestation, and deployed-digest verification. | Medium |
| THR-024 | Elevation | Argo CD or a live-repository change grants workloads broader cluster or secret access. | Scoped Argo project, protected changes, least-privilege service accounts, policy checks, no secret values in Git. | GitOps review evidence and RBAC diff checks. | High |
| THR-025 | Elevation | An AWS Lambda role can mutate unrelated tables, queues, buckets, or account resources. | One role per function, resource-level IAM, permission boundaries where available, explicit deny for unneeded actions. | IAM policy analysis and negative API tests. | High |
| THR-026 | Tampering | DynamoDB Streams retries publish duplicate logical commands to SQS. | Stable event identity, FIFO deduplication ID, conditional relay marker or deterministic idempotency, partial batch response. | Duplicate-stream integration test and deduplication metric. | Medium |
| THR-027 | Denial of service | One poison stream or SQS record repeatedly fails an entire batch. | Per-record validation, partial batch response, bounded retry, DLQ, authorized audited redrive. | Iterator age, receive count, and DLQ alarms. | Medium |
| THR-028 | Tampering | Watchdog races a late completion and incorrectly overwrites a terminal operation. | Conditional DynamoDB update on expected pending state and version; terminal states are immutable. | Race test and failed-condition metric. | Low |
| THR-029 | Information disclosure | S3 audit objects or CloudWatch logs expose tenant or credential material. | Data minimization, encryption, block public access, scoped IAM, log retention, redaction, no sensitive message bodies. | Access analysis, bucket-policy checks, and content sampling. | High |
| THR-030 | Repudiation | Audit history can be silently rewritten or removed by an application identity. | Append-only application path; separate archive writer; application lacks delete permission; retention and integrity metadata. | Delete-denial test and archive continuity check. | Medium |

## Abuse Cases Requiring Explicit Tests

1. A tenant uses another project's instance ID in read, power, snapshot, resize, and delete requests.
2. A caller changes a request body while retaining the same idempotency key.
3. A Kafka producer submits an unsupported schema version, an oversized payload, and a project/aggregate mismatch.
4. Two consumers attempt the same event and the same instance operation concurrently.
5. A Proxmox create call times out before its task reference reaches the caller, then later succeeds.
6. A provider VM in the VMID range has missing, partial, conflicting, or copied ownership markers.
7. Purge is requested before retention, during an active workflow, and against ambiguous observed state.
8. Telemetry is supplied with authorization headers, private initialization data, arbitrary baggage, and high-cardinality identifiers.
9. A DynamoDB stream batch contains successful, duplicate, malformed, and transiently failing records together.
10. A compromised workload attempts direct Proxmox, Kubernetes API, unrelated PostgreSQL schema, and public-internet access.

## Assumptions and Residual Risk

- The existing cluster foundation, identity provider, Gateway API, secret delivery mechanism, and Proxmox installation are administered as trusted dependencies. Their configuration is still verified at the interfaces this system uses.
- The lab is not a public multi-tenant commercial cloud. The project model demonstrates tenant isolation, but regulatory certification, payment data, and hostile code isolation are outside the MVP.
- Proxmox metadata is not cryptographically bound to a VM. Database ownership plus live markers and strict allowlists reduce risk; ambiguous destructive action always requires manual review.
- At-least-once transport means duplicates remain possible at every asynchronous boundary. Correctness depends on the durable idempotency, inbox, lease, checkpoint, and conditional-write controls rather than broker delivery claims.
- Denial of service against the shared physical lab cannot be eliminated. Admission, quotas, concurrency limits, load caps, and cost alarms bound the experiment.

## Review Gate

Phase 2 implementation cannot mark a mutating capability complete until its tests cover the applicable threat rows, safety invariants, and trust boundaries. A new data store, broker, external API, credential, or destructive action requires updating this model before merge.
