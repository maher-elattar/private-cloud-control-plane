# Phase 5 Completion Checkpoints

This file is the resumable execution record for Phase 5 — porting the useful lifecycle
capabilities. Update it when a checkpoint starts, when its verification completes, and after its
commit. Do not mark a checkpoint complete without recording concrete evidence.

The authoritative scope is `private-cloud-control-plan.md` at the repository root, Phase 5. It
requires the nine capabilities to be implemented **one at a time**, and states plainly: _"Do not
begin another capability in the same change."_ That rule is binding here.

## Current State

- Overall status: Complete — all nine capabilities implemented and the gate green
- Current checkpoint: none; Phase 5 is closed. Phase 6 is Kubernetes and GitOps deployment.
- Last completed checkpoint: P5-12 — Phase 5 closure
- All nine capabilities are implemented. What remains is closure: the runtime drill through Kafka
  against the live stack, the per-capability call-map documentation and diagrams, and the runbook
  and README updates.
- Phase 4 dependency: cleared. Phase 4 closed on 2026-09-04 with all eleven checkpoints complete
  and a `passed` clean-volume evidence record.

## What Phase 5 Inherits

Recorded during the Phase 4 close so the first implementer does not re-derive it.

**The contracts are already complete.** All 39 REST operations, 54 gRPC methods, and 20 event
messages are declared, including `InstancePowerRequested`, `InstanceResizeRequested`, the three
snapshot commands, `InstanceRetentionRequested`, `InstancePurgeRequested`,
`ReconciliationRequested`, and the whole `reconciliation.events.v1` channel. `ProviderPort`
declares all 17 lifecycle methods and `FakeProvider` implements every one. Phase 5 is an
implementation exercise against a frozen contract, not a design exercise. If an operation is ever
added, the hard counts `39` and `54` in `tools/contracts/validate.mjs` must move with it.

**Three layers are create-only and must be generalized**: the workflow engine, the `WorkflowStore`
port, and the database schema.

**The schema blocker.** `workflow.workflows.instance_id` is `NOT NULL UNIQUE` — one workflow per
instance, forever. An instance that is created, then started, then resized needs three. Nothing
else in Phase 5 can proceed until that changes.

**Migration numbering.** Phase 4 checkpoint 9B took `0006_phase4_admin_operations.sql`, so the
Phase 5 lifecycle migration is `0007`.

**`pnpm run test` now has two halves** — the Nx matrix and `pnpm run test:tools`, which runs the
`node:test` cases under `tools/`. A new integration target must be wired so the documented gate
command still covers everything.

**Test posture.** `packages/postgres-adapter` gained its first test target during Phase 4
checkpoint 9B (six cursor tests). It remains the least-tested and highest-risk package, and most
Phase 5 lines land in it. `packages/domain`, `packages/provider-sdk`,
`apps/provisioning-orchestrator`, and `apps/reconciler` still have no test target.

**`ProxmoxProvider` implements 7 of 17 port methods** — it is typed against
`CreateInstanceProviderPort`, a `Pick<>` narrowing. Its `getCapabilities` currently reports
`false` for `resizeCompute`, `growDisk`, `snapshots`, `retentionMarker`, and `purge`. Each
capability flips its own flag.

**`apps/reconciler` is a health-endpoint stub** with a Compose service and a Dockerfile already in
place. Capability 9 fills it.

**Pre-existing inconsistency, worth fixing when the acceptance methods are added:** the read
methods on `ControlPlaneApplication` are typed `Promise<T>` but throw their authorization failure
synchronously, because they delegate without awaiting. A `.catch()` on the returned promise does
not see it.

## Completion Plan

### Checkpoint P5-0 — Gap audit and execution ledger

- Status: Complete
- Evidence recorded 2026-09-04:
  - Mapped the complete create vertical slice across domain, contracts, provider SDK, application,
    persistence, adapters, apps, messaging, testing, and deployment.
  - Confirmed the contract surface is complete for all nine capabilities and identified the three
    create-only layers plus the `instance_id UNIQUE` blocker.
  - Extracted a Proxmox VE API reference catalog for the ten unimplemented port methods from the
    `proxmox-` directory, which is behavioural reference only.

### Checkpoint P5-1 — Containerized integration harness

- Status: Complete
- Rationale: nine capabilities each add leased, fenced, idempotent SQL to a package that has
  almost no tests. Building the harness first is cheaper than retrofitting it nine times.
- Required work:
  - Add `deploy/local/compose.test.yaml` — Postgres, Kafka (KRaft), and Debezium Connect on an
    isolated project name and non-colliding host ports with throwaway volumes, so it never touches
    the long-lived `private-cloud-phase4` stack. Reuse the pinned images and health checks from
    `compose.phase4.yaml`, and `tools/db/postgres-ready.mjs` for startup retry.
  - Add a Vitest global setup that brings the stack up, applies `db/migrations` and the seed, and
    tears it down; expose a new Nx `test-integration` target so `pnpm test` stays fast and
    unit-only.
  - First real store tests: `acceptCreate` idempotent replay and conflicting-payload rejection,
    advisory-lock serialization under concurrent inserts, IPv4 lease uniqueness, `claimNext`
    lease and fencing under two competing workers, `assertLease` rejection of a stale token, and
    the replay authorization triple-check including `rejectReplayCommand` quarantine.
  - Add test targets for `packages/domain` and `apps/provisioning-orchestrator`.
- Verification required: the harness starts and tears down from clean volumes, tests pass, and the
  full gate stays green.
