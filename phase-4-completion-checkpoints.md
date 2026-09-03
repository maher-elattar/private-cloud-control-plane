# Phase 4 Completion Checkpoints

This file is the resumable execution record for finishing Phase 4. Update it when a checkpoint
starts, when its verification completes, and after its commit. Do not mark a checkpoint complete
without recording concrete evidence.

## Current State

- Overall status: Reopened - strict Phase 4 gaps remain
- Current checkpoint: 9 - Kafka-backed authorized replay
- Last completed checkpoint: 8 - End-to-end telemetry correctness
- Last Phase 4 implementation commit: `8c6851a docs: refresh Mermaid render artifacts`
- Previous checkpoint closure commit: `42f5cc1 docs: close phase 4 completion gate`
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

- Status: Complete
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
- Evidence recorded 2026-08-30:
  - A clean-volume Compose start ran migrations, seed, topic creation, and connector registration
    before starting all four production service images. Twelve long-running services are healthy,
    and the four one-shot jobs exit zero.
  - Production images run as the non-root Node user, import the shared OpenTelemetry package with
    production dependencies only, and exclude the local issuer key and database tooling. The
    separate local-runner target contains only the deterministic test issuer and migration assets.
  - Kafka 4.1.2, Debezium Connect 3.4.3, OpenTelemetry Collector Contrib 0.158.0, Tempo 2.10.7,
    Prometheus 3.12.0, and Grafana 13.1.0 are pinned. Remote Java agents are checksum verified.
  - Kafka persists KRaft data in the named `/var/lib/kafka/data` volume. A forced broker container
    replacement retained all five contract topics and the four broker/Connect internal topics;
    Connect then returned its connector and task to `RUNNING`.
  - Kafka broker, Connect task, Debezium streaming/lag, PostgreSQL transaction/lock, logical
    replication-slot, and Collector accepted/refused/export metrics are present at the consolidated
    Collector endpoint. Prometheus reports exactly one healthy scrape target.
  - Collector resource sanitization removes hostnames, container IDs, process command details,
    PIDs, and service instance IDs. Curated JMX rules keep topic and partition values as labels rather
    than metric-name suffixes; redundant Java runtime instruments are dropped to avoid descriptor
    conflicts.
  - Compose configuration, Collector validation, `promtool`, shell syntax, targeted Prettier,
    documentation validation for 48 Markdown files, and `git diff --check` pass.
- Review result: approved after fixing runtime workspace installation, JMX directory permissions,
  Kafka data persistence, bounded connector readiness, dynamic metric names, restricted resource
  labels, and duplicate JVM descriptors; no blocking findings remain.
- Completed commit: `f5a91c8 build: complete phase 4 integration environment`

### Checkpoint 5 - Automated laptop verification and evidence

- Status: Complete
- Required work:
  - Automate migration, seed, JWT issue, known-trace create, projection and receipt assertions.
  - Assert the required Tempo spans and Prometheus application/infrastructure samples.
  - Exercise Kafka outage, consumer checkpoints, duplicates, retry, permanent failure, ambiguous
    outcome, DLQ, denied replay, and successful replay.
  - Prove prohibited values are absent from exported metric labels and span attributes.
  - Validate Grafana panels and trace links with browser screenshots.
  - Leave the healthy persistent stack running and record its URLs.
