# Data Ownership Map

## Purpose

This map defines which deployable may author each category of durable state. PostgreSQL is physically shared in the MVP to keep operations bounded, but schemas, roles, migrations, and write authority remain logically separated. Shared storage does not imply shared ownership.

## Ownership Principles

1. Every record and mutable field has one authoritative writer.
2. Another deployable may consume an API, event, or read model; it does not update the owner's tables directly.
3. Cross-owner state changes use versioned commands or events, not joins followed by foreign writes.
4. A local transaction may update only one owner's domain state plus that owner's inbox, checkpoint, and outbox records.
5. Desired state and observed state have different owners and are never collapsed into one ambiguous status field.
6. Credentials are referenced by name; no application-owned table or message stores secret values.
7. The AWS reference slice is a separate persistence implementation, not a second writer for Kubernetes aggregates.

## PostgreSQL Logical Schemas

| Schema | Authoritative deployable | Owned records | Other access |
| --- | --- | --- | --- |
| `control` | Control API | Projects, memberships or external subject mappings, catalog, provider-profile metadata, quotas, instance desired state, lifecycle and retention intent, top-level operations, idempotency records, IPv4 leases, API audit entries, transactional outbox | Orchestrator reads immutable accepted-command inputs through Kafka; Reconciler reads instance identity and ownership scope through a restricted view |
| `workflow` | Provisioning Orchestrator | Consumer inbox, instance workflow leases and fencing versions, workflow checkpoints, attempts, retry schedule, provider task references, classified outcomes, compensation records, dead-letter metadata, workflow outbox | Control API reads no workflow tables directly; operation details are received through projection events or a read-only administrative view if explicitly approved |
| `observation` | Reconciler | Provider observations, drift records, reconciliation cursors, unknown-outcome evidence, manual-review items, reconciliation outbox | Control API consumes observation events into projections; Orchestrator may consume a resolved-outcome event |
| `projection` | Control API | Project-readable instance, operation, drift, and snapshot views derived idempotently from domain events | Read-only through Control API; no other deployable writes projections |
| `audit` | Originating deployable through an append contract | Immutable actor and service actions with event identity, reason, target, and outcome; no credential material | Administrative reads use a restricted Control API query; archival reads are separate from mutation authority |

`proxmox-provider` owns no control-plane database schema. It is an adapter with bounded in-process state only; provider task truth remains in Proxmox and durable workflow references remain in `workflow`.

## Record-Level Authority

| Data category | Create authority | Update authority | Delete authority | Concurrency mechanism |
| --- | --- | --- | --- | --- |
| Project and role mapping | Control API administrator path | Control API administrator path | Not in MVP; disable or expire | Version column and audit entry |
| Catalog and provider-profile metadata | Control API administrator path | Control API administrator path | Soft disable only | Version column; activation preconditions |
| Instance identity and desired configuration | Control API command transaction | Control API after authorized accepted command/event | No hard delete in normal lifecycle | Aggregate version and idempotency scope |
| Instance lifecycle intent | Control API | Control API from accepted commands and verified completion events | Retained record after purge | Aggregate version and operation precondition |
| Provider observed state | Reconciler | Reconciler | Expire only under retention policy | Observation version and provider timestamp |
| Operation acceptance record | Control API | Control API projection handler from versioned events | Retained; no normal deletion | Operation ID, terminal-state guard, event receipt |
| Workflow execution state | Orchestrator | Lease holder with valid fencing version | Expire after retention window | Unique active lease, fencing version, checkpoint transaction |
| Provider task reference | Orchestrator | Lease holder before polling and on verified task transition | Retained with operation history | Workflow checkpoint transaction |
| IPv4 lease | Control API create transaction | Control API lifecycle transition or recovery action | Release or quarantine; retain history | Unique active-address constraint and aggregate version |
| Snapshot desired/operation state | Control API | Control API projection handler | Soft lifecycle record | Instance operation lease and event receipt |
| Drift and manual-review record | Reconciler | Reconciler; administrator may append disposition through Control API command | Close, never silently erase | Observation version and attributed disposition |
| Inbox receipt | Consuming deployable | Same consumer transaction | Retention process only | Unique event ID plus consumer name |
| Outbox record | Originating deployable transaction | Debezium reads; owner may mark operational metadata only if design requires | Retention process after publication horizon | Unique event ID and aggregate ordering value |
| Audit entry | Service performing the action | Append-only; no update | Archive lifecycle only | Unique audit/event ID |

