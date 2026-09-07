# Phase 4 Metric Catalog

This catalog defines the Phase 4 metric contract. Applications and Java processes export OTLP to the
OpenTelemetry Collector. The Collector also reads PostgreSQL and its own pipeline metrics, exposes
one consolidated endpoint, and is the only Prometheus scrape target. Metric export is never part of
a business transaction.

![Phase 4 metric flow](../diagrams/rendered/phase-4-metric-flow.mermaid.svg)

## Application Instruments

| OpenTelemetry instrument | Type | Unit | Allowed attributes | Operational question |
| --- | --- | --- | --- | --- |
| `controlplane.command.accepted` | Counter | `{command}` | `command.type`, `outcome` | Which commands reached durable acceptance? |
| `controlplane.messaging.processed` | Counter | `{message}` | `messaging.destination.name`, `messaging.consumer.group.name`, `event.schema.name`, `outcome` | How did Kafka deliveries finish after durable handling? |
| `controlplane.messaging.queue_residence` | Histogram | `s` | `messaging.destination.name`, `messaging.consumer.group.name`, `event.schema.name`, `outcome` | How long did records wait after broker append? |
| `controlplane.outbox.publish_delay` | Histogram | `s` | `messaging.destination.name`, `messaging.consumer.group.name`, `event.schema.name`, `outcome` | How long did committed facts wait for broker append? |
| `controlplane.workflow.transition` | Counter | `{transition}` | `workflow.stage.from`, `workflow.stage.to` | Where is workflow execution progressing? |
| `controlplane.workflow.retry` | Counter | `{retry}` | `workflow.stage`, `error.category` | Which classified stages are retrying? |
| `controlplane.workflow.active` | Observable gauge | `{workflow}` | None | How many workflows are non-terminal? |
| `controlplane.workflow.oldest_ready.age` | Observable gauge | `s` | None | How old is the oldest claimable workflow? |
| `controlplane.provider.operation.duration` | Histogram | `s` | `provider.operation`, `outcome` | How long do provider-port operations take? |
| `controlplane.projection.apply.duration` | Histogram | `s` | `event.schema.name`, `outcome` | How long do projection transactions take? |
| `controlplane.projection.event_age` | Histogram | `s` | `event.schema.name`, `outcome` | How stale are facts when projections finish? |
| `controlplane.dead_letter` | Counter | `{message}` | `event.schema.name`, `error.category`, `replay.allowed` | Which governed dead-letter decisions occur? |
| `controlplane.quarantine` | Counter | `{message}` | `failure.code` | Which untrusted records are quarantined? |
| `controlplane.replay` | Counter | `{replay}` | `outcome`, `phase` | Which authorized replay outcomes occur, and in which half of the two-phase loop? |
| `controlplane.outbox.pending` | Observable gauge | `{record}` | `outbox.owner` | How many owner records lack durable consumer results? |
| `controlplane.outbox.oldest_age` | Observable gauge | `s` | `outbox.owner` | How old is the oldest pending owner record? |

The attribute contracts above are enforced by exact OpenTelemetry SDK views in
`packages/observability/src/runtime.ts`; they are not call-site conventions.

## Histogram Boundaries

Async delivery and event-age histograms use seconds:

```text
0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900
```

Provider and projection-operation histograms use seconds:

```text
0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60
```

One exact SDK view per custom instrument applies its allowlist and a 128-series aggregation limit.
Prometheus receives translated `_seconds`, `_total`, and `_bucket` names. OpenMetrics exemplars carry
trace IDs to Tempo without adding a trace ID label.

## Infrastructure Signals

| Source | Collection path | Required Prometheus evidence | Purpose |
| --- | --- | --- | --- |
| Kafka broker | JMX OpenTelemetry Java agent to Collector OTLP | `kafka_server_brokertopicmetrics_messagesin_total` | Broker traffic and topic activity |
| Kafka Connect worker | JMX OpenTelemetry Java agent to Collector OTLP | `kafka_connect_task_running_ratio` | Connector task availability |
| Debezium PostgreSQL connector | JMX OpenTelemetry Java agent to Collector OTLP | `debezium_postgres_connected` | Source connectivity and CDC health |
| PostgreSQL | Collector PostgreSQL receiver | `postgresql_commits_total`, `postgresql_database_locks` | Transaction and lock pressure |
| PostgreSQL logical slots | Collector SQL query receiver | `postgresql_replication_slot_active`, `postgresql_replication_slot_retained_bytes` | Slot activity and retained WAL |
| Collector | Collector self-scrape receiver | `otelcol_receiver_accepted_metric_points_total`, `otelcol_receiver_refused_metric_points_total`, `otelcol_exporter_sent_spans_total` | Telemetry admission and export health |
| Node.js services | Standard OpenTelemetry instrumentation to Collector OTLP | HTTP, gRPC, PostgreSQL, process, runtime, host, and event-loop series | Runtime and protocol health |

