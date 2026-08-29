# Phase 4 Completion Checkpoints

This file is the resumable execution record for finishing Phase 4. Update it when a checkpoint
starts, when its verification completes, and after its commit. Do not mark a checkpoint complete
without recording concrete evidence.

## Current State

- Overall status: In progress
- Current checkpoint: 2 - Complete telemetry semantics and application instrumentation
- Last completed checkpoint: 1 - Durable retry, exhaustion, and recovery policy
- Last Phase 4 commit: `a0bee75 feat: complete durable workflow recovery policy`
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

- Status: In progress
- Required work:
  - Add administrative replay traces with a span link to the original failed trace.
  - Add injectable/in-memory trace and metric exporters for deterministic tests.
  - Add named spans for owner transactions, outbox writes, projection application, retry decisions,
    DLQ, replay, provider adapter work, and compensation decisions where applicable.
  - Add `workflow.active`, `workflow.oldest_ready.age`, and projection event-age metrics.
  - Define explicit histogram boundaries and enforce metric attribute allowlists.
  - Verify standard HTTP, gRPC, PostgreSQL, process, runtime, and event-loop metrics.
- Verification required: telemetry unit tests, exported-attribute tests, typecheck, lint, and build.
- Planned commit: `feat: complete phase 4 telemetry coverage`

### Checkpoint 3 - Complete event topology and audit publication

- Status: Pending
- Required work:
  - Publish `audit.recorded` facts transactionally from Control API and Orchestrator owner outboxes.
  - Preserve replay identity and trace semantics without fabricating Kafka coordinates.
  - Align AsyncAPI producer claims, topic routing, and implemented messages.
- Verification required: contract checks, transaction tests, CDC routing test, and topic inspection.
- Planned commit: `feat: publish transactional audit facts`

### Checkpoint 4 - Full containerized Phase 4 environment and infrastructure metrics

- Status: Pending
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