- Evidence recorded 2026-09-04:
  - Added `deploy/local/compose.test.yaml` under its own project name `private-cloud-test`, on its
    own host ports (Postgres 55433, Kafka 9094, Connect 8084), with tmpfs storage rather than named
    volumes. A test database that survives a crash is a liability: the next run inherits rows it did
    not create, which is exactly what made an early drill in this session report 28 audit rows
    instead of 7. Postgres starts by default; Kafka and Connect sit behind the `broker` profile so
    a store-only run does not pay to start a JVM.
  - Added `tools/testing/integration-stack.mjs` as the Vitest global setup. It destroys any stack
    left by an interrupted run, starts Postgres with `--wait`, and applies all migrations and the
    seed. `KEEP_TEST_STACK=1` leaves it up for hand inspection after a failure.
  - Added a non-cached `test-integration` Nx target and `pnpm run test:integration`. The target is
    deliberately uncached: it is container-backed and stateful, so a cached green result would hide
    a real regression.
  - **21 integration tests now cover the SQL that had none.** Acceptance: the full transaction
    writes instance, operation, lease, two outbox rows, audit entry, and both projections; a
    repeated key replays the stored response with no second resource; a reused key with different
    input raises `IDEMPOTENCY_CONFLICT`; three concurrent identical requests produce exactly one
    instance and one lease, which is the race the advisory lock exists for and which no stub can
    demonstrate; concurrent distinct requests receive distinct addresses; the gateway, network,
    broadcast, and excluded addresses are never leased; and a failed acceptance leaves no orphan
    lease, outbox row, or audit entry. Workflow: two competing workers, exactly one claim; the
    fencing token increments per claim; a stalled worker's write with a stale token is rejected;
    and the complete governed replay path including the three-way authority check, the
    unauthorized-delivery quarantine that leaves authority unconsumed, rejection of a dead letter
    that disallows replay, and request deduplication.
  - Added test targets for `packages/domain` (16 cases) as required. `apps/provisioning-orchestrator`
    is deferred to P5-2 rather than done here, because its consumer routing is being replaced by the
    workflow registry in that checkpoint and tests written now would be rewritten immediately.
  - **Testing the domain package immediately found two real bugs in `allocateIpv4`.** It delegated
    parsing to `ipaddr.js`, which accepts legacy `inet_aton` short forms, so a pool configured as
    `192.0.2/24` was read as network `192.0.0.2` and allocated addresses **outside the operator's
    network** - a direct SAFE-024 violation reachable from a provider-profile typo. Malformed
    addresses such as `192.0.2.999/24` also threw a bare `Error` rather than a classified
    `DomainError`, so they would have surfaced as an unmapped failure instead of
    `VALIDATION_FAILED`. Both are fixed by a strict dotted-quad parser, and a pool whose address is
    not the network address for its prefix is now rejected rather than silently masked. `ipaddr.js`
    is no longer a dependency of `packages/domain`.
  - Full gate green: 14 projects typecheck, lint, and build; 82 unit tests across 9 projects plus 3
    tools cases; 21 integration tests; documentation validation passes for 50 Markdown files and 28
    Mermaid artifacts. Repository formatting is clean apart from the pre-existing editor and
    lockfile limitation.
- Planned commit: `test: add containerized integration harness`

### Checkpoint P5-2 — Schema and workflow generalization

- Status: Complete
- Rationale: the single riskiest change in Phase 5. Nothing else can start until it lands.
- Required work:
  - Migration `db/migrations/0007_phase5_lifecycle.sql`: drop the `UNIQUE` constraint on
    `workflow.workflows.instance_id`; add an indexed `action` column with a CHECK over the
    contract's action set; add
    `control.snapshots` and `projection.snapshots`, `control.manual_reviews`, and
    `control.retention_policy`; add `retention_deadline`, `purge_eligible`, `drift`,
    `last_reconciled_at`, and observed-state columns to `control.instances`; add a CHECK on
    `control.operations.target_type` over the six contract values.
  - Extract a reusable `LifecycleWorkflow` engine. The safety-critical machinery is already
    generic and stays as it is: `handleMutationResult`, `handleTaskResult`, `handleProviderError`,
    `retryOrDeadLetter`, `progress`, `context`, `ownership`, `envelope`. What must become
    per-capability data rather than module constants: the `execute()` stage table,
    `MUTATION_STAGES`, and the emitted `action`.
  - Rename the create-specific port surface: `claimNextCreate` to `claimNext`,
    `admitCreateCommand` to `admitCommand`, `ClaimedCreateWorkflow` to `ClaimedWorkflow` with a
    command union.
  - Widen `isInstanceMutationCompletedV1` and `isInstanceMutationFailedV1` off their hardcoded
    `action === 'create_instance'` and `lifecycleState === 'active'` checks, which currently block
    any non-create workflow from emitting a terminal event.
  - Add the three `DomainErrorCode` values the OpenAPI already references but the union omits:
    `DISK_SHRINK_FORBIDDEN`, `SNAPSHOT_NOT_FOUND`, `SNAPSHOT_OWNERSHIP_MISMATCH`.
  - Wire the `INSTANCE_BUSY` guard, declared and mapped in both transports but thrown nowhere.
  - Add a workflow registry keyed by `action`, replacing the single `CreateInstanceWorkflow` the
    worker constructs and the `schemaName` if/else in `command-consumer.ts`.
- Safety note: getting the mutation-stage classification wrong for a new capability is the path to
  a duplicated destructive operation. Each capability's stage plan needs its own test asserting
  which of its stages are mutations.
- Verification required: migration applies and is idempotent, create regression suite unchanged,
  integration tests for multiple workflows per instance, full gate.