## Field Ownership for an Instance

| Field group | Owner | Examples | Update trigger |
| --- | --- | --- | --- |
| Identity | Control API | Instance ID, project ID, creation operation ID | Immutable after acceptance |
| Desired state | Control API | Image, flavor, network, hostname, requested power, retention intent | Authorized idempotent command |
| Allocation | Control API | Provider profile, IPv4 lease, provider-neutral placement reference | Acceptance or explicit recovery transaction |
| Workflow execution | Orchestrator | Stage, attempt, next action, lease, provider task reference, compensation | Command handling and checkpoint transition |
| Provider identity | Orchestrator records; Provider returns | VMID, provider resource reference, immutable ownership-marker expectation | First proven creation result |
| Observed state | Reconciler | Existence, power, hardware, network, marker match, last provider observation | Scheduled or requested observation |
| Derived lifecycle view | Control API projection | Provisioning, active, failed, retained, manual review, purged | Idempotent event application |
| Drift view | Control API projection from Reconciler event | Missing, identity mismatch, power drift, network drift, ambiguous | Idempotent observation event |

The projection is a query convenience. It cannot authorize provider mutation when the authoritative desired state, workflow lease, or ownership evidence disagrees.

## Event and Topic Ownership

| Topic | Logical producer | Transport producer | Consumer | Partition key | Authority conveyed |
| --- | --- | --- | --- | --- | --- |
| `provisioning.commands.v1` | Control API transaction | Debezium from `control.outbox` | Provisioning Orchestrator | Instance ID | Accepted intent only; never proof that provider work completed |
| `provisioning.events.v1` | Provisioning Orchestrator transaction | Debezium from `workflow.outbox` | Control API projection handler and Reconciler where applicable | Instance ID | Workflow fact with operation and checkpoint identity |
| `reconciliation.events.v1` | Reconciler transaction | Debezium from `observation.outbox` | Control API projection handler and Orchestrator for resolved unknown outcomes | Instance ID | Observed-state or drift fact; never desired-state mutation by itself |
| `provisioning.dlq.v1` | Provisioning Orchestrator after policy exhaustion | Orchestrator Kafka producer under a restricted exception, or outbox-backed publisher when operationally viable | Administrative replay path | Instance ID | Failed-delivery evidence, not permission to replay |
| `audit.events.v1` | Each deployable's local transaction | Debezium from the applicable outbox | Audit projection/archive path | Project ID | Attributed fact; no command authority |

Topic names are contracts and may be refined before implementation, but their owners and authority cannot change without an ADR. Message envelopes follow `SRS-FR-058`; secret values and raw provider credentials are prohibited.

## Transaction Boundaries

### Command Acceptance

One Control API PostgreSQL transaction writes:

- Idempotency record or verifies the existing canonical request
- Instance desired state or lifecycle change
- Operation acceptance record
- IPv4 lease when creation requires one
- Audit entry
- Outbox command

The transaction does not contact Kafka or Proxmox.

### Workflow Progress

One Orchestrator PostgreSQL transaction writes:

- Inbox receipt or verifies prior completion
- Lease and fencing state
- Workflow checkpoint and provider task reference
- Operation or domain fact in its outbox
- Compensation or retry metadata when applicable

No transaction spans PostgreSQL and Proxmox. Checkpoints bracket external calls so restart behavior is explicit.

### Reconciliation

One Reconciler PostgreSQL transaction writes:

- New provider observation
- Drift and manual-review changes
- Reconciliation cursor
- Outbox event

