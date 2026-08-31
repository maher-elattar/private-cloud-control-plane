# Phase 4 Messaging and Observability

Phase 4 replaces the temporary database-to-database polling path with an asynchronous control
plane. PostgreSQL remains authoritative, Debezium relays committed outbox rows, Kafka provides
retained at-least-once delivery, and consumers commit offsets only after durable handling. The same
request trace crosses HTTP or gRPC, PostgreSQL, CDC, Kafka, the workflow, provider gRPC, and the read
projection.

## Runtime Topology

![Phase 4 runtime components](../diagrams/rendered/phase-4-components.mermaid.svg)

[Open the runtime-component source](../diagrams/mermaid/phase-4-components.mmd).

| Component | Responsibility | State or protocol |
| --- | --- | --- |
| Control API | Authorize requests, commit tenant intent, serve project-scoped read models, administer dead letters | REST, public gRPC, `control` and `projection` schemas |
| Debezium Connect | Read committed outbox changes and route them without service-owned dual writes | PostgreSQL logical decoding to Kafka |
| Kafka | Retain versioned commands and facts and preserve same-instance ordering | Six partitions per topic locally; at-least-once delivery |
| Provisioning Orchestrator | Admit commands, deduplicate deliveries, run leased workflows, and publish progress or terminal facts | Kafka consumer, `workflow` schema, provider gRPC client |
| Proxmox Provider | Isolate provider credentials and implement the provider-neutral lifecycle port | Internal gRPC; deterministic fake or allowlisted Proxmox adapter |
| Reconciler | Reserved owner of observation and drift facts | Instrumented process shell in this phase |
| OpenTelemetry Collector | Receive OTLP traces and metrics, batch them, and expose backend-specific outputs | OTLP gRPC/HTTP, Tempo exporter, Prometheus exporter |
| Tempo, Prometheus, Grafana | Retain and query Phase 4 traces and metrics | Traces, metrics, correlated dashboard views |

The local stack creates the complete contract topology even where later phases have not activated a
consumer:

| Topic | Active Phase 4 path | Partition key |
| --- | --- | --- |
| `provisioning.commands.v1` | Control API to Provisioning Orchestrator | Instance ID |
| `provisioning.events.v1` | Provisioning Orchestrator to Control API projection | Instance ID |
| `provisioning.dlq.v1` | Provisioning Orchestrator to Control API administrator projection | Instance ID |
| `reconciliation.events.v1` | Contract reserved for the Reconciler and Control API | Instance ID |
| `audit.events.v1` | Control API and Provisioning Orchestrator owner outboxes to the future audit archive | Project ID |

Kafka topic names and message schemas are versioned independently. A topic version is not permission
to accept every schema version carried on it; each consumer rejects contracts it does not understand.

## Monorepo Boundaries

![Phase 4 monorepo boundaries](../diagrams/rendered/phase-4-monorepo-boundaries.mermaid.svg)

[Open the monorepo-boundary source](../diagrams/mermaid/phase-4-monorepo-boundaries.mmd).

| Project | Phase 4 ownership |
| --- | --- |
| `packages/contracts` | AsyncAPI source, JSON Schema, generated event types, and delivery metadata |
| `packages/application` | Provider-neutral use cases, workflow ports, event validation, and telemetry port |
| `packages/postgres-adapter` | Owner transactions, inboxes, outboxes, checkpoints, dead letters, replay, and backlog reads |
| `packages/messaging` | Envelope trust boundary and explicitly committed Kafka consumer runner |
| `packages/observability` | Process SDK lifecycle, W3C context helpers, spans, structured logs, and instruments |
| `apps/control-api` | Command producer transaction, event/DLQ consumers, projections, and replay API |
| `apps/provisioning-orchestrator` | Command/replay consumer and resumable workflow scheduler |
| `apps/proxmox-provider` | Instrumented internal provider gRPC boundary |
| `apps/reconciler` | Instrumented process entry point; event production remains later work |
| `deploy/local` | Reproducible local Kafka, CDC, and observability evidence environment |

`application` depends on ports, not Kafka, PostgreSQL, NestJS, or the OpenTelemetry SDK. The NestJS
modules are composition roots: they bind application ports to adapters and own runtime lifecycle.

## Command and Event Flow

![Phase 4 event journey](../diagrams/rendered/phase-4-event-journey.mermaid.svg)

[Open the event-journey source](../diagrams/mermaid/phase-4-event-journey.mmd).

1. The Control API validates authentication, project scope, request identity, and payload.
2. One `control` transaction commits intent, operation state, resource lease, audit evidence, and a
   versioned outbox envelope. Only then does the API return `202 Accepted`.
3. Debezium reads the committed WAL change. Its outbox router sends the declared payload, event ID,
   partition key, replay generation, and W3C headers to the allowlisted Kafka topic.