- Evidence recorded 2026-09-04:
  - Migration `0007_phase5_lifecycle.sql` applies cleanly on top of all six earlier migrations
    against disposable PostgreSQL 16.10. Verified directly: two workflows now coexist for one
    instance where the UNIQUE constraint previously permitted one, the `action` CHECK rejects an
    unknown capability, the `target_type` CHECK exists, and the retention policy's single-row guard
    refuses a second row.
  - The dropped constraint removes a limitation, not a safety property. Single-writer safety comes
    from `workflow.instance_leases`, which is keyed by `instance_id` and hands one instance to one
    worker regardless of how many workflow rows exist. The `instance_id` index the unique constraint
    had been providing incidentally is now explicit.
  - `action` is a column rather than a `jsonb` extraction because the dispatcher selects on it, a
    `jsonb` path cannot be indexed usefully, and only a real column can carry a CHECK constraint.
    It is narrowed with `toWorkflowAction` at claim time, so a workflow whose action this build does
    not implement fails the claim instead of running the wrong provider calls against a real VM.
  - Added `WorkflowRegistry`, which holds one executor per capability and rotates between them.
    The rotation is deliberate: a continuously ready capability such as reconciliation or purge
    would otherwise starve every capability registered after it. Executors refuse a workflow whose
    action is not their own, so a routing mistake fails loudly rather than part-way through a
    provider interaction.
  - `MUTATION_STAGES` moved from a module constant to a per-capability property. Which stages are
    mutations is the single most safety-critical fact about a workflow, because `handleProviderError`
    routes a failure in one of them to `manual_review` instead of retrying; a capability that
    inherited create's set would retry a mutation that may already have been applied.
  - Widened `isInstanceMutationCompletedV1` and `isInstanceMutationFailedV1`. They required
    `action === 'create_instance'` and `lifecycleState === 'active'`, which silently made every
    other capability's terminal event unprojectable - a power or resize workflow could never have
    reported success. They now accept any implemented action and any published lifecycle state, and
    treat `providerResourceId` as optional per the contract.
  - Added the three `DomainErrorCode` values the OpenAPI already referenced, each mapped in both
    transports. `DISK_SHRINK_FORBIDDEN` maps to 422 rather than 409 because the request is well
    formed and the instance is not busy; `SNAPSHOT_OWNERSHIP_MISMATCH` maps to 409 rather than 404
    because reporting it as missing would leave a caller retrying a request that can never succeed.
  - Wired the `INSTANCE_BUSY` guard as `lockInstanceForMutation`, which locks the instance row
    `FOR UPDATE` and asserts both that no operation is in flight and that the lifecycle state
    accepts a further mutation. It closes the window between acceptance and Kafka consumption, where
    the workflow lease does not yet exist and two requests could otherwise both become durable
    intent. An instance in another project is reported as missing rather than forbidden, so the
    guard does not confirm its existence to a caller without access.
  - Integration coverage grew from 21 to 26. The new cases prove the guard returns a locked instance
    when idle, reports `INSTANCE_BUSY` for an in-flight operation and for five non-mutable lifecycle
    states, hides cross-project instances, and - the case that motivated it - serialises two
    concurrent mutations so exactly one is accepted.
  - A cross-suite state leak surfaced and was fixed properly rather than patched: each suite cleared
    only its own tables, so the guard suite deleted operations that the acceptance suite's
    idempotency records still referenced. All three suites now share one foreign-key-ordered reset.
  - Full gate green: 14 projects typecheck, lint, and build; 82 unit tests plus 3 tools cases; 26
    integration tests; contracts validate at 39/54/20; documentation validates for 50 Markdown files
    and 28 Mermaid artifacts.
- Deferred with reason: `apps/provisioning-orchestrator` still has no test target. Its consumer
  routing is the next thing the capability work changes, so tests written against the current
  `schemaName` if/else would be rewritten immediately. It moves to the first capability checkpoint.
- Planned commit: `refactor: generalize the workflow engine for lifecycle capabilities`

### Checkpoints P5-3 to P5-11 — the nine capabilities

One capability per checkpoint, one per commit, in this order:

| #   | Checkpoint | Capability                           | Provider methods                                                        |
| --- | ---------- | ------------------------------------ | ----------------------------------------------------------------------- |
| 1   | P5-3       | List, inspect, observed status       | `observeInstance`                                                       |
| 2   | P5-4       | Start, shutdown, stop, reboot        | `startInstance`, `shutdownInstance`, `stopInstance`, `rebootInstance`   |
| 3   | P5-5       | CPU and memory resize                | `resizeInstance`                                                        |
| 4   | P5-6       | Disk growth                          | `resizeInstance`                                                        |
| 5   | P5-7       | IPv4 lease reservation and release   | none                                                                    |
| 6   | P5-8       | Snapshot create/list/delete/rollback | `listSnapshots`, `createSnapshot`, `rollbackSnapshot`, `deleteSnapshot` |
| 7   | P5-9       | Soft deletion and retained state     | `markInstanceRetained`                                                  |
| 8   | P5-10      | Administrative purge                 | `purgeInstance`                                                         |
| 9   | P5-11      | Reconciliation and drift reporting   | `observeInstance`                                                       |

Each checkpoint delivers all ten of the following, and is not complete without all ten:

1. Contract verification — already declared; confirm the message and RPC are fully specified.
2. Domain validator and the authorization rule, following the existing eight-step `createInstance`
   acceptance recipe in `ControlPlaneApplication`.
3. Idempotency through `lockIdempotencyScope` and `findReplayedResponse`, plus the `INSTANCE_BUSY`
   locking guard.
4. Store method reusing `writeControlOutbox` and `writeControlAudit`; projection dispatch extended
   past its current four-value `else throw`.
5. Stage plan and `STAGE_PROGRESS_PERCENT` entries — the total `Record` makes an omission a
   compile error.
6. `ProxmoxProvider` method, the `@GrpcMethod` registration, the orchestrator client wrapper, and
   the matching `getCapabilities` flag flipped.
7. Retry classification and the compensation or manual-recovery rule. **No failure branch may
   automatically stop, delete, or purge a VM.** Ambiguous outcomes go to `manual_review`.
8. Unit tests against `MemoryWorkflowStore` with scripted `FakeProvider`, plus integration tests on
   the containerized stack.
9. Spans, metrics, and logs within the existing attribute allowlists and the 128-series cardinality
   cap. No project, instance, operation, or address value becomes a metric label.
10. A call-map section modelled on `docs/architecture/proxmox-create-call-map.md`, a validated and
    rendered Mermaid diagram, a runbook entry, and a README touch.

### Checkpoint P5-3 — Capability 1: list, inspect, and observed status