It does not overwrite Control API desired state and cannot invoke destructive provider methods.

## AWS Data Ownership

| Resource | Owner | Records | Write rule |
| --- | --- | --- | --- |
| DynamoDB command table | Command-handler Lambda | Command aggregate, operation, idempotency identity, explicit outbox item | One `TransactWriteItems` acceptance operation with conditional uniqueness |
| DynamoDB Streams | DynamoDB service | Ordered item-change records within service semantics | Read only by the relay event source; duplicate delivery expected |
| SQS FIFO command queue | Outbox-relay Lambda | Provider-neutral command envelope | Stable message group and deduplication identity; relay has send-only permission |
| SQS dead-letter queue | SQS redrive policy | Poison or exhausted commands | No normal application mutation; audited administrator redrive |
| Timeout state | Watchdog Lambda in command table | Conditional terminal timeout outcome | Update only when operation is still pending and version matches |
| S3 audit archive | Archive Lambda or delivery role | Minimized immutable audit objects | Append-only prefix; application roles lack delete permission |

The AWS table and PostgreSQL schemas never co-own an instance. A command is accepted into one runtime path. Any later hybrid bridge is an explicit event transfer with stable origin identity, not database replication between authorities.

## Secrets and Configuration Ownership

| Information | Source of truth | Repository content |
| --- | --- | --- |
| Proxmox credential | Runtime secret store selected by the live platform | Secret name/reference and required key names only |
| PostgreSQL credentials | Database/operator-managed secret | Role requirements and secret reference only |
| Kafka credentials | Kafka operator or workload identity configuration | Principal and ACL intent only |
| AWS workload identity | IAM and OIDC trust configured by Terraform | Role, policy, and trust definitions; no access keys |
| Catalog and provider allowlists | Control API database seeded from reviewed environment configuration | Schema, validation rules, and non-secret examples |
| Application configuration | GitOps environment overlay | Names, endpoints, limits, and secret references |

## Retention and Classification

| Class | Examples | MVP handling |
| --- | --- | --- |
| Security secret | Provider credential, private key, token, console ticket | Never persisted in domain stores, events, telemetry, or Git; only secret-store reference retained |
| Tenant configuration | Hostname, SSH public key, desired resources, project mapping | Authorized access, bounded logs, explicit retention |
| Operational state | Operations, checkpoints, task references, inbox/outbox, observations | Retain long enough for replay, incident review, and recovery evidence; policy set before implementation |
| Audit evidence | Actor, action, reason, target, outcome, event identity | Append-only path and encrypted S3 archive with lifecycle policy |
| Telemetry | Redacted logs, metrics, traces | Short, explicit environment retention; access limited to operators |

Exact retention durations, recovery objectives, and archive transitions are deployment policy and must be defined before production-like testing. Soft-deleted instance and operation evidence must outlive the purge eligibility window.

## Prohibited Coupling

- The Control API does not import or persist Proxmox request types.
- The Orchestrator does not query Control API tables to infer whether a command is authorized; the accepted command carries immutable, validated intent.
- The Provider does not write PostgreSQL, consume Kafka, allocate IPv4 addresses, or decide tenant authorization.
- The Reconciler does not mutate desired state, release ownership, or delete provider resources.
- Debezium does not contain domain logic; it publishes committed outbox facts.
- Grafana dashboards, logs, and traces are not authoritative business state.
- The GitOps repository configures runtime objects but never seeds credential values or becomes the instance catalog database.

## Requirement Links

- Functional: `SRS-FR-005`, `SRS-FR-014` through `SRS-FR-036`, `SRS-FR-044` through `SRS-FR-074`, and `SRS-FR-082` through `SRS-FR-091`
- Non-functional: `SRS-NFR-001` through `SRS-NFR-008`, `SRS-NFR-015` through `SRS-NFR-020`, and `SRS-NFR-027` through `SRS-NFR-036`
- Architecture: `SRS-ARC-001` through `SRS-ARC-009`
