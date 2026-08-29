# Phase 4 Completion Checkpoints

This file is the resumable execution record for finishing Phase 4. Update it when a checkpoint
starts, when its verification completes, and after its commit. Do not mark a checkpoint complete
without recording concrete evidence.

## Current State

- Overall status: In progress
- Current checkpoint: 4 - Full containerized Phase 4 environment and infrastructure metrics
- Last completed checkpoint: 3 - Complete event topology and audit publication
- Last Phase 4 commit: `d2a61eb feat: publish transactional audit facts`
- Working-tree constraint: preserve the existing console, editor, `.gitignore`, and root
  `tsconfig.json` changes; stage only explicit Phase 4 paths.

## Completion Plan

### Checkpoint 0 - Gap audit and execution ledger

- Status: Complete
- Evidence:
  - Compared the detailed Phase 4 gate with code, Compose, telemetry configuration, diagrams, and
    the local verification report.
  - Identified incomplete retry policy, trace linking, instrumentation, metrics, infrastructure
    collection, container topology, verification evidence, and diagrams.

### Checkpoint 1 - Durable retry, exhaustion, and recovery policy

- Status: Complete
- Required work:
  - Implement at most eight retryable workflow failures within a 15-minute budget.
  - Use full-jitter backoff with a 500 ms base and 30-second ceiling.
  - Persist per-stage attempt, retry start, and last classified error.
  - Reset retry state after forward progress.
  - Route safe exhaustion to governed DLQ, permanent failures to terminal failure, and ambiguous
    mutations to `manual_review`.
  - Add deterministic unit tests for delay bounds, budget exhaustion, and terminal routing.
- Verification required: unit tests, typecheck, lint, and focused code review.
- Evidence recorded 2026-08-30:
  - Provider workflow suite passes 12 tests, including exact eighth-failure exhaustion, 15-minute
    budget exhaustion, full-jitter delay bounds, reset after successful provider contact, ambiguous
    mutation routing, and duplicate-effect protection.
  - Application suite passes 9 tests.
  - Uncached typecheck and lint pass for `application`, `postgres-adapter`, and
    `provider-adapters` and their dependency builds.
  - Focused review confirmed retry state is fenced and committed with each checkpoint; exhaustion
    commits the terminal operation event, command completion, reopened dead letter, DLQ outbox event,
    and lease release in one PostgreSQL transaction.
- Planned commit: `feat: complete durable workflow recovery policy`

### Checkpoint 2 - Complete telemetry semantics and application instrumentation

- Status: Complete
- Required work:
  - Add administrative replay traces with a span link to the original failed trace.
  - Add injectable/in-memory trace and metric exporters for deterministic tests.
  - Add named spans for owner transactions, outbox writes, projection application, retry decisions,
    DLQ, replay, provider adapter work, and compensation decisions where applicable.
  - Add `workflow.active`, `workflow.oldest_ready.age`, and projection event-age metrics.
  - Define explicit histogram boundaries and enforce metric attribute allowlists.
  - Verify standard HTTP, gRPC, PostgreSQL, process, runtime, and event-loop metrics.
- Verification required: telemetry unit tests, exported-attribute tests, typecheck, lint, and build.
- Evidence recorded 2026-08-30:
  - Replay acceptance starts `controlplane.replay.request` as a new administrative trace with a
    span link to the failed workflow trace retained in the Control API dead-letter projection.
  - SDK-level in-memory exporter tests prove the replay link, exact histogram boundaries,
    workflow gauges, and removal of a deliberately prohibited `event.id` metric attribute.
  - Exact SDK views enforce per-instrument attribute allowlists and a 128-series cardinality cap;
    HTTP, gRPC, PostgreSQL, Undici, host, runtime, and event-loop instrumentations are explicit.
  - Named spans cover owner transactions, owner outbox writes, command admission, workflow
    checkpoints and completion, retry decisions, DLQ persistence, replay decisions, projection
    transactions, provider adapter calls, and compensation decisions.
  - `controlplane.workflow.active`, `controlplane.workflow.oldest_ready.age`, and
    `controlplane.projection.event_age` are implemented from authoritative scheduler and event
    timestamps.
  - Application tests pass 10 cases, observability tests pass 4 exporter-level cases, and provider
    adapter tests pass 12 cases.
  - Uncached typecheck, lint, and build pass for all six affected projects and their dependencies;
    documentation validation passes for 48 Markdown files and required diagram artifacts.
  - All four migrations and the Phase 3 seed apply cleanly to disposable PostgreSQL 16.10; schema
    inspection confirms the projected dead-letter trace carrier column.
- Review result: approved after removing one unnecessary non-null assertion; no blocking findings.
- Completed commit: `b9e9186 feat: complete phase 4 telemetry coverage`