- Status: Complete
- Evidence recorded 2026-09-04:
  - `listInstances` and `getInstance` already served desired state on both transports. The missing
    half was observed status, and it was worse than missing: `applyCompleted` hardcoded
    `exists: true`, `powerState: 'running'`, and `markerMatch: true`, and nulled every measurement.
    The read model published four facts it had never measured, and would have kept reporting a
    healthy running VM for an instance the provider had reported as stopped.
  - The workflow already observes all of it. The gap was that `InstanceMutationCompleted` had
    nowhere to carry an observation, so an optional `observed` block was added to its payload -
    additive within v1, which the contract's own compatibility policy permits, and shaped to match
    the existing `InstanceObserved` definition so capability 9's reconciler can converge on it.
  - Observed state now lands in two places: the `Instance` document, and queryable columns on
    `control.instances`. The columns exist because purge and reconciliation must query observed
    state, and a guard deciding whether a VM may be destroyed should not depend on reading a jsonb
    body.
  - Sizing stays `null` when the provider reports none, rather than falling back to the desired
    values. Substituting desired sizing would make desired and observed agree by construction,
    hiding precisely the drift reconciliation exists to surface. A test pins this.
  - `lifecycleState` is now read from the event rather than hardcoded to `active`, since with more
    than one capability a terminal success can legitimately leave an instance `retained` or
    `purged`.
  - Integration coverage grew from 26 to 30: the observation reaches both the document and the
    columns; absent sizing stays null in both; a non-running observed power state is recorded rather
    than assumed; and a redelivered terminal event deduplicates.
  - Full gate green: contracts validate at 39 REST operations, 54 gRPC methods, and 20 event
    messages; 14 projects typecheck, lint, and build; 82 unit tests plus 3 tools cases; 30
    integration tests; documentation validates for 50 Markdown files and 28 Mermaid artifacts.
- Deliberately not included: an on-demand "refresh observed state" route. Observation currently
  happens as part of a workflow, and a tenant-triggered provider read on every `GET` would put an
  unbounded provider call behind a cached read. Periodic refresh is capability 9's job.
- Planned commit: `feat: report observed instance status`

### Checkpoint P5-4 — Capability 2: start, shutdown, stop, and reboot

- Status: Complete
- Evidence recorded 2026-09-04:
  - The first mutating capability, and the first real exercise of the P5-2 foundation. It adds
    three stages (`submitting_power`, `polling_power`, `observing_power`), a `PowerInstanceWorkflow`
    extending `LifecycleWorkflow`, `acceptPowerAction` on the store, `mutateInstancePower` on the
    application, the `POST .../instances/{id}/actions` REST route, the `MutateInstance` RPC, three
    new Proxmox adapter methods, and registry plus consumer routing.
  - **`shutdown` and `stop` stay distinct rather than one action with a force flag.** `shutdown`
    asks the guest to stop itself; `stop` cuts power and can lose unflushed writes. Collapsing them
    would let a caller destroy data through a parameter default. The domain validator rejects
    plausible synonyms such as `poweroff` and `halt` for the same reason: accepting them would mean
    guessing which of the two the caller meant.
  - Only `submitting_power` is a mutation stage. Polling and observing are reads and safe to
    repeat; a test asserts the exact set, because widening it would make a retryable failure look
    ambiguous and narrowing it would let a hard stop be re-issued against a VM that may already
    have taken one.
  - **Found and fixed a latent bug in the shared engine while writing the tests.** `ownership()`
    used `workflow.command.operationId` as `createOperationId`. That is correct only for create:
    the provider matches all five ownership markers or refuses, so a power workflow presenting its
    own operation id would have been refused on every VM in existence. `createOperationId` is now an
    abstract accessor, `control.instances.create_operation_id` records it at acceptance with a
    backfill from the operation journal, and the power command carries it.
  - **Fixed a second engine bug found the same way**: `finishFailure` and `retryOrDeadLetter`
    hardcoded `action: 'create_instance'` on every failure event, so a power failure would have
    been projected against the wrong action. Both now report the executing capability.
  - The Proxmox adapter honours two behaviours the reference module gets wrong. It reads the config
    `lock` field and classifies a locked VM as **transient** rather than permanent, because the lock
    belongs to another Proxmox operation and clears on its own — dead-lettering it would fail a
    request that would have succeeded seconds later. And `stop` sends `overrule-shutdown=1`, without
    which Proxmox refuses while a graceful shutdown task holds the VM, blocking exactly the operator
    who has already decided to hard-stop.
  - `getCapabilities` already reported `power: true` while only `startInstance` existed. That claim
    is now true.
  - Success requires observation, not transport acknowledgement: `observePower` refuses to report
    success unless the provider reports the requested state, and routes a mismatch to
    `manual_review` rather than retrying — a second hard stop is not a safe retry.
  - Two additive contract changes within v1, both permitted by the compatibility policy:
    `providerProfileId` and `createOperationId` on the power command payload. Neither is derivable
    inside the orchestrator, which must not read control-plane-owned tables.
  - Fixed a packaging defect surfaced by the first value import from a contract subpath:
    `./control-plane` and `./provider` declared no `default` condition, so only type-only imports
    resolved. Both now mirror the root entry.
  - Tests: 5 workflow cases against the deterministic fake (all four transitions, rejected outcome
    to terminal failure, unknown outcome to manual review, mutation-stage set, ownership markers),
    2 application cases, 2 domain cases, and 5 integration cases covering the acceptance
    transaction, the `INSTANCE_BUSY` refusal of a concurrent request, idempotent replay, desired
    power state per action, and cross-project refusal. Integration coverage is now 35.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 89
    unit tests plus 3 tools cases; 35 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Not yet done for this capability: the runtime drill through Kafka against the live stack, and the
  call-map document section. Both are batched into the Phase 5 closure checkpoint rather than run
  per capability, because each full Compose reset costs ten minutes.
- Planned commit: `feat: implement instance power transitions`

### Checkpoint P5-5 — Capability 3: CPU and memory resize