- Verification required: one repeatable script exits zero and stores bounded evidence artifacts.
- Evidence recorded 2026-08-31:
  - `pnpm run verify:phase4-runtime -- --reset --skip-build` completed from clean named volumes in
    465.4 seconds and wrote a `passed` evidence record with a delayed full-stack stability check.
  - The actual Proxmox adapter traversed gRPC and a local TLS Proxmox-compatible API: 290 spans,
    14 Proxmox HTTP spans, one provider resource, one projection, one receipt, and no duplicate
    business effect.
  - Kafka outage, consumer buffering, and leased-checkpoint restart recovered with a stable
    provider resource. Retry success, permanent rejection, ambiguous mutation, exact eight-attempt
    DLQ exhaustion, replay denial, generation-one replay success, and one original-trace link passed.
  - Poison input produced one quarantined record without raw payload storage. All 23 required
    application and infrastructure metric families were present; restricted metric labels and
    restricted fixture values in metrics and traces were both zero.
  - Grafana provisioned five dashboard panels, Prometheus and Tempo data sources, and the exemplar
    trace destination. Thirteen long-running containers remain up, all 12 health-checked services
    are healthy, and all five initialization jobs exited zero.
  - Headless Chrome screenshots were inspected at 1920x1200. The dashboard renders all five live
    panels; the Tempo trace renders a 3.42-second waterfall with 290 spans across four services,
    rooted at the `202 Accepted` Control API request.
  - The uncached affected-project matrix completed 29 of 30 targets; the sole failure was typed
    ESLint treating the project-local Vitest config as application source. Applying the existing
    app-level tooling ignore and rerunning the target passed, making all 30 tests, type checks,
    lints, and builds green. Compose, Collector, `promtool`, JavaScript syntax, and diff checks pass.
  - A second clean-volume run exposed Kafka Connect retaining its five-minute default scheduled
    rebalance delay after a broker outage. The Compose variable lacked the image's required
    `CONNECT_` prefix; the corrected worker property bounds reassignment at five seconds. The same
    run proved the named-volume TLS initializer and actual HTTPS Proxmox path before reaching this
    recovery gate.
  - The following clean reset caught PostgreSQL briefly returning SQLSTATE `57P03` after its
    readiness probe passed. Migration and seed jobs now use a bounded 60-second connection retry
    for startup and network-transient error codes, while immediately surfacing non-transient SQL
    failures.
  - Post-run health inspection then caught repeated Compose reconciliation rerunning the TLS job
    and replacing certificate files beneath the live HTTPS simulator. TLS initialization is now
    idempotent within its named volume. Final verification covers all 12 health-checked services,
    Tempo, all five one-shot jobs, and a 10-second delayed stability check.
  - An uncached six-project Nx matrix passed every test, typecheck, lint, and build target plus its
    dependencies; 38 focused tests passed. The database readiness helper passed transient retry,
    non-transient fail-fast, and budget-exhaustion tests.
  - Compose rendering, Collector validation, `promtool`, targeted formatting, documentation
    validation for 48 Markdown files, JavaScript syntax, and staged diff checks all pass.
- Review result: approved after correcting Kafka/Connect readiness and recovery, PostgreSQL startup
  retry, idempotent ephemeral TLS initialization, full-stack delayed health verification, provider
  gRPC cutover probing, generation-aware replay polling, Tempo partial-trace polling, scrape-label
  redaction semantics, and typed lint scope; no blocking findings remain.
- Completed commit: `06928e2 test: verify complete phase 4 runtime`

### Checkpoint 6 - Mermaid coverage, documentation, and final review

- Status: Complete
- Required work:
  - Add or update Mermaid views for components, monorepo boundaries, telemetry and metric pipelines,
    trace hierarchy, asynchronous create, CDC routing, checkpoint recovery, Kafka outage, duplicate,
    retry, DLQ, and replay paths.
  - Validate every source before rendering and inspect each rendered SVG.
  - Update README, architecture, ADR, metric catalog, runbook, and verification report.
  - Run contract generation/checks, migrations, tests, lint, typecheck, builds, formatting,
    documentation validation, `promtool`, Mermaid rendering, dependency audit, and code review.
- Verification required: all gates pass or an explicit external limitation is recorded.
- Progress recorded 2026-08-31:
  - Added dedicated Phase 4 component, monorepo, CDC-routing, checkpoint-recovery, retry-exhaustion,
    dead-letter, replay, metric-flow, and trace-hierarchy views. Updated the telemetry, Kafka-outage,
    and duplicate-delivery views to match the implemented topology and delivery identities.
  - Validated all 14 Phase 4 Mermaid sources with Mermaid CLI 11.16.0 and parsed every generated
    SVG. Full-size and contact-sheet inspection confirmed nonblank, unclipped output; the monorepo
    view was simplified around composition roots after its first render exposed excessive crossing.
  - Updated the README, Phase 4 architecture, delivery and telemetry ADR, recovery runbook, and
    measured verification report. Added an exact metric catalog with types, units, attribute
    allowlists, histogram boundaries, infrastructure sources, and dashboard queries.
  - Documentation validation now requires every Mermaid source to have a nontrivial rendered SVG;
    the expanded gate passes for 49 Markdown files and 28 Mermaid artifacts.
  - Contract generation is clean at 39 REST operations, 54 gRPC methods, 20 event messages, and 888
    field rows. Four migrations and the seed reapplied idempotently to the persistent PostgreSQL
    database.
  - The full uncached Nx matrix completed successfully for all 14 workspace projects and executed
    56 tests. Every backend and shared-package typecheck ran normally; the separately developed
    console retains its generated no-op typecheck target.
  - Compose rendering, Collector validation, `promtool`, Debezium and Grafana JSON parsing,
    JavaScript syntax, documentation validation, and scoped formatting pass. All 28 Mermaid sources
    parse, render, and exactly match their committed SVGs after four stale Phase 3 renders were
    refreshed and visually inspected.
  - The audit-topology verifier initially exposed fixed synthetic Kafka coordinates, fixed
    idempotency keys, and global historical counts. It now uses run-unique signed-bigint offsets,
    run-unique request identities, time- and target-bounded evidence, and exact relational audit ID
    matching. Three consecutive populated-database runs passed with two Control API facts, three
    Orchestrator facts, generation-one replay, and no fabricated restored coordinates.
  - The production dependency audit reports six moderate and seven high findings exclusively under
    the unrelated `apps__console-web>react-router` path. JSON path inspection proves zero advisory
    paths reach a Phase 4 service or shared runtime package. No console or lockfile change was made.
  - The repository-wide Prettier command is externally limited by existing unformatted editor-skill
    files and the user-owned lockfile. Direct Prettier validation of the complete backend, packages,
    deployment, documentation, and tooling scope passes.
  - Final live smoke checks pass for the API, Grafana, Prometheus, Tempo, and Kafka Connect. The
    Connector and its task are `RUNNING`, Prometheus has one healthy Collector target, sampled
    application and infrastructure metrics remain present, and all 13 persistent containers remain
    running with all 12 health-checked services healthy.
