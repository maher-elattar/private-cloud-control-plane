# Phase 4 Failure Recovery Runbook

This runbook covers the local Phase 4 event pipeline. It distinguishes retained work from permanent
contract failure and requires durable evidence before an operator requests replay.

## Start and Inspect

```bash
docker compose -f deploy/local/compose.phase4.yaml up -d --build
docker compose -f deploy/local/compose.phase4.yaml ps -a
curl --fail http://127.0.0.1:13133/
curl --fail http://127.0.0.1:8083/connectors/private-cloud-outbox/status
curl --fail http://127.0.0.1:9090/-/ready
curl --fail http://127.0.0.1:3100/health/ready
curl --fail http://127.0.0.1:3101/api/health
```

Compose runs migrations and seed data before admitting CDC or application traffic. It also starts a
deterministic local-only OIDC issuer, all four services, PostgreSQL, Kafka, Debezium Connect, the
Collector, Tempo, Prometheus, and Grafana. The service containers use internal DNS names; host ports
exist for verification only. Never reuse the embedded signing key outside this isolated environment.

## Kafka or Connect Unavailable

**Expected state:** command acceptance continues while PostgreSQL is writable. The operation remains
queued, the control outbox backlog and oldest age rise, and no workflow exists yet.

1. Confirm the API returned `202` and retain its operation ID.
2. Compare `control.outbox` event identities with `workflow.command_receipts`; do not delete or
   republish an unmatched row manually.
3. Inspect Kafka and Connect health. Restore the dependency before changing application state.
4. Confirm Connect returns `RUNNING`, the original event reaches `provisioning.commands.v1`, and the
   matching command receipt appears after the Orchestrator transaction commits.
5. Confirm the original operation reaches a terminal projection and the event ID did not change.

Restarting Kafka or Connect is recovery. Creating a replacement API command is not.

## Duplicate Delivery

**Expected state:** `workflow.command_receipts` contains one generation-zero receipt, one workflow
exists, and the provider contains one owned resource.

1. Compare the duplicate event ID and replay-generation header with the existing receipt.
2. Confirm the message outcome is `duplicate` and the Kafka offset advanced.
3. Confirm workflow count, provider resource count, and terminal event identity did not increase.
4. Investigate only if the duplicate used a higher generation; that indicates the governed replay
   path, not an ordinary broker duplicate.

## Orchestrator Terminated Mid-Task

**Expected state:** the workflow checkpoint retains the provider task reference and the instance
lease eventually expires.

1. Do not clear the task reference or force a new create request.
2. Restart the Orchestrator and wait for the previous lease to expire.
3. Confirm the next claim has a higher fencing token.
4. Confirm it polls the persisted provider task reference and advances the existing workflow.
5. Compare the provider resource IDs before and after recovery; there must be one distinct resource.

If a stale worker later attempts to checkpoint, the store must reject its old fencing token.

## Poison Record or Dead Letter

An invalid envelope or transport generation is stored only as a SHA-256 payload hash plus topic,
partition, offset, safe failure code, and timestamp. A decoded but permanently unsupported command is
stored as governed dead-letter state and published to `provisioning.dlq.v1` through the workflow
outbox.

```bash
curl --fail \
  -H 'Authorization: Bearer <platform-admin-token>' \
  'http://127.0.0.1:3100/v1/admin/dead-letters?limit=50'
```

Before replay, verify the original schema/version, failure code, `replayAllowed`, current deployment
compatibility, target project, and provider ownership evidence. Do not extract the original payload
into a ticket, command line, log, or metric.

## Governed Replay

```bash
curl --fail-with-body -X POST \
  -H 'Authorization: Bearer <platform-admin-token>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <unique-operator-request-id>' \
  -d '{"reason":"Compatibility deployed; retry approved under incident INC-1234."}' \
  'http://127.0.0.1:3100/v1/admin/dead-letters/<original-event-id>/replays'
```

Expected outcomes:

| Outcome | Meaning | Operator action |
| --- | --- | --- |
| HTTP `202`, replay `completed` | Current deployment admitted generation `n+1` | Follow the original event ID and new causation chain to terminal state |
| HTTP `202`, replay `rejected` | Request was durable, but current deployment still cannot validate the original | Leave the dead letter open; deploy compatibility, then submit a fresh attributed request |
| HTTP `409`, `REPLAY_NOT_ALLOWED` | Policy prohibits replay | Investigate or resolve manually; never copy the record to the command topic |
| Idempotent response | The same operator request was already accepted | Follow the returned replay request; do not generate another key |

Replay preserves the original event ID and allocates a new delivery generation. The replay request
has its own event ID and records actor, reason, correlation, and causation. In Tempo, search for the
new `controlplane.replay.request` span and inspect its link to the original failed trace. The replay
span must not appear as a child of that completed trace.

## Telemetry Checks

Prometheus metric names use its OpenTelemetry translation, for example:

```promql
sum by (outbox_owner) (controlplane_outbox_pending)
max by (outbox_owner) (controlplane_outbox_oldest_age_seconds)
controlplane_workflow_active
controlplane_workflow_oldest_ready_age_seconds
histogram_quantile(0.95,
  sum by (le, messaging_destination_name)
    (rate(controlplane_messaging_queue_residence_seconds_bucket[5m])))
sum by (event_schema_name, outcome) (rate(controlplane_messaging_processed_total[5m]))
histogram_quantile(0.95,
  sum by (le, event_schema_name)
    (rate(controlplane_projection_event_age_seconds_bucket[5m])))
sum(increase(controlplane_dead_letter_total[1h]))
```

A single successful journey in Tempo should contain Control API, Debezium, Orchestrator, and
Provider service spans. Prometheus should report one healthy scrape target named
`otel-collector-consolidated`; Kafka, Connect, Debezium, PostgreSQL, and Collector series must all
arrive through that target. Telemetry absence is not permission to mutate durable state; use
database and provider evidence while restoring the Collector or backend.

Grafana provisions the dashboard at
`http://127.0.0.1:3101/d/private-cloud-phase4-event-pipeline/private-cloud-event-pipeline`.