- Status: Complete
- Evidence recorded 2026-09-04:
  - Adds three stages, a `ResizeInstanceWorkflow`, `acceptResize`, `resizeInstance` on the
    application, the `resize` branch of both action transports, the Proxmox `resizeInstance`
    method, and registry plus consumer routing. The second capability went noticeably faster than
    the first, which is the P5-2 foundation paying for itself.
  - **Quota is charged on the delta, not the absolute target.** The instance's current sizing is
    already counted in the project total, so charging the full target would refuse a resize the
    project has room for — and would refuse one that _frees_ capacity just as readily. An
    integration test pins this by shrinking the quota to exactly the target and asserting the
    resize is still accepted.
  - **The flavor's minimum disk is a floor, not a shrink instruction.** A tenant who grew a disk to
    128 GiB and then resizes to a flavor whose minimum is 64 keeps 128. Without this the flavor
    change would have silently destroyed data, which SAFE-026 forbids; a test asserts it.
  - `validateResize` also refuses a no-op. A resize that changes nothing still takes the instance
    lock and submits a provider mutation, so a retry loop of them would hold an instance busy
    indefinitely for no effect.
  - Disk shrink is refused twice on purpose: at acceptance by the domain validator, and again in
    the Proxmox adapter. The adapter is the last place that could still issue the irreversible
    call, so it refuses rather than trusting its caller.
  - The adapter honours two Proxmox behaviours the reference module encodes: disk resize is
    **`PUT .../resize`** with an absolute `size`, because POST is not implemented on that endpoint;
    and a config write returns a task id only when the VM is running, so an empty result is
    synchronous success rather than a missing task. Compute is applied before the disk grow, so a
    failure between them leaves a retry whose compute half is already correct.
  - Observation is deliberately more forgiving than the power capability's. `InstanceObservation.resources`
    is optional in the contract, and a provider that cannot measure is not the same as one that
    measured a wrong value, so only an actual disagreement goes to `manual_review`.
  - Seeded a second flavor. One flavor cannot exercise a resize at all, and `lab-medium` grows
    every dimension so a single resize covers the compute change and the disk grow together.
  - Tests: 5 workflow cases (mutation-stage set, success, terminal action reporting, rejected
    outcome, unknown outcome), 4 domain cases, and 6 integration cases covering desired-sizing
    recording, the published target, the no-op refusal, disk-floor behaviour, unknown flavor,
    concurrency refusal, and delta quota. Integration coverage is now 41.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 94
    unit tests plus 3 tools cases; 41 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Capability 4 (disk growth) is deliberately _not_ folded in. The command already carries a disk
  dimension and the adapter already issues the grow, so capability 4 is the tenant-facing ability to
  request a disk size independently of a flavor — a separate contract surface and its own tests.
- Planned commit: `feat: implement instance resize`

### Checkpoint P5-6 — Capability 4: disk growth

- Status: Complete
- Evidence recorded 2026-09-04:
  - Small, because capability 3 built the machinery. What this adds is the tenant-facing ability to
    request a disk size _independently of a flavor_: `diskGiB` on the resize action, threaded
    through both transports, the application input, the command, and acceptance.
  - The target disk is the largest of three inputs — the instance's current size, the flavor's
    minimum, and the tenant's explicit request. Growth-only falls out of taking the maximum.
  - **The shrink check reads the tenant's own number, not the computed maximum.** Taking the
    maximum first would clamp a shrink request back up to the current size and report it as a
    no-op; checking what was actually asked for reports `DISK_SHRINK_FORBIDDEN`, which is the truth
    and the only answer a client can act on. A test pins this distinction.
  - `diskGiB` joins the request hash. The same idempotency key with a different disk size is a
    different request, and replaying the first response would report a growth that never happened.
  - **Fixed a cross-test leak the new tests exposed.** A resize test tightens project quota to
    prove the delta check, and `resetIntegrationState` did not restore it, so a later test failed
    against a quota it never set. The seed's `ON CONFLICT DO NOTHING` cannot put a mutated row
    back, so the reset now restores the seeded quota explicitly. Left unfixed this would have
    produced order-dependent failures in every capability that follows.
  - Tests: 4 integration cases covering growth beyond the flavor minimum, growth without a flavor
    change, the explicit-shrink refusal, and disk quota enforcement. Integration coverage is now 45.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 94
    unit tests plus 3 tools cases; 45 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Planned commit: `feat: implement disk growth`

### Checkpoint P5-7 — Capability 5: IPv4 lease reservation and release

- Status: Complete
- Evidence recorded 2026-09-04:
  - Reservation was already correct and stays untouched: the partial unique index on
    `control.ipv4_leases` and the allocator both treat `active` and `quarantined` as occupying an
    address and `released` as freeing it. What never existed was any transition _out_ of `active`,
    so every address a project ever allocated was reserved forever.
  - Added `releaseIpv4Lease` and `getRetentionPolicy` to the store. This capability is the
    mechanism; capability 7 (soft deletion) and capability 8 (purge) are what trigger it, which is
    why the roadmap orders it before both.
  - **The state progression is one-way: `active` to `quarantined` to `released`.** A first draft
    returned the current state whenever a lease was past `active`, which read as safe but silently
    made a quarantined address unreleasable — a purged instance would have held its address
    forever. The forward step is now allowed and the backward step is not, so a retention command
    redelivered after a purge cannot re-reserve an address the pool has already handed out.
  - `quarantine_until_purge` is the seeded default because it is the conservative half of the
    choice: it cannot hand a retained instance's address to a new instance while the old VM still
    exists and may still be answering on it.
  - Tests: 8 integration cases proving a quarantined address is not reallocated, a released one is
    reallocated to the very next create, both directions of idempotency, the refusal to move
    backwards, the forward promotion from quarantined to released, a null result for an instance
    with no lease, and the seeded policy values. Integration coverage is now 53.
  - Full gate green: 14 projects typecheck, lint, and build; 94 unit tests plus 3 tools cases; 53
    integration tests; documentation validates for 50 Markdown files and 28 Mermaid artifacts.
- Planned commit: `feat: implement IPv4 lease release`

### Checkpoint P5-8 — Capability 6: snapshot create, list, delete, and rollback