- Review result: approved. The run-scoped verifier preserves parameterized database access, bounded
  queries, bigint-safe synthetic coordinates, restricted output, and guaranteed connection cleanup.
  Documentation claims were cross-checked against Compose, Collector configuration, metric views,
  and the machine-readable runtime evidence; no blocking findings remain.
- Completed commits:
  - `e22b074 docs: add phase 4 operational diagrams`
  - `018deee docs: complete phase 4 operational evidence`
  - `8645cee test: make audit topology verification repeatable`
  - `8c6851a docs: refresh Mermaid render artifacts`
  - `42f5cc1 docs: close phase 4 completion gate`

### Checkpoint 7 - Strict completion re-audit

- Status: Complete
- Evidence recorded 2026-09-01:
  - Queried Prometheus exemplar storage for every `controlplane_*` metric over the successful
    verification window; no exemplar series or samples were present even though Grafana had a
    Tempo exemplar destination configured.
  - Queried all Prometheus series carrying `server_address`; 406 series exposed local service
    hostnames or an IP address. The runtime verifier scanned only custom `controlplane_*` series,
    so its previous restricted-label result did not cover standard application metrics.
  - Queried the recorded 290-span happy-path Tempo trace. It contained `db-log-write` and
    `private-cloud-outbox-relay`, but no distinct `debezium-read` or Kafka producer-kind span.
  - Reviewed replay admission and confirmed that the authorized generation-one command was
    inserted directly into the Orchestrator workflow transaction instead of being delivered again
    through `provisioning.commands.v1`.
  - Confirmed the persistent Compose environment still had 13 running containers, 12 healthy
    health-checked services, and no unhealthy service before reopening this gate.
- Review result: the previous completion statement was too broad; checkpoints 8-11 are required.

### Checkpoint 8 - End-to-end telemetry correctness

- Status: Complete
- Required work:
  - Export real trace-based exemplars for latency histograms and prove their Tempo trace IDs through
    the Prometheus exemplar API.
  - Remove hostnames and IP addresses from metric attributes across custom, standard application,
    Java, Collector, and infrastructure metrics while retaining bounded semantic dimensions.
  - Produce and verify the promised CDC trace structure: database log write, Debezium read/relay,
    and Kafka producer spans, with the original W3C context preserved.
  - Expand automated checks so datasource configuration cannot be mistaken for exemplar delivery
    and custom-metric filtering cannot hide prohibited labels on other metric families.
- Verification required: focused unit tests, Collector validation, `promtool`, a live traced create,
  Prometheus exemplar queries, all-series label inspection, and Tempo span-kind inspection.
- Evidence recorded 2026-09-01:
  - The Collector span-metrics connector exports trace-correlated latency histograms with explicit
    boundaries and bounded resource identity. Prometheus has exemplar storage enabled instead of
    relying on Grafana datasource configuration as evidence.
  - A clean-volume real-Proxmox create completed under trace
    `a61a60e1ddd266425ea3b8ef72b3f49c`. Tempo returned 306 spans in that same trace, including the
    API transaction, `db-log-write`, `debezium-read`, 11 Kafka producer spans, command and event
    consumer spans, provider gRPC and HTTPS calls, workflow checkpoints, and projection apply.
  - The checksum-pinned Debezium 3.4.3 interceptor restores the Event Router context before the
    Kafka producer span. Producer spans for both `provisioning.commands.v1` and
    `provisioning.events.v1` retain the original request trace; Kafka auto-instrumentation is
    disabled because it otherwise overwrites the restored W3C header with a new root trace.
  - Prometheus's exemplar API returned 181 samples tied to the known Tempo trace. Querying Tempo by
    the exemplar trace ID succeeded.
  - Global inspection of 7,169 current Prometheus series found zero prohibited identity label keys,
    and every series came from `otel-collector:8889` under the single consolidated scrape job.
    Endpoint identity is removed centrally from custom, standard, Java, and infrastructure metrics.
  - Messaging, observability, Control API, and provider suites passed 26 tests. Their uncached
    typecheck, lint, and build targets passed with all dependencies.
  - Compose rendering, Collector validation, `promtool`, connector JSON, JavaScript syntax,
    formatting, and diff checks pass. The connector and its task are `RUNNING`; 13 persistent
    containers are running and all 12 health-checked services are healthy.