Curated JMX rules keep topic and partition as bounded labels instead of generating metric-name
suffixes. The Collector removes hostnames, container IDs, process commands, executable paths, owners,
PIDs, and service-instance IDs before export.

## What "Pending" Excludes

`controlplane.outbox.pending` and `controlplane.outbox.oldest_age` count owner records that **no
in-scope consumer has acknowledged**, which is narrower than "not yet published". Two exclusions
make that precise, and both exist because the gauge otherwise rises forever on a healthy stack:

| Excluded | Why | When to revisit |
| --- | --- | --- |
| `audit.events.v1` rows in either outbox | Published for an audit archive that does not exist in this phase, so no receipt will ever appear | When the audit archive ships it needs a receipt table, and this exclusion must be **replaced by a real check**, not deleted |
| `provisioning.commands.v1` rows in `workflow.outbox` matched against event receipts | Governed replay routes restored commands through the workflow outbox; the orchestrator acknowledges them in `workflow.command_receipts`, not the Control API projection | Not applicable; this is the correct permanent matching |

Both gauges must read zero on a settled stack. The runtime verifier asserts that directly and
cross-checks the exported gauge against the database, so the dashboard cannot disagree with the
tables it claims to describe.

## Bounded Attribute Values

Two attributes carry an enumeration small enough to state exhaustively, because both are read
during incident triage and a wrong value is indistinguishable from a wrong conclusion.

| Attribute | Instrument | Values | Meaning |
| --- | --- | --- | --- |
| `phase` | `controlplane.replay` | `request` | An administrator's replay request was authorized, deduplicated, or denied. |
| `phase` | `controlplane.replay` | `command` | The restored command returned through Kafka and was admitted, deduplicated, or rejected. |
| `failure.code` | `controlplane.quarantine` | `REPLAY_COMMAND_IDENTITY_CONFLICT` | A receipt for this generation exists with a different canonical payload. |
| `failure.code` | `controlplane.quarantine` | `REPLAY_COMMAND_UNAUTHORIZED` | No live authorization matches the command's hash and physical outbox identity. |
| `failure.code` | `controlplane.quarantine` | `REPLAY_COMMAND_STATE_CONFLICT` | Authority matched, but the target workflow is no longer reopenable. |

`failure.code` also carries the message-decode codes raised at the transport boundary. Both
attributes stay within the 128-series cap because every value is drawn from a closed union in
`packages/application/src/ports.ts` and `packages/messaging/src/message-codec.ts`.

## Cardinality Rules

Never use project, tenant, instance, operation, event, aggregate, provider-resource, provider-task,
hostname, address, IP, key, reason, payload, or credential values as metric labels. These values are
also forbidden in metric names. Schema names, consumer groups, workflow stages, classified outcomes,
and safe error categories must come from bounded enumerations.

The runtime verifier queries every `controlplane_*` series, rejects prohibited label names, searches
for restricted fixture values, and proves that all application series have
`instance="otel-collector:8889"`. Trace attributes are scanned separately.

## Dashboard Queries

```promql
sum by (outbox_owner) (controlplane_outbox_pending)
max by (outbox_owner) (controlplane_outbox_oldest_age_seconds)
controlplane_workflow_active
controlplane_workflow_oldest_ready_age_seconds
histogram_quantile(0.95,
  sum by (le, messaging_destination_name)
    (rate(controlplane_messaging_queue_residence_seconds_bucket[5m])))
sum by (event_schema_name, outcome) (rate(controlplane_messaging_processed_total[5m]))
sum(increase(controlplane_dead_letter_total[1h]))
sum(increase(controlplane_quarantine_total[1h]))
sum by (phase, outcome) (increase(controlplane_replay_total[1h]))
```

These queries are diagnostic views, not SLOs. Alert thresholds, recording rules, retention, and
capacity targets remain deployment-phase work.