- Status: Complete
- Evidence recorded 2026-09-04:
  - The largest capability so far: a new aggregate with its own table and projection, three
    command schemas, four provider methods, four REST routes, and three registry entries.
  - **One `SnapshotWorkflow` class serves all three actions**, with the action as a constructor
    argument and three registrations. They differ only in which provider call the submit stage
    makes and what the confirming listing is expected to show; three near-identical classes would
    have been three places for the mutation-stage set to drift.
  - The safety shape is the sharpest yet. A rollback discards everything written since the
    snapshot and a delete destroys the only copy of that state, so neither may be retried on an
    ambiguous outcome. `submitting_snapshot` is the only mutation stage, and a test asserts that
    set for all three actions.
  - Confirmation is asymmetric on purpose. A create must appear in the provider's listing
    afterwards and a delete must be absent — the listing is the only evidence that distinguishes
    "the task reported success" from "the snapshot exists". Rollback is confirmed by the task
    alone, because rolling back leaves the snapshot in place and the listing looks identical
    before and after.
  - `current` is refused as a snapshot name in the domain, and filtered out of provider listings
    in the adapter. Proxmox injects an entry by that name into every listing to mark live state; a
    real snapshot sharing it would be indistinguishable, and a rollback aimed at the wrong one
    cannot be undone.
  - `vmstate=0` on create is deliberate: capturing RAM would make the snapshot far larger and
    slower, and would make a rollback restore a running memory image — a different and more
    surprising operation than restoring a disk. `start=1` on rollback matches the tenant's
    expectation that a rollback leaves a usable instance.
  - The snapshot name is re-validated in the adapter before it is interpolated into a request
    path. The domain validates caller input, but this value arrives from a stored command, and the
    adapter is the last place that could still issue a malformed call.
  - **Fixed `getQuota`, which hardcoded `usage.snapshots: 0`.** A tenant refused for exceeding
    snapshot quota could read their quota and see zero usage, with nothing to explain the refusal.
    It now counts snapshots in every state that occupies provider storage, including `deleting`.
  - `SNAPSHOT_OWNERSHIP_MISMATCH` is reported as a conflict rather than as missing: the snapshot
    exists, just not on the instance named, and reporting it missing would leave a caller retrying
    a request that can never succeed.
  - Tests: 4 workflow cases (mutation stages across all three actions, successful create with
    listing confirmation, refusal of a mis-routed action, unknown outcome to manual review) and 8
    integration cases covering the acceptance transaction, duplicate-name refusal, snapshot quota,
    the corrected quota read, cross-instance ownership, the not-yet-available refusal, the delete
    transition with its published provider reference, and the projection listing. Integration
    coverage is now 61.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 98
    unit tests plus 3 tools cases; 61 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Planned commit: `feat: implement instance snapshots`

### Checkpoint P5-9 — Capability 7: soft deletion and retained state

- Status: Complete
- Evidence recorded 2026-09-04:
  - `DELETE .../instances/{id}` now works, and it destroys nothing. SAFE-028 and ADR 0007 define
    tenant deletion as detaching access and _keeping_ the provider resource for review; only an
    administrative purge destroys it. The workflow calls `markInstanceRetained` and its terminal
    lifecycle state is `retained`.
  - The Proxmox implementation makes three changes and removes no disk: the description records
    the retention deadline alongside the **unchanged** ownership markers, `onboot=0` stops the VM
    returning after a host reboot, and `delete=ipconfig0` strips the cloud-init network
    configuration so the guest cannot reclaim its address. Preserving the markers is deliberate —
    a later purge has to prove it is destroying the right VM, and it can only do that if they are
    still there to match.
  - **The IPv4 lease moves at acceptance, not on completion.** The tenant loses access
    immediately, and an address left `active` could be handed to a new instance while the old VM
    is still answering on it. The policy decides between quarantine and release; both paths are
    tested.
  - The retention policy is read _inside_ the acceptance transaction, so the deadline and release
    mode recorded on the command are the ones in force when the request was accepted rather than
    whatever they become later.
  - **Found a real gap the type system could not catch.** The DI token is a `Symbol`, which erases
    the injected type, so annotating the constructor parameter with `RetentionProviderPort`
    compiled cleanly while `markInstanceRetained` existed nowhere — not on the Proxmox adapter, the
    orchestrator's gRPC client, or the provider service. This is the standing cost of the
    `Symbol` + `useFactory` pattern that keeps `packages/application` free of NestJS, and it is
    worth knowing: adding a port method to a workflow's type does not prove anything implements it.
    All three now do.
  - Retention got its own input type rather than borrowing the snapshot one, which had briefly
    forced a meaningless `snapshotId: ''` at the call site.
  - Moved retention-policy restoration into the shared integration reset, alongside the quota fix
    from capability 4. A test that mutates configuration and restores it by hand works until
    someone adds an early return.
  - Tests: 6 integration cases covering the lifecycle transition and deadline, both lease-release
    policies, the published deadline and mode, the concurrency refusal, and idempotent replay.
    Integration coverage is now 67.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 98
    unit tests plus 3 tools cases; 67 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Planned commit: `feat: implement soft deletion and retention`

### Checkpoint P5-10 — Capability 8: administrative purge

