# Code Reading Guide

One create request, traced through every file it touches. Read the files in this order and the
system explains itself; read them alphabetically and it will not.

If a term here is unfamiliar — outbox, inbox, lease, fencing token, saga, projection — it is
defined in the [Pattern Glossary](glossary.md).

## Before you start: where the "services" are

The most common wrong turn is looking for `apps/control-api/src/app/instances/instances.service.ts`.
It does not exist, and its absence is deliberate.

The service layer is `packages/application/src/control-plane.ts`. It lives there rather than in
`apps/` so that it imports nothing from NestJS — which is what lets it be unit-tested without a
container and reused by the planned AWS Lambda path. The consequence is that it carries no
`@Injectable()` and is constructed explicitly in `app.module.ts` through a `useFactory`.

So the layering is the familiar one, with the middle layer moved out of the framework:

```
Controller (apps/)  →  Application service (packages/application)  →  Port  →  Adapter
```

## The journey

A client sends `POST /v1/projects/{projectId}/instances` and, minutes later, has a running VM.
Eleven hops.

### 1. Request arrives — `apps/control-api/src/app/instances/instances.controller.ts`

A thin transport adapter. `OidcAuthGuard` has already verified the bearer token and attached an
`Actor`; `CreateInstanceDto` has already rejected a malformed body. The controller unpacks
headers and delegates.

Note the `202 Accepted`, not `201 Created`. Nothing has been created at this point.

### 2. Authorization and validation — `packages/application/src/control-plane.ts`

`ControlPlaneApplication.createInstance` checks the actor may touch this project, enforces the
idempotency-key length, runs the domain validation, and computes a **canonical request hash**.

That hash is why idempotency works properly: it is built from the request's *meaning*, so two
JSON bodies with keys in a different order hash identically and are recognised as the same
request rather than as a conflict. See `canonicalSha256` in `packages/domain/src/index.ts`.

### 3. The acceptance transaction — `packages/postgres-adapter/src/control-plane-store.ts`

The single most important method in the system: `acceptCreate`. Read it top to bottom — it is
seven named steps, and each one is a private method directly beneath it.

1. `lockIdempotencyScope` — an advisory lock so concurrent duplicates cannot both proceed
2. `findReplayedResponse` — a retry replays the original response and stops here
3. `loadAcceptanceContext` — resolve and validate project, image, flavor, network, quota
4. `assertQuotaHeadroom` — measured live, not from a counter
5. `reserveIpv4Address` — a second advisory lock, then allocate the lowest free address
6. `buildAcceptanceRecords` — pure, no I/O; every record's shape in one place
7. `writeAcceptanceRecords` — eight inserts, committed together

Step 7 is the **transactional outbox** in action. The instance row, the operation, the IPv4
lease, the audit entry, the idempotency record, both read projections, *and* the outbox row all
commit or none do. That atomicity is what makes the `202` honest: the caller is never told
"accepted" for work that was not queued.

### 4. Handing over — `control.outbox`

The request has now returned. Everything after this point happens in another process.

### 5. Admission — `packages/postgres-adapter/src/workflow-store.ts`

`PostgresWorkflowStore.claimNextCreate` does three things in one transaction:

- `readyWorkflow` — is an existing workflow due for its next transition? (checked first, so a
  backlog of new commands cannot starve a VM that is already half-built)
- `receiveCommand` — otherwise, admit one command from the outbox. This is the **inbox**: the
  `NOT EXISTS` against `workflow.command_receipts` makes admission exactly-once no matter how
  many times a command is delivered.
- Take a **lease** on the instance and increment its **fencing token**.

Read the lease `INSERT … ON CONFLICT` closely. Its `WHERE` clause fires only if the lease has
expired or this worker already owns it — and when it fires, the token increments, which
invalidates the previous holder even if that worker is still running and unaware.

### 6. One transition — `packages/application/src/create-instance-workflow.ts`

`CreateInstanceWorkflow.runOne` executes exactly **one** stage transition and returns. Not a
loop. Each transition commits its own checkpoint and releases the lease, so a crash costs at
most one step.

`execute` is the transition table. The stages are defined in
`packages/application/src/workflow-stage.ts`, which also carries the stage table as
documentation. Because `stage` is a union rather than a `string`, a stage added without a
handler is a compile error.

The method worth reading twice is `handleProviderError`. Its question is never "did the call
fail?" but **"did the provider act before it failed?"** — a timeout on a mutation may mean a VM
was built and only the response was lost. Retrying that could build a second one, so it goes to
`manual_review` instead. This single distinction is the reason most of the surrounding
machinery exists.

### 7. Crossing the trust boundary — `apps/provisioning-orchestrator/src/app/grpc-provider.client.ts`