### Checkpoint 3 - Complete event topology and audit publication

- Status: Complete
- Required work:
  - Publish `audit.recorded` facts transactionally from Control API and Orchestrator owner outboxes.
  - Preserve replay identity and trace semantics without fabricating Kafka coordinates.
  - Align AsyncAPI producer claims, topic routing, and implemented messages.
- Verification required: contract checks, transaction tests, CDC routing test, and topic inspection.
- Evidence recorded 2026-08-30:
  - Control API create acceptance and administrative replay requests write an attributed relational
    audit row plus an `audit.recorded` fact to `control.outbox` in the owner transaction.
  - Orchestrator terminal provisioning, retry exhaustion, command dead-lettering, and replay
    decisions write service-attributed relational audit rows plus matching `workflow.outbox` facts.
  - Idempotent duplicate commands produce no duplicate audit fact. Audit event IDs match relational
    row IDs, facts are partitioned by project, and restricted replay reasons remain in owner storage.
  - A clean PostgreSQL 16.10 transaction drill produced two Control API and three Orchestrator audit
    facts with matching relational entries. The restored generation-one original command receipt
    retained null topic, partition, and offset.
  - A live Debezium and Kafka drill routed exactly five records to `audit.events.v1`; topic inspection
    confirmed project keys, schema headers, generation zero, and W3C trace context on every record.
  - Contract validation passed 39 REST operations, 54 gRPC methods, 20 event messages, and all
    invariants. Documentation validation passed 48 Markdown files and required diagram artifacts.
  - Uncached typecheck, lint, and builds passed for contracts, PostgreSQL adapter, Control API, and
    Orchestrator. Application, messaging, observability, provider-adapter, and Control API suites
    passed 43 tests in total.
- Review result: approved; no blocking findings after transaction, duplicate, authorization-boundary,
  payload-minimization, causal-identity, and broker-coordinate review.
- Completed commit: `d2a61eb feat: publish transactional audit facts`

### Checkpoint 4 - Full containerized Phase 4 environment and infrastructure metrics

- Status: In progress
- Required work:
  - Add Control API, Orchestrator, Provider, Reconciler, migrations, seed, and deterministic OIDC to
    Compose using the shared production service image.
  - Use API `3100`, Grafana `3101`, Prometheus `9090`, Tempo `3200`, Connect `8083`, and OTLP
    `4317/4318` host ports.
  - Add Kafka broker, Kafka Connect/Debezium, PostgreSQL, and Collector self-metrics to the Collector
    pipeline. Prometheus must scrape Collector endpoints only.
  - Remove Loki and Alloy from the Phase 4 topology because they are deferred by this phase gate.
  - Add health checks and deterministic dependency ordering.
- Verification required: Compose validation, image builds, health checks, `promtool`, and Collector
  configuration validation.
- Planned commit: `build: complete phase 4 integration environment`

### Checkpoint 5 - Automated laptop verification and evidence

- Status: Pending
- Required work:
  - Automate migration, seed, JWT issue, known-trace create, projection and receipt assertions.
  - Assert the required Tempo spans and Prometheus application/infrastructure samples.
  - Exercise Kafka outage, consumer checkpoints, duplicates, retry, permanent failure, ambiguous
    outcome, DLQ, denied replay, and successful replay.
  - Prove prohibited values are absent from exported metric labels and span attributes.
  - Validate Grafana panels and trace links with browser screenshots.
  - Leave the healthy persistent stack running and record its URLs.
- Verification required: one repeatable script exits zero and stores bounded evidence artifacts.
- Planned commit: `test: verify complete phase 4 runtime`

### Checkpoint 6 - Mermaid coverage, documentation, and final review

- Status: Pending
- Required work:
  - Add or update Mermaid views for components, monorepo boundaries, telemetry and metric pipelines,
    trace hierarchy, asynchronous create, CDC routing, checkpoint recovery, Kafka outage, duplicate,
    retry, DLQ, and replay paths.
  - Validate every source before rendering and inspect each rendered SVG.
  - Update README, architecture, ADR, metric catalog, runbook, and verification report.
  - Run contract generation/checks, migrations, tests, lint, typecheck, builds, formatting,
    documentation validation, `promtool`, Mermaid rendering, dependency audit, and code review.
- Verification required: all gates pass or an explicit external limitation is recorded.
- Planned commit: `docs: complete phase 4 operational evidence`

## Resume Instructions

1. Read this file and `git status --short` before changing anything.
2. Continue only the checkpoint marked `In progress`.
3. Update this file with implementation and verification evidence before committing that checkpoint.
4. Record the commit hash, mark the checkpoint complete, and move `Current checkpoint` to the next
   pending item.
5. Never stage unrelated console or editor files.