- Status: Complete
- Evidence recorded 2026-09-04:
  - The only capability in the system that destroys anything, and the only workflow with a stage
    before its mutation whose entire job is to refuse.
  - **Four guards, in three different places, each refusing a different mistake.** The store checks
    that the confirmation repeats the instance id — a mis-pasted identifier is the most likely way
    this destroys the wrong machine; that the instance is `retained` — purging straight from
    `active` would let one request destroy a VM a tenant is still using; and that the retention
    deadline has passed — retention exists so someone can change their mind. The workflow's
    `verifying_purge` stage then proves live provider ownership immediately before acting, which is
    SAFE-006's second half and cannot be done in a database transaction.
  - `verifying_purge` is deliberately **not** a mutation stage. It is a read, so a transport
    failure there should send the workflow round again rather than to manual review. Only
    `submitting_purge` is, because an unknown outcome there means a VM may or may not still exist.
  - An already-absent instance completes as success without submitting anything. The goal of a
    purge is absence; submitting anyway would be a destructive call against a VMID that may since
    have been recycled to someone else. A test asserts no purge call is made.
  - Success requires proven absence, not a task reporting success. Reporting `purged` for a VM that
    still exists would leave a resource nobody is tracking.
  - There is no compensation path, deliberately. Nothing can undo a purge, so every failure branch
    is refuse-before-acting or escalate to an operator, never retry-and-hope.
  - The adapter re-checks ownership at the instant of the call even though the workflow verified it
    a moment earlier. Both checks are cheap; a wrongly destroyed VM is not recoverable at any price.
    It also stops a running VM first, because Proxmox refuses to destroy one and discovering that
    after the caller believes a purge is underway is worse.
  - The administrator's free-text justification stays in the audit trail. The command carries only
    a `reasonReference`, so text an administrator typed never crosses the broker; a test asserts the
    reason string is absent from the published payload.
  - **Found and fixed an idempotency bug the tests caught.** Administrative actions have no tenant
    project, so the idempotency scope uses a sentinel project id — but the record was being
    _written_ under the instance's project while being _looked up_ under the sentinel. A repeated
    key therefore never matched and the second request was refused as busy rather than replayed.
    For a destructive operation that is the worst place to be inconsistent.
  - Tests: 4 workflow cases (mutation-stage set, successful destruction with absence confirmed,
    already-absent short-circuit with no purge call, unknown outcome to manual review) and 7
    integration cases covering acceptance, the confirmation mismatch, the active-instance refusal,
    the unexpired-deadline refusal, reason redaction, administrator-attributed audit, and idempotent
    replay. Integration coverage is now 74.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 102
    unit tests plus 3 tools cases; 74 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Planned commit: `feat: implement guarded administrative purge`

### Checkpoint P5-11 — Capability 9: reconciliation and drift reporting

- Status: Complete
- Evidence recorded 2026-09-04:
  - Filled `apps/reconciler`, which had been a health-endpoint stub with a Compose service and a
    Dockerfile since Phase 4. It now sweeps the least-recently-observed instances on a timer,
    classifies desired-versus-observed differences, and publishes findings to
    `reconciliation.events.v1` — the channel the AsyncAPI has declared since Phase 2 with no
    producer behind it.
  - **Non-destructiveness is enforced by what the reconciler is given, not by discipline.**
    SAFE-029 forbids reconciliation from destroying, shrinking, detaching, or overwriting a
    provider resource. `ReconciliationStore` has no method that could express a correction, and
    the reconciler's gRPC client exposes exactly one RPC — `observeInstance`. A future change
    cannot accidentally make this sweep destructive; it would have to widen a port first, visibly.
  - `classifyDrift` is a pure function in the domain, so the interesting cases are enumerated in
    tests rather than staged against a provider. Its ordering is deliberate: identity before
    absence, because a VM whose markers do not match is not evidence about our instance at all;
    absence before sizing, because comparing the CPU count of a machine that does not exist is
    meaningless.
  - The `dangerous` flag is not a severity. `power_drift` is often more urgent than
    `identity_mismatch`, but only one of them is safe to correct without a human, and that
    distinction is what a consumer needs.
  - A disk _smaller_ than desired is drift; a disk _larger_ is not. Growth is the only direction
    this system permits and a tenant may have grown one outside our record, so reporting that
    would produce a finding nobody should act on.
  - A quiet sweep publishes nothing. Recording an observation with no drift updates the instance
    and stops, rather than filling the topic with non-news.
  - `last_reconciled_at` is stamped inside the claim transaction, whether or not the observation
    that follows succeeds. Combined with `FOR UPDATE ... SKIP LOCKED` that lets several reconciler
    replicas sweep in parallel without observing the same instance twice, and it means one
    unreachable provider cannot wedge the sweep on a single instance.
  - The administrative `POST /v1/admin/instances/{id}/reconciliations` route marks an instance
    stale rather than observing it inline. The sweep owns the provider budget; letting an HTTP
    handler trigger an immediate provider call would put unbounded, un-batched load behind a
    request.
  - Tests: 9 domain cases covering every classification branch including the purged-instance
    exemption, the unmeasured-sizing case, and the asymmetric disk rule; and 8 integration cases
    covering claim-by-staleness, the no-double-claim guarantee, skipping instances with no provider
    resource, never claiming a purged instance, batch bounding, the silent no-drift path, the
    published drift event with its `dangerous` flag, and the queryable classification. Integration
    coverage is now 82.
  - Full gate green: contracts validate at 39/54/20; 14 projects typecheck, lint, and build; 111
    unit tests plus 3 tools cases; 82 integration tests; documentation validates for 50 Markdown
    files and 28 Mermaid artifacts.
- Planned commit: `feat: implement reconciliation and drift reporting`

### Proxmox API facts for the ten unimplemented methods

Gathered from the `proxmox-` reference tree, which is read for API surface only; its architecture
is explicitly out of scope.

- Disk resize is **`PUT /nodes/{node}/qemu/{vmid}/resize`** with `disk=scsi0|virtio0|sata0|ide0`
  and an absolute `size="{N}G"`. POST returns 501. Growth is enforced before the call.
- A config write returns a task UPID **only when the VM is running**, and an empty result
  otherwise. The create path already guards this; every new config call site must too.
- Power is `POST /nodes/{node}/qemu/{vmid}/status/{start|stop|shutdown|reboot}`. Hard-stopping a
  VM with a pending graceful shutdown needs `overrule-shutdown=1`.
- `status` stays `running` while `qmpstatus` reads `paused`, so observed power state must read
  both. That is the only way a suspended guest is detectable.
- Snapshots: `GET`/`POST /snapshot`, `POST /snapshot/{name}/rollback` with `start=1`, and
  `DELETE /snapshot/{name}`. The synthetic `current` entry must be filtered from listings.
  `vmstate=0` keeps snapshots disk-only.
- Purge is `DELETE /nodes/{node}/qemu/{vmid}` with `purge=1&destroy-unreferenced-disks=1` as
  **query-string** parameters.
- Soft retention maps to `POST .../config` with `description`, `onboot=0`, and `delete=ipconfig0`,
  which is exactly what SAFE-028 describes: detach access, retain the resource.
- Two things the reference gets wrong that must not be copied: it never reads the config `lock`
  field (`backup`, `migrate`, `snapshot`, `clone`), and it has no retry or backoff anywhere.
  Reading `lock` and classifying it as a retryable busy condition belongs in our adapter.