An adapter satisfying `CreateInstanceProviderPort` over gRPC. The workflow cannot tell there is
a network hop, which is exactly why it can be unit-tested against an in-memory fake.

`transportError` classifies failures into retryable and not. Read it alongside step 6.

### 8. The provider service — `apps/proxmox-provider/src/app/`

A separate process, and a deliberate trust boundary: only this service holds provider
credentials, so the orchestrator — which holds database credentials — never holds both.

- `provider.factory.ts` — **the live-provider safety gate.** Defaults to the deterministic
  fake; Proxmox requires an explicit opt-in and every setting present, so a misconfigured
  deployment fails closed.
- `provider-grpc.controller.ts` — serves the seven RPCs Phase 3 uses.

### 9. The adapter — `packages/provider-adapters/`

- `fake-provider.ts` — not a toy. It is the only way to reproduce a timeout *after* the provider
  committed, a duplicate delivery, or an ambiguous task result. Those are precisely the cases
  the safety rules exist for, and they cannot be produced reliably against real hardware.
- `proxmox-provider.ts` — the only file that can affect real hardware. Written to be boring:
  one node, one template, one storage target, one bridge, a VMID inside `910000-910099`, and no
  delete path at all. Ownership markers are written on create and re-checked before every later
  call, which is both how it refuses to touch a VM it did not create and how it recognises its
  own resource after a replay.

### 10. Proof, not assumption — back in `create-instance-workflow.ts`

The `observing` stage is the last one, and it exists because a successful mutation response
means the provider *accepted* the request, not that the result is what was asked for.
`observe` requires the VM to exist, to be running, and to carry exactly our ownership markers.

Anything short of that goes to `manual_review` — never to `failed`, because a create that may
have partially succeeded must not be reported as if nothing happened.

### 11. Readback — `packages/postgres-adapter/src/projection-store.ts`

Every checkpoint wrote an event to `workflow.outbox`. Debezium publishes it to
`provisioning.events.v1`, and `ProjectionConsumer` in the control API applies each event to both
the write tables and the read documents, committing its inbox receipt in the same transaction.

Ordering is the subtle part, and it is the broker's job: events are partitioned by
`partitionKey`, so everything touching one instance lands on one partition and is consumed in
order. Without that guarantee, a `completed` event could overtake a
`progressed` event and be overwritten by it, leaving a successfully built instance stuck at
`provisioning` forever.

The client's `GET /operations/{id}` now returns `succeeded`, and the instance reads `active`.

## Suggested reading order

If you want to understand the system rather than trace one request:

| Order | File | Why |
| --- | --- | --- |
| 1 | [glossary.md](glossary.md) | The vocabulary everything else assumes |
| 2 | `packages/application/src/ports.ts` | The map of every seam in the system |
| 3 | `packages/application/src/workflow-stage.ts` | The state machine, in one screen |
| 4 | `packages/application/src/control-plane.ts` | The service layer |
| 5 | `packages/application/src/create-instance-workflow.ts` | The saga and its safety rules |
| 6 | `packages/postgres-adapter/src/control-plane-store.ts` | The acceptance transaction |
| 7 | `packages/postgres-adapter/src/workflow-store.ts` | Inbox, leases, fencing |
| 8 | `packages/postgres-adapter/src/projection-store.ts` | Ordered read projections |
| 9 | `apps/*` | Transport and wiring — the thinnest layer |

`db/migrations/0001_phase3.sql` is worth keeping open alongside items 6–8.

## Phase 4 asynchronous path

Debezium and Kafka now replace the temporary `receiveCommand` and projection polling transport.
Start at `packages/messaging/src/kafka-consumer.ts`, then read
`apps/provisioning-orchestrator/src/app/command-consumer.ts` and
`apps/control-api/src/app/projections/projection-consumer.ts`. The owner tables, transaction
boundaries, command receipts, fencing tokens, and event contracts remain unchanged; the consumers
add explicit offset commits, bounded failure classification, quarantine, and governed replay.

`packages/observability/src/runtime.ts` owns SDK lifecycle and context propagation. Each service's
`main.ts` starts it before dynamically importing `bootstrap.ts`, so framework, HTTP, PostgreSQL, and
gRPC auto-instrumentation register before their modules load.

## Related reading

- [Comment Standard](comment-standard.md) — how this code is documented, and how to extend it
- [Phase 3 Vertical Slice](phase-3-vertical-slice.md) — stages, recovery, configuration
- [Phase 3 Persistence](phase-3-persistence.md) — schemas and the acceptance transaction
- [Phase 4 Messaging and Observability](phase-4-messaging-and-observability.md) — Kafka, replay, and telemetry path
- [Safety Invariants](safety-invariants.md) — the rules every pattern here protects
- [Failure Sequences](failure-sequences.md) — timeout, duplicate delivery, and compensation
