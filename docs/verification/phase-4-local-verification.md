# Phase 4 Local Verification

- Execution date: 2026-08-27 through 2026-08-29 Africa/Cairo
- Runtime: Node.js 24.18.0 and pnpm 11.3.0
- Dependencies: PostgreSQL 16.10, Apache Kafka 4.1.2 in KRaft mode, Debezium Connect 3.4.3,
  OpenTelemetry Collector 0.158.0, Tempo 2.10.7, Prometheus 3.12.0, Loki 3.7.6, Alloy 1.18.0,
  and Grafana 13.1.0
- Provider: deterministic fake only; no live Proxmox mutation

## Verified Results

| Drill | Measured result |
| --- | --- |
| Happy path | REST returned `202`; one command crossed CDC and Kafka; the workflow completed; operation and instance projections reported `succeeded` and `active` |
| Broker outage | With Kafka and Connect stopped, the API still committed and returned `202`; pending control outbox count increased; after restart the same command drained and succeeded |
| Duplicate command | Publishing the same event twice left workflow receipts, workflows, and provider resources unchanged at two each for the inspected fixture set; both redeliveries were recorded as duplicates |
| Worker termination | The Orchestrator was terminated while polling provider task `fake-task-000077`; after lease expiry a restarted worker resumed it and completed with one workflow and one distinct resource, `fake-resource-000076` |
| Permanent contract failure | Unsupported event `d1000000-0000-4000-8000-000000000001` was attempted three times, stored as a dead letter, published through the workflow outbox, and committed with a terminal command receipt at Kafka partition 3 offset 5 |
| Incompatible replay | A replay request for an unsupported future create schema returned `202`, gained one completed physical request receipt, emitted one rejected resolution fact, created no workflow, and left the original dead letter open at generation zero |
| Compatible replay | Original event `b1000000-0000-4000-8000-000000000001` was admitted as generation one, retained its event ID, completed its replay request through a resolution fact, and produced one successful workflow and resource |
| Ownership boundary | The Orchestrator committed replay resolution only to its workflow outbox; the Control API consumed that fact and updated the control request and admin projection in owner transactions |
| Duplicate replay request | Redelivering request event `c2000000-0000-4000-8000-000000000002` left one physical receipt and one resolution event; no second replay decision or workflow was created |
| Invalid delivery metadata | A valid envelope with replay generation `-1` was attempted three times, quarantined as a 64-character payload hash at partition 1 offset 6, and committed with zero consumer lag |
| Port collision | A second Orchestrator failed startup and closed cleanly rather than remaining as a hidden Kafka consumer |
| Transactional audit CDC | A clean PostgreSQL run produced two Control API and three Orchestrator audit facts; Debezium routed all five to `audit.events.v1` with project keys, contract headers, trace context, and generation zero |

The Kafka outage drill began with two existing pending poison fixtures. The accepted outage command
increased that backlog and later received a matching workflow receipt; one intentionally retained
poison fixture remained pending. The recovery assertion used the specific event identity, not a
misleading aggregate backlog of zero.

Replay delivery uses two receipts for two distinct meanings. The replay request has a physical
receipt with Kafka coordinates. A compatible request also creates a logical original-event receipt
at generation one with null broker coordinates, because the replay decision and command admission
occur in one Orchestrator transaction rather than through a fabricated Kafka delivery. Producer
outboxes remained immutable throughout these drills.

The audit topology drill is repeatable with `pnpm run verify:audit-topology` after migrations and
seed are applied. It exercises create acceptance, an idempotent duplicate, terminal fake-provider
provisioning, governed command dead-lettering, dead-letter projection, authorized replay, and replay
admission. The inspected generation-one original-event receipt retained null source topic,
partition, and offset, while the physical replay-request receipt retained its real Kafka delivery
coordinates. The five audit outbox rows matched the five append-only relational audit entries.

## Trace Evidence

The worker-resumption fixture used trace ID
`88888888888848888888888888888888`. Tempo returned 1,765 spans across the complete journey:

| Service | Span count |
| --- | ---: |
| `control-api` | 842 |
| `debezium-connect` | 138 |
| `provisioning-orchestrator` | 651 |
| `proxmox-provider` | 134 |

The trace contained command acceptance, PostgreSQL write, Debezium `db-log-write` and outbox relay,
Kafka consumption, workflow-stage, provider operation, and provider RPC spans. The span active when
the process received `SIGKILL` could not flush by design; persisted trace context allowed the
replacement worker to continue the same trace.

After strict Kafka key and identity-header validation was enabled, a fresh CDC smoke operation
`a6f4c980-384a-4cb9-8e2e-921f60c64bc9` crossed partition 5 and reached `succeeded`; instance
`f6186e18-b535-45d9-8225-2a09eb046d40` projected as `active`. Trace ID
`a5a5a5a5a5a54a5a8a5a5a5a5a5a5a5a` returned 308 Tempo spans: 147 Control API, 24 Debezium
Connect, 117 Orchestrator, and 20 Provider spans. This proves the connector's encoded key and
headers satisfy the same trust-boundary checks used for injected records.

Trace-correlated JSON logs for the same trace ID were retrieved from Loki for the Control API,
Orchestrator, and Provider. Grafana provisioned Prometheus, Loki, and Tempo data sources plus the
`private-cloud-phase4-event-pipeline` dashboard with trace-to-log and log-to-trace links.

## Metric Evidence

Custom instruments reached Prometheus only through the OpenTelemetry Collector. The queried series
included:

- `controlplane_command_accepted_total`
- `controlplane_messaging_processed_total`
- `controlplane_messaging_queue_residence_seconds_bucket`
- `controlplane_outbox_publish_delay_seconds_bucket`
- `controlplane_outbox_pending`
- `controlplane_outbox_oldest_age_seconds`
- `controlplane_provider_operation_duration_seconds_bucket`
- `controlplane_projection_apply_duration_seconds_bucket`
- `controlplane_workflow_transition_total`
- `controlplane_dead_letter_total`

One sampled query returned three accepted commands, message outcomes of 139 handled, two duplicate,
and one dead-lettered, one dead-letter decision, zero pending workflow outbox rows, one intentionally
pending control fixture, and a queue-residence p95 bucket boundary of 4.75 seconds. These are drill
observations, not capacity claims or SLO targets.

## Static and Contract Evidence

The verification gate covers generated contract drift and exhaustive endpoint/message/field tables,
documentation links, strict TypeScript builds, typed ESLint, unit tests, Compose configuration,
Debezium and Grafana JSON parsing, and production dependency audit. The final uncached gate passed 36
tests across application, messaging, observability, provider adapters, and Control API projects; all
four deployable services built successfully. The Phase 4 workspace dependency graph returned no
known production vulnerabilities.

## Known Local Limitation

KafkaJS 2.2.4 on Node.js 24 can emit `TimeoutNegativeWarning` from its internal request queue during
broker recovery. The bounded outage and redelivery behavior still completed. This warning is a local
dependency compatibility signal to reassess before a production runtime decision; it is not hidden or
suppressed in source.

This verification does not cover Kubernetes, KEDA, replicated Kafka, database failover, load or
saturation behavior, SLOs and alerts, telemetry-backend outage, active reconciliation, or real
Proxmox mutation.