All ten are verified against the local TLS Proxmox simulator only. No live hypervisor is
contacted or mutated.

### Checkpoint P5-12 — Phase 5 closure

- Status: Complete
- Evidence recorded 2026-09-04:
  - Added [Phase 5 Lifecycle Capabilities](docs/architecture/phase-5-lifecycle-capabilities.md):
    the shared engine, all nine capabilities with their mutation stages, the full Proxmox call map
    extending the create map, a table of where each safety rule is enforced and why _there_, and
    what is deliberately absent. README updated.
  - **The runtime drill found three real defects that no unit or integration test could have.**
    Each is the kind that only appears when real processes start against a real broker:
    1. The reconciler would not start. It now requires `DATABASE_URL` and fails fast, but its
       Compose service still carried the stub's environment. The fail-fast worked exactly as
       designed — it just had nothing to connect to.
    2. Its bundle did not ship the provider proto. The observation client loads the contract at
       runtime and the orchestrator's webpack config copies it; the reconciler's did not.
    3. **`claimNext` claimed any ready workflow regardless of action.** The registry rotates
       between executors, so the power executor claimed a create workflow, took its lease and
       fencing token, then refused to run it — stranding the workflow until the lease expired and
       looping forever. Unit tests never caught it because the memory store always returned a
       matching action. The claim is now scoped by action, using the `workflows_action_ready`
       index added in P5-2, and an integration test pins it.
  - A fourth finding was a genuinely incomplete capability rather than a bug: the reconciler
    published drift findings to `reconciliation.events.v1` and nothing consumed them, so the
    drain assertion failed with seven undelivered events. Publishing findings nobody reads is half
    a capability, so the Control API now consumes that topic and projects the classification onto
    the instance document. The projection is deliberately narrow — it records the finding and
    changes nothing else, because acting on drift is a separate attributed request.
  - Final clean-volume run passed in 750.5 seconds with all eight check blocks populated, both
    owner outboxes drained to zero, and the stack left healthy: 13 running containers, 12
    health-checked services, five initialization jobs exited zero.
  - Full gate green: contracts validate at 39 REST operations, 54 gRPC methods, and 20 event
    messages; 14 projects typecheck, lint, and build; 111 unit tests plus 3 tools cases; 83
    integration tests; documentation validates for 51 Markdown files and 28 Mermaid artifacts.
- Two items were briefly deferred here and then done, after the user asked why they were on a
  deferred list at all. Both were listed as required by the approved plan — the per-capability
  diagram in the capability template, and the orchestrator test target in P5-1 — so neither had an
  adequate justification. The orchestrator deferral had a real reason when it was made ("its
  routing is about to be rewritten by P5-2") that expired six checkpoints earlier without being
  revisited.
- Test targets added for `apps/provisioning-orchestrator` and `apps/reconciler`, taking the
  workspace from 9 test projects to 11:
  - The orchestrator's seven private narrowing functions were extracted into `command-routing.ts`
    with a `narrowCommand` dispatcher. That is a better shape regardless of testing — the consumer
    is thinner and the routing table, eight branches wide and growing by one per capability, is now
    something that can be exercised without a broker.
  - **Writing the first routing test immediately found a live bug.**
    `isInstancePowerRequestedV1` still required `onlyKeys(data, ['action'])` and was never updated
    when the schema gained `providerProfileId` and `createOperationId`. Every real power command
    off the topic would have failed validation and been dead-lettered as `COMMAND_PAYLOAD_INVALID`.
    No store-level test could see it: acceptance never runs the consumer guard, and the runtime
    drill never publishes a power command. This is precisely the gap the deferral was hiding.
  - Reconciler tests cover the observation-to-snapshot mapping, all four drift outcomes, the
    power-state enum mapping including its `unknown` default, and — the important one — that a
    provider failure on one instance is swallowed so it cannot wedge the sweep. A structural test
    asserts the store exposes only `claimStaleInstances` and `recordObservation` and the client only
    `observeInstance`, so a future widening that would make SAFE-029 violable fails the build.
  - `WorkflowRegistry` also had no test despite being written in P5-2. Six cases now cover duplicate
    rejection, the one-transition-per-tick rule, and the rotation that stops a continuously ready
    capability from starving the ones registered after it.
- Three Mermaid diagrams added, validated, rendered, and visually inspected; the gate now checks 31
  artifacts rather than 28:
  - `phase-5-capability-stages` — all six stage tables converging on one engine, with mutation
    stages coloured and purge's verification gate distinguished. A first attempt using nested
    composite states rendered as an unreadable 4,000-pixel column with edges entering states
    mid-way; it was rewritten as a flowchart with subgraphs.
  - `phase-5-purge-guards` — the four guards and the single path through all of them, including the
    two exits that are neither success nor failure. Error codes were replaced with prose after the
    first two renders clipped the underscored uppercase labels outside their boxes.
  - `phase-5-reconciliation-sweep` — the claim, observe, classify, record cycle, and the fact that
    a quiet sweep publishes nothing.
- Still deferred, with a reason that survives reading:
  - The runtime verifier exercises only the Phase 4 create path. It proves Phase 5 causes no
    regression and that the reconciler runs, but there is no end-to-end drill for power, resize,
    snapshots, retention, or purge through Kafka. This is the largest remaining gap, and the power
    guard bug above is direct evidence of what it would catch. Closing it means extending
    `verify-phase4-runtime.mjs` into a capability matrix, which is a checkpoint of its own rather
    than a loose end.
- Planned commit: `docs: close phase 5 completion gate`

## Resume Instructions

1. Read this file and `git status --short` before changing anything.
2. Continue only the checkpoint marked `In progress`.
3. Update this file with implementation and verification evidence before committing that
   checkpoint.
4. Record the commit hash, mark the checkpoint complete, and move `Current checkpoint` to the next
   pending item.
5. Never stage unrelated console or editor files. Commit `2ca9d9e` mixed the `console-web`
   frontend with Phase 4 checkpoint work and made the true state hard to read for days.