4. The Orchestrator validates the Kafka key, identity headers, replay generation, envelope, and
   supported command payload. One `workflow` transaction records the inbox receipt and creates the
   initial workflow.
5. Kafka's next offset is committed only after that transaction commits. Provider work is not done
   while the Kafka record is held.
6. A worker claims one checkpoint with a lease and monotonic fencing token, calls the provider with
   a stable request identity, and commits the next checkpoint plus its outbox fact.
7. Debezium publishes progress and terminal facts. The Control API atomically applies each fact and
   records its projection receipt before committing the Kafka offset.
8. Reads return only project-scoped projection documents.

![Transactional outbox CDC routing](../diagrams/rendered/phase-4-cdc-routing.mermaid.svg)

[Open the CDC-routing source](../diagrams/mermaid/phase-4-cdc-routing.mmd).

Audit facts follow the same commit rule without joining the command authority path. The Control API
publishes attributed create acceptance and replay-request facts from `control.outbox`. The
Orchestrator publishes service-attributed terminal provisioning, retry-exhaustion, command-DLQ, and
replay-decision facts from `workflow.outbox`. Each owner inserts `audit.entries` and the matching
`audit.recorded` envelope in the transaction that owns the state change. The event ID is also the
audit aggregate ID, the project ID is the partition key, and replay facts reference the durable
replay request rather than copying its reason into Kafka.

A normal replay request receipt retains its real Kafka topic, partition, and offset. The restored
original command is admitted as generation `n+1` inside the replay transaction and therefore stores
null source coordinates; no code invents a Kafka location for a record the broker never delivered.

The two durable identities serve different failure domains. `outbox_id` identifies one physical CDC
row. `(consumer_name, event_id, replay_generation)` identifies one permitted logical delivery. A
normal broker duplicate remains generation zero and cannot repeat a provider effect.

## Failure and Recovery

![Phase 4 failure and recovery decisions](../diagrams/rendered/phase-4-failure-recovery.mermaid.svg)

[Open the Mermaid source](../diagrams/mermaid/phase-4-failure-recovery.mmd).

Envelope, transport metadata, or permanent contract failures receive bounded handler attempts. An
envelope or replay-generation header that cannot be trusted is quarantined by payload hash and broker
coordinates; raw poison bytes are never copied into logs or telemetry. A valid but unsupported
command becomes an outbox-backed dead-letter fact.
Infrastructure and programming failures are not dead-lettered: their offsets remain uncommitted so
the dependency can recover and Kafka can redeliver.

Replay is a new, authorized command, not a raw topic copy. The Control API requires a platform
administrator, a reason, and an idempotency key. A replayable dead letter can advance to a higher
generation only if the current deployment validates the stored original contract. An incompatible
request is consumed and marked `rejected`, while the original dead letter remains open for a later,
fresh attributed request. A non-replayable record is rejected synchronously with
`REPLAY_NOT_ALLOWED`.

The Orchestrator records the decision in its own transaction and publishes
`provisioning.replay.resolved` through its outbox. The Control API consumes that fact to update the
replay request and administrator projection. Neither component writes the other component's state.

A worker crash cannot erase its last provider task reference. After the lease expires, another worker
claims a higher fence and resumes the persisted task instead of creating a second resource.

![Leased checkpoint recovery](../diagrams/rendered/phase-4-checkpoint-recovery.mermaid.svg)

[Open the checkpoint-recovery source](../diagrams/mermaid/phase-4-checkpoint-recovery.mmd).

Retryable provider failures use full-jitter delay from a 500 ms base to a 30-second ceiling. A stage
may make at most eight attempts and may not exceed its persisted 15-minute retry budget. Successful
forward progress resets stage retry state. Permanent failures terminate without a DLQ, mutations
whose provider outcome cannot be established enter `manual_review`, and safely replayable exhaustion
commits the failed operation, closed command receipt, sanitized dead letter, DLQ outbox fact, audit
fact, and lease release in one fenced transaction.

![Retry exhaustion decisions](../diagrams/rendered/phase-4-retry-exhaustion.mermaid.svg)

![Dead-letter publication](../diagrams/rendered/phase-4-dead-letter.mermaid.svg)

![Governed replay](../diagrams/rendered/phase-4-replay.mermaid.svg)

Detailed broker sequences are available for
[Kafka unavailability](../diagrams/rendered/kafka-unavailable.mermaid.svg) and
[duplicate delivery](../diagrams/rendered/duplicate-message.mermaid.svg). Their canonical sources,
along with every recovery-diagram source, are indexed in the
[diagram workflow](../diagrams/README.md).

## End-to-End Telemetry

![Phase 4 telemetry pipeline](../diagrams/rendered/phase-4-telemetry-pipeline.mermaid.svg)

[Open the Mermaid source](../diagrams/mermaid/phase-4-telemetry-pipeline.mmd).