- Review result: approved after requiring producer-span evidence for both command and workflow-event
  destinations; no blocking findings remain.
- Completed commit: `feat: complete phase 4 telemetry semantics`

### Checkpoint 9 - Kafka-backed authorized replay

- Status: In progress
- Progress recorded 2026-09-01:
  - Added an additive migration for durable workflow-owned replay authorization. The row binds the
    administrative request, original event, next generation, authorized command hash, and physical
    workflow outbox ID until Kafka delivers that exact command.
  - Split authorization from execution: request admission now atomically records authority, writes
    generation one to `workflow.outbox`, and marks the dead letter `replay_requested`; workflow
    reopening and replay resolution occur only after a matching physical Kafka delivery.
  - Added an `outbox-id` Debezium header contract and messaging-boundary validation. Replayed
    commands with missing or mismatched durable authority are quarantined by hash and coordinates.
  - Removed the legacy coordinate-free receipt model in migration `0005`; command receipts now
    represent physical broker records exclusively.
  - A clean PostgreSQL 16.10 drill applied all five migrations and the seed, then passed the
    transaction verifier. It proved duplicate request deduplication, deterministic replay denial,
    wrong-outbox quarantine without consuming authority, a generation-one command outbox row, and
    a matching receipt with non-null topic, partition, and run-unique offset after delivery.
  - A persistent Compose run completed the Proxmox happy path, physical duplicate delivery, Kafka
    outage recovery, consumer buffering, and checkpoint recovery. The subsequent retry, DLQ, and
    replay matrix was intentionally stopped before completion; do not treat the runtime gate as
    passed. The failed partial evidence file is deliberately left unstaged for follow-up.
- Required work:
  - Make replay authorization and restored-command publication durable and atomic without a direct
    Kafka dependency in the Control API or Orchestrator request transaction.
  - Route the authorized generation-one command through `provisioning.commands.v1`, retain the
    original logical event ID, increment replay generation, preserve the administrative trace link,
    and deduplicate both request and restored command deliveries.
  - Update contracts, persistence state, receipt semantics, workflow handling, and failure recovery
    documentation to match the implemented broker path.
- Verification required: transaction tests, contract checks, CDC routing, broker-coordinate proof,
  denied replay, duplicate replay request, Kafka outage recovery, and successful generation-one
  replay.
- Planned commit: `feat: route authorized replays through Kafka`

### Checkpoint 10 - Complete runtime evidence

- Status: Pending
- Required work:
  - Extend the repeatable Phase 4 verifier with the new exemplar, global redaction, CDC span-kind,
    and authorized-replay delivery assertions.
  - Run the complete clean-volume Compose verification and update bounded machine-readable evidence,
    screenshots, runbooks, diagrams, and measured results.
  - Leave the persistent environment healthy and record the service URLs.
- Verification required: `verify:phase4-runtime -- --reset`, screenshots, health stability, and all
  required evidence artifacts.
- Planned commit: `test: prove strict phase 4 completion`

### Checkpoint 11 - Final quality gate and closure

- Status: Pending
- Required work:
  - Run contracts, migrations, unit and integration tests, lint, typecheck, builds, formatting,
    documentation validation, `promtool`, Mermaid rendering, dependency audit, and diff checks.
  - Apply the code-review workflow to correctness, security, concurrency, idempotency, telemetry
    cardinality, recovery, and documentation claims; resolve every blocking finding.
  - Mark Phase 4 complete only when every reopened acceptance test has concrete evidence.
- Verification required: all scoped quality gates pass and no blocking review finding remains.
- Planned commit: `docs: close strict phase 4 completion gate`

## Resume Instructions

1. Read this file and `git status --short` before changing anything.
2. Continue only the checkpoint marked `In progress`.
3. Update this file with implementation and verification evidence before committing that checkpoint.
4. Record the commit hash, mark the checkpoint complete, and move `Current checkpoint` to the next
   pending item.
5. Never stage unrelated console or editor files.