Each Node.js entry point registers OpenTelemetry before importing NestJS, database, Kafka, or gRPC
runtime modules. W3C `traceparent` and optional `tracestate` are bounded and persisted in the event
envelope, Debezium carrier column, and workflow checkpoint. Consumers and resumed workflow stages
restore that parent into short-lived spans. No span is held open while work waits in Kafka, sleeps for
retry, or waits for a provider task.

Administrative replay deliberately starts a new trace. The Control API retains the failed event's
bounded W3C carrier in its dead-letter projection and adds that trace as a span link on
`controlplane.replay.request`; it does not make completed failure work the parent of a later operator
action. The new replay carrier is then persisted in the replay command and becomes the parent of the
new delivery generation.

Manual spans identify the business boundaries that driver instrumentation cannot infer:
`controlplane.transaction.*`, `controlplane.outbox.write`,
`controlplane.transaction.command_admission`, `controlplane.workflow.retry_decision`,
`controlplane.dead_letter.persist`, `controlplane.replay.decision`,
`controlplane.projection.apply`, `controlplane.provider.adapter`, and
`controlplane.workflow.compensation_decision`. HTTP, gRPC, PostgreSQL, Undici, host, Node.js runtime,
and event-loop signals remain enabled through standard OpenTelemetry instrumentations.

![Phase 4 trace hierarchy](../diagrams/rendered/phase-4-trace-hierarchy.mermaid.svg)

[Open the trace-hierarchy source](../diagrams/mermaid/phase-4-trace-hierarchy.mmd).

Services and the Kafka/Connect Java agents export traces and metrics through OTLP to the Collector.
The Collector also gathers PostgreSQL transaction, lock, and logical-slot metrics plus its own
pipeline metrics. It batches traces into Tempo and exposes one consolidated Prometheus endpoint;
Prometheus has exactly one scrape target. Restricted resource values and process command details are
removed before export. Applications do not push to Prometheus and do not depend on a telemetry
backend for correctness. Loki and Alloy remain outside this phase and return with the Kubernetes
logging work.

![Phase 4 metric flow](../diagrams/rendered/phase-4-metric-flow.mermaid.svg)

[Open the metric-flow source](../diagrams/mermaid/phase-4-metric-flow.mmd).

The custom metric surface is deliberately low-cardinality:

| Instrument | Operational question |
| --- | --- |
| `controlplane.command.accepted` | Which command outcomes were durably accepted? |
| `controlplane.messaging.processed` | Were deliveries handled, duplicated, dead-lettered, or quarantined? |
| `controlplane.messaging.queue_residence` | How long did a record wait after broker append? |
| `controlplane.outbox.publish_delay` | How long elapsed between domain occurrence and broker append? |
| `controlplane.outbox.pending` | How many owner outbox rows have no durable consumer result? |
| `controlplane.outbox.oldest_age` | How old is the oldest pending owner record? |
| `controlplane.workflow.transition`, `controlplane.workflow.retry` | How is workflow execution progressing? |
| `controlplane.workflow.active`, `controlplane.workflow.oldest_ready.age` | How much non-terminal work exists, and how long has claimable work waited? |
| `controlplane.provider.operation.duration` | How long do provider operations take by operation and outcome? |
| `controlplane.projection.apply.duration` | How long do projection transactions take by schema and outcome? |
| `controlplane.projection.event_age` | How stale is an event when its projection transaction completes? |
| `controlplane.dead_letter`, `controlplane.quarantine`, `controlplane.replay` | Which governed recovery paths are active? |

Metric attributes are bounded classifications only. Project, instance, operation, event, resource,
provider-task, address, credential, and tenant-configuration values may be trace or restricted log
fields where allowed, but are never metric labels. One exact SDK view per custom instrument enforces
its attribute allowlist and caps aggregation cardinality at 128 series. Messaging and event-age
histograms use explicit boundaries from 5 ms through 15 minutes; provider and projection-operation
histograms use boundaries from 5 ms through 60 seconds. These second-based boundaries are stable
across OTLP export and Prometheus translation.

The [Phase 4 metric catalog](../observability/phase-4-metric-catalog.md) defines instrument types,
units, allowed attributes, explicit buckets, infrastructure series, and dashboard queries.

## Scope Boundary

This phase proves the asynchronous create-instance path with both the deterministic fake and the real
Proxmox adapter against a local TLS Proxmox-compatible simulator. The simulator verifies allowlisted
HTTP calls, provider task polling, gRPC boundaries, and trace continuity without contacting or
mutating a hypervisor. The single-broker evidence stack does not claim production Kafka replication,
Kubernetes or KEDA deployment, SLOs and alerts, load-test capacity, database failover, an active
reconciliation loop, centralized logs, or a live Proxmox mutation. Those require their own deployment
and measured verification phases.

See [Phase 4 Persistence and Delivery Identity](phase-4-persistence.md), the
[failure recovery runbook](../runbooks/phase-4-failure-recovery.md), and the
[local verification record](../verification/phase-4-local-verification.md).
