# Phase 4 Explained

A guided tour of what the backend actually does today, why each piece exists, and what is left.

This document is the human-readable companion to the reference material. Where
[Phase 4 Messaging and Observability](phase-4-messaging-and-observability.md) and
[Phase 4 Persistence](phase-4-persistence.md) state the rules precisely, this one explains the
reasoning, walks the code paths in order, and is honest about what is finished, what is in
flight, and what has not started.

---

## 1. The one problem everything is built around

Creating a virtual machine is a **real, expensive, non-reversible side effect on somebody else's
machine.**

A normal CRUD service can retry a failed `INSERT` and nothing bad happens. This system cannot
retry a failed create and assume nothing bad happens, because the retry might build a *second*
VM — one that costs money, holds an IP address, and that nobody knows about.

Almost every design decision below is a defence against that single sentence. When a piece of
the architecture looks over-engineered, ask "which duplicate-VM scenario does this close?" and
it usually becomes obvious.

There is a second rule that follows from the first, and it is absolute:

> **No failure path may automatically stop, delete, or purge a VM.**

When the system cannot prove what happened on the provider, it stops and asks for a human
(`manual_review`). It never guesses, and it never cleans up something it cannot prove it
created. See [Safety Invariants](safety-invariants.md).

---

## 2. What Phase 4 changed

Phase 3 already had the whole shape of the system: durable intent, a transactional outbox, a
leased and fenced workflow, a read projection. But the pieces talked to each other by
**polling database tables directly**. The orchestrator read `control.outbox` with SQL. The
projection read `workflow.outbox` with SQL. That works on one host and is honest scaffolding,
but it means every service can read every other service's tables.

Phase 4 replaces the *transport* and nothing else:

| Concern | Phase 3 | Phase 4 |
| --- | --- | --- |
| How a command reaches the orchestrator | SQL `SELECT` on `control.outbox` | Debezium reads the WAL → Kafka → consumer |
| How a fact reaches the read model | SQL `SELECT` on `workflow.outbox` | Debezium → Kafka → consumer |
| Who owns which tables | Everyone could read everything | Each schema has exactly one writer, and one reader path |
| Duplicate protection | Inbox receipt by `event_id` | Inbox receipt by `(consumer, event_id, replay_generation)` + broker coordinates |
| Failure of a bad message | Not modelled | Poison quarantine, governed dead letter, authorized replay |
| Retry policy | Implicit | 8 attempts / 15-minute budget / full-jitter backoff, persisted per stage |
| Observability | Basic | One trace across HTTP → Postgres → CDC → Kafka → workflow → provider → projection, plus a bounded metric contract |

**The tables, the transaction boundaries, and the event contracts did not change.** That was
the whole point of using an outbox in Phase 3: the reader is swappable, the writer is not.

---

## 3. The runtime map

Four Node.js services, one database, one broker, one CDC connector, and an evidence stack.

![Phase 4 runtime components](../diagrams/rendered/phase-4-components.mermaid.svg)

### The four services

| Service | What it is responsible for | What it deliberately does not have |
| --- | --- | --- |
| **`control-api`** | Authenticate, authorize, validate, commit durable intent, serve project-scoped reads, run the administrative dead-letter surface | No provider credentials, no provider calls, no long-running work |
| **`provisioning-orchestrator`** | Consume commands, deduplicate deliveries, run the leased workflow, call the provider, publish progress and terminal facts | No public API, no tenant authorization, no provider credentials |
| **`proxmox-provider`** | Hold provider credentials, implement the provider-neutral lifecycle port, translate provider errors | No knowledge of projects, quotas, Kafka, or workflow state |
| **`reconciler`** | *Reserved.* An instrumented process shell in this phase | Everything — it does no work yet |

The credential split is the important part. The orchestrator holds database credentials. The
provider service holds Proxmox credentials. Neither holds both. See
[Trust Boundaries](../security/trust-boundaries.md).

### The supporting infrastructure

- **PostgreSQL 16** — the only authoritative store. Four logical schemas: `control`,
  `workflow`, `projection`, `audit`.
- **Debezium Connect 3.4.3** — reads PostgreSQL's write-ahead log through a logical replication
  slot and routes committed outbox rows onto Kafka. It is a *reader*, never a writer.
- **Apache Kafka 4.1.2 (KRaft)** — retained, ordered, at-least-once transport. Six partitions
  per topic locally.
- **OpenTelemetry Collector** — the single funnel for all traces and metrics.
- **Tempo / Prometheus / Grafana** — the evidence stack. Nothing in the correctness path depends
  on any of them being up.

### The five topics

| Topic | Who writes | Who reads | Partitioned by |
| --- | --- | --- | --- |
| `provisioning.commands.v1` | Control API (`control.outbox`), Orchestrator (restored replays) | Orchestrator | Instance ID |
| `provisioning.events.v1` | Orchestrator (`workflow.outbox`) | Control API projection | Instance ID |
| `provisioning.dlq.v1` | Orchestrator | Control API administrator projection | Instance ID |
| `audit.events.v1` | Control API **and** Orchestrator | Future audit archive | **Project ID** |
| `reconciliation.events.v1` | *Reserved for the reconciler* | *Reserved* | Instance ID |

All five topics are created by the local stack even where no consumer is active yet, so the
topology matches the contract rather than the current implementation.

Partitioning by instance ID is what guarantees that two commands for the same VM are never
processed out of order. Audit facts partition by project instead, because their ordering
question is "what happened in this project?", not "what happened to this VM?".

---

## 4. One create request, end to end

This is the path a real request takes. Follow it once and most of the rest of the document
becomes reference material.

![Phase 4 event journey](../diagrams/rendered/phase-4-event-journey.mermaid.svg)

### Step 1 — The request arrives

`POST /v1/projects/{projectId}/instances` with an `Idempotency-Key` header.

`InstancesController` (`apps/control-api/src/app/instances/instances.controller.ts`) does
transport mapping only — read headers, build a DTO, call the application. It contains no
business logic by policy.

### Step 2 — Authorize and validate

`ControlPlaneApplication.createInstance` (`packages/application/src/control-plane.ts`) is the
real service layer. It lives in a package rather than in the app because it must not import
NestJS — that is what keeps it unit-testable without a container and reusable by the planned
AWS Lambda path.

It checks, in order: the actor has the `tenant_developer` role *and* explicit membership of
this project; the idempotency key is 8–128 characters; the request passes domain validation.

Then it computes a **canonical request hash** — a SHA-256 over the semantic content with SSH
keys sorted. This is what makes idempotency meaningful: two JSON bodies with keys in a
different order hash identically and are correctly recognised as the same request rather than
as a conflict.

### Step 3 — One transaction commits everything

`PostgresControlPlaneStore.acceptCreate` opens **one** PostgreSQL transaction and writes:

1. `control.instances` — the desired state
2. `control.operations` — the record the client will poll
3. `control.ipv4_leases` — the address, allocated now so it cannot be double-assigned
4. `control.idempotency_records` — including the exact response body, so a replay is
   byte-identical rather than rebuilt
5. **`control.outbox`** — the `instance.create.requested` command envelope
6. `audit.entries` + an `audit.recorded` envelope in `control.outbox`
7. Seed rows in `projection.instances` / `projection.operations`, so a client polling
   immediately after its `202` finds something

Everything commits or nothing does. That is the entire point:

- Publish the message first and the database write may fail → a VM gets built for a request
  that was never accepted.
- Write the database first and the publish may fail → the caller is told `202 Accepted` for
  work that never starts.

One transaction makes both impossible.

### Step 4 — `202 Accepted`

Not `201 Created`. Nothing has been created — only promised. The response carries an
`operationId` and a `statusUrl` to poll.

**This is the moment the request stops being synchronous.** Everything after this point
happens in the background, and the client learns about it by polling the operation.

### Step 5 — Debezium notices the commit

Debezium is tailing PostgreSQL's write-ahead log through the `private_cloud_outbox` logical
replication slot, watching `control.outbox` and `workflow.outbox`
(`deploy/local/debezium/outbox-connector.json`).

Its `EventRouter` transform turns the row into a Kafka record:

- **Key** ← the `partition_key` column (the instance ID)
- **Value** ← the `payload` column, expanded as JSON
- **Topic** ← the `topic` column, routed by value against an allowlisted set
- **Headers** ← `outbox-id`, `event-id`, `schema-name`, `schema-version`, `replay-generation`
- **Trace context** ← restored from the `tracingspancontext` column, so the Kafka producer span
  belongs to the *original request's* trace rather than starting a new one

Routing by an explicit `topic` column matters. The destination is a value the writer chose
deliberately and that a `CHECK` constraint restricts, not a name derived from payload data.

### Step 6 — The orchestrator admits the command

`CommandConsumer` (`apps/provisioning-orchestrator/src/app/command-consumer.ts`) receives the
record and hands it through the messaging trust boundary
(`packages/messaging/src/message-codec.ts`), which checks:

- the value is non-empty, valid JSON, and a well-formed versioned envelope
- the trace context is a real W3C `traceparent` (not the reserved all-zero trace/span IDs)
- the `replay-generation` header is a non-negative safe integer — `parseInt` is deliberately
  *not* used, because it would accept `1junk`
- the `outbox-id` header is a UUID
- **the Kafka key and identity headers agree with the envelope body.** A mismatched key would
  break per-instance ordering; mismatched headers would make broker inspection disagree with
  the durable record. Both are treated as poison, not as retriable failures.

Then `PostgresWorkflowStore.admitCreateCommand` opens **one** transaction that writes the inbox
receipt into `workflow.command_receipts` and creates the workflow row in `workflow.workflows`.

### Step 7 — The offset commits *last*

Auto-commit is disabled. `KafkaConsumerRunner` advances the offset only *after* the database
transaction commits (`packages/messaging/src/kafka-consumer.ts`).

A crash in the gap between those two commits is **expected and harmless**: Kafka redelivers the
record, the receipt insert hits its primary key conflict, and the handler reports `duplicate`
without touching the provider. Reversing the order would risk losing the record entirely.

Note that the Kafka record is *not* held open through provisioning. Admission is fast; the
actual work is scheduled durably in the database. Holding a partition for minutes while a VM
builds would cause head-of-line blocking for every other instance on that partition, and would
lose the schedule entirely on a consumer-group rebalance.

### Step 8 — The workflow runs, one stage at a time

`ProvisioningWorker` is a timer that does one thing: call
`CreateInstanceWorkflow.runOne()` (`packages/application/src/create-instance-workflow.ts`).

Each call claims one workflow, performs **exactly one** transition, commits it, and releases
the lease. The stages are:

```
accepted → submitting_create → polling_create → configuring
        → polling_configuration → starting → polling_start
        → observing → completed
```

Why one transition per claim rather than looping? Because each transition commits its own
checkpoint and releases the instance lease. Draining a whole workflow inside one claim would
hold the lease across several provider calls, so a crash partway would leave the instance
locked until the lease expired, with the committed stage lagging behind what the provider had
actually already been asked to do.

The final `observing` stage is the interesting one. It does not trust the `start` call's
success response — a successful mutation response says the provider *accepted* the request, not
that the result is what was asked for. It re-reads the VM and requires four things
simultaneously: it exists, its ownership markers are complete, they match, and it is running.
Anything less goes to `manual_review`, never to `failed`.

### Step 9 — Facts flow back

Every checkpoint writes its explaining event into `workflow.outbox` **in the same transaction**
as the stage change, so the stage and the event that justifies it can never disagree.

Debezium routes those to `provisioning.events.v1`. `ProjectionConsumer` in the Control API
consumes them, and `PostgresProjectionStore.applyWorkflowEvent` applies each one — receipt plus
state change plus read document — in one transaction, again committing the Kafka offset only
afterwards.

### Step 10 — The client sees it

`GET /v1/projects/{id}/operations/{operationId}` returns a single pre-built document from
`projection.operations`. No joins, no assembly at read time.

---

## 5. The five identities that make this safe

This is the conceptual core of Phase 4. Five different identifiers exist because five
different things can go wrong, and each identity closes exactly one door.

| Identity | Lives in | Closes this failure |
| --- | --- | --- |
| **Idempotency key** | `control.idempotency_records`, actor-scoped | The *client* retries the HTTP call. Same key + same canonical hash → the identical stored response. Same key + different content → `IDEMPOTENCY_CONFLICT`. |
| **`event_id`** | Every envelope; stable forever | Logical domain identity. Survives replay unchanged, so audit and causation chains stay walkable. |
| **`outbox_id`** | One physical CDC row; a new UUID every time | Distinguishes *this exact broker record* from another record carrying the same logical event. Propagated as the `outbox-id` header. |
| **`replay_generation`** | Outbox row, header, and inbox receipt | `0` for every normal delivery. Only the governed replay transaction may allocate a higher number. This is what separates "Kafka redelivered a record" from "an administrator authorized a second attempt". |
| **Fencing token** | `workflow.instance_leases`, monotonic `bigint` | Two workers. One stalls past its lease, another takes over. The stalled worker wakes up and tries to write — its token is now stale and matches no row, so the write is rejected instead of corrupting state. |

The inbox primary key is `(consumer_name, event_id, replay_generation)`. Read that as: *this
consumer has already handled this logical event at this permitted generation.*

A duplicate at generation 0 can never repeat a provider effect, because the receipt already
exists. A generation above 0 is accepted only when its payload hash **and** its outbox ID match
a durable pending authorization — which is the subject of section 8.

Command receipts additionally carry non-null `source_topic`, `source_partition`, and
`source_offset`. Migration `0005` made those columns mandatory after deleting historical
coordinate-free placeholders. The rule this enforces is worth stating plainly:

> **A command receipt is proof of a physical Kafka delivery.** Nothing may fabricate one.

---

## 6. The data model

Four schemas, each with exactly one writer.

### `control` — owned by the Control API

`projects`, `quotas`, `networks`, `provider_profiles`, `images`, `flavors`, `instances`,
`operations`, `ipv4_leases`, `idempotency_records`, `replay_requests`, `outbox`.

### `workflow` — owned by the Orchestrator

`command_receipts` (the inbox), `instance_leases`, `workflows`, `dead_letters`,
`poison_records`, `replay_requests`, `outbox`.

### `projection` — owned by the Control API's consumer

`event_receipts`, `instances`, `operations`, `dead_letters`, `poison_records`.

### `audit` — append-only, written by both owners

`entries`.

### The outbox shape

`control.outbox` and `workflow.outbox` have **deliberately identical columns**, so one Debezium
connector configuration routes both tables safely:

| Column | Purpose |
| --- | --- |
| `outbox_id` | Unique physical CDC row; a replay always gets a new one |
| `event_id` | Stable logical identity used by domain deduplication |
| `topic` | Explicit allowlisted destination (`CHECK` constrained to the five topics) |
| `partition_key` | Instance ID for provisioning, project ID for audit |
| `schema_name`, `schema_version` | The consumer's compatibility decision |
| `payload` | The complete validated envelope |
| `tracingspancontext` | Serialized W3C carrier that Debezium restores |
| `replay_generation` | `0` normally; incremented only by governed replay |
| `occurred_at`, `created_at` | Domain occurrence time and physical insert time |

Outbox rows are **never updated**. Debezium filters deletes. Cleanup stays disabled until
connector lag and the recovery horizon can be measured safely — deleting a row that Debezium
has not yet published would silently lose work.

### Migrations

`tools/db/migrate.mjs` discovers numbered SQL files, takes a PostgreSQL advisory lock, verifies
SHA-256 checksums against `public.schema_migrations`, and records each migration in the same
transaction as its SQL.

| Migration | What it does |
| --- | --- |
| `0001_phase3.sql` | The original schema |
| `0002_phase4_messaging.sql` | Rebuilds both outboxes with the Phase 4 shape, adds replay generation and broker coordinates to receipts, adds dead letters, poison records, and workflow retry/trace columns |
| `0003_phase4_projection_poison.sql` | Projection-side quarantine table |
| `0004_phase4_telemetry_completion.sql` | Retains the failed trace carrier on projected dead letters so replay can link to it |
| `0005_phase4_kafka_replay.sql` | Adds `workflow.replay_requests` (durable replay authority) and makes command-receipt broker coordinates mandatory |

---

## 7. What happens when things fail

Phase 4's real content is its failure taxonomy. The system distinguishes four fundamentally
different kinds of bad news, and treats each one differently.

![Phase 4 failure and recovery decisions](../diagrams/rendered/phase-4-failure-recovery.mermaid.svg)

### Kind 1 — Infrastructure is down

**Examples:** the database is unreachable, Kafka is down, the provider service is unreachable.

**Response: do nothing durable.** The Kafka offset is left uncommitted. The record stays in the
topic. When the dependency recovers, Kafka redelivers.

This is stated explicitly in `CommandConsumer.exhausted`: anything that is not a
`MessageDecodeError` or a `PermanentMessageError` is rethrown. *Converting an outage into a
dead letter would turn a temporary problem into permanent data loss.*

The API keeps accepting requests during a Kafka outage, because acceptance only needs
PostgreSQL. The `control.outbox` backlog grows, the `controlplane.outbox.pending` gauge rises,
and Debezium drains it after recovery. The original `event_id` is preserved throughout —
nothing needs re-submitting.

### Kind 2 — The message itself is untrustworthy

**Examples:** the value is not JSON, the envelope is malformed, the Kafka key disagrees with the
payload, the `replay-generation` header is `-1`.

**Response: quarantine it.** A row goes into `workflow.poison_records` or
`projection.poison_records` containing a SHA-256 hash of the payload, the topic/partition/offset,
a safe failure code, and a timestamp.

**The raw bytes are never stored, logged, or exported.** You get enough to find the record on
the broker and enough to recognise a repeat, and nothing else.

### Kind 3 — The message is valid but this deployment cannot handle it

**Examples:** a command schema this build does not know, an unsupported schema version.

**Response: a governed dead letter.** `workflow.dead_letters` retains the original envelope, the
failure classification, the attempt count, and a `replay_allowed` flag. A
`provisioning.dead_lettered` fact goes out through the workflow outbox to `provisioning.dlq.v1`,
where the Control API projects it for administrators.

The `replay_allowed` flag is set thoughtfully: an unsupported *schema* on a create command is
replayable (deploy compatibility and try again), because nothing was attempted.

### Kind 4 — The provider failed

This is the subtle one, and it lives in
`CreateInstanceWorkflow.handleProviderError`. The question is never *"did the call fail?"* but
**"did the provider act before it failed?"**

| Situation | Classification | Why |
| --- | --- | --- |
| Timeout or reset during a **mutation** stage (`submitting_create`, `configuring`, `starting`) | `manual_review` | The request may have arrived and built a VM whose response never came back. Retrying could produce a second VM. |
| `protocol_error` during a mutation | Ordinary failure | A malformed request was rejected *before* any action, so nothing happened. |
| Any failure during a **read-only** stage (task polling, observing) | Retryable | Repeating a `GetTask` changes nothing. |
| Provider returns `REJECTED` | `failed` | The provider explicitly refused; nothing was built. |
| Provider returns `UNKNOWN` | `manual_review` | The provider is telling you it cannot say what happened. |
| Provider forgot the task (`PROVIDER_TASK_STATE_UNKNOWN`) | `manual_review` | Common when a task ages out of provider history. The mutation may well have succeeded. |
| Observation cannot prove an owned, running VM | `manual_review` | A create that may have partially succeeded must not be reported as if nothing happened. |

Note the default in `providerFailureCategory`: an *unrecognised* failure category maps to
`permanent`, not `transient`. Retrying an unknown is the dangerous choice, so the conservative
reading wins.

`failed` and `manual_review` are not "bad" and "worse" — they are **different claims**.
`failed` asserts nothing was left behind. `manual_review` explicitly declines to assert that,
and sets `compensationState: 'unsafe'`, because deleting a VM that might be somebody's running
workload is worse than leaving an orphan for an operator to inspect.

### The retry policy, exactly

For genuinely retryable failures (`CreateInstanceWorkflow.retryOrDeadLetter`):

- **At most 8 attempts per stage**
- **Inside a 15-minute budget** measured from `retry_started_at`
- **Full-jitter backoff**: `delay = random() × min(30s, 500ms × 2^(attempt−1))`, then clamped to
  the remaining budget
- **State is persisted** in `stage_attempt`, `retry_started_at`, `last_error_category`, and
  `last_error_code` on the fenced workflow row — so a restart does not reset the count
- **Forward progress resets it.** Successfully reaching the next stage clears `stage_attempt`
  and `retry_started_at`

When the budget or attempt ceiling is hit and the failure was safely replayable, **one fenced
transaction** commits: the failed operation, the closed command receipt, the sanitized dead
letter, the DLQ outbox fact, the audit fact, and the lease release. Never partially.

![Retry exhaustion decisions](../diagrams/rendered/phase-4-retry-exhaustion.mermaid.svg)

### Worker death

A worker that dies mid-provision loses nothing, because the workflow row already holds the
provider resource ID and the provider task reference.

`claimNextCreate` does the recovery in one query. Its lease `INSERT … ON CONFLICT DO UPDATE`
has a `WHERE` clause that fires **only** when the existing lease has expired or this worker
already owns it. When it fires, `fencing_token` increments — which is what invalidates the
previous holder even if that process is still running and unaware it lost the lease.

`FOR UPDATE OF w SKIP LOCKED` is what makes multiple replicas safe: each worker locks a
different row and skips rows already locked, rather than queueing behind them.

The lease is released at the end of *every* checkpoint by setting `leased_until` to now rather
than deleting the row — deleting would reset the token sequence and let a long-stalled worker's
old token look valid again.

![Leased checkpoint recovery](../diagrams/rendered/phase-4-checkpoint-recovery.mermaid.svg)

---

## 8. Governed replay — the most intricate path

Replay is **an authorized redelivery, not a raw topic copy.** An operator never republishes a
record by hand, and no console producer is allowed near the command topic.

![Governed replay](../diagrams/rendered/phase-4-replay.mermaid.svg)

### The request

```
POST /v1/admin/dead-letters/{originalEventId}/replays
Authorization: Bearer <platform-admin-token>
Idempotency-Key: <unique-operator-request-id>
{"reason": "Compatibility deployed; retry approved under incident INC-1234."}
```

Requirements: the `platform_administrator` role (never inferred from project membership), an
idempotency key, and a reason of 10–512 characters.

`PostgresControlPlaneStore.requestDeadLetterReplay` takes an advisory lock scoped to
actor + key, checks the dead letter exists and is `replayAllowed` (otherwise `REPLAY_NOT_ALLOWED`),
writes `control.replay_requests`, and emits a `provisioning.replay.requested` event to
`control.outbox` — bound for `provisioning.commands.v1` at **generation 0**, because the request
itself is a new fact, not a replay.

The API returns `202`. Nothing has been replayed yet.

### The authorization

The orchestrator consumes that request. `admitReplayRequest` opens one transaction and:

1. Inserts the inbox receipt (a duplicate request is short-circuited here)
2. Locks the dead letter `FOR UPDATE` and re-validates the stored original command **against
   the currently deployed contract**
3. If it still cannot be validated → mark the request `rejected`, publish
   `provisioning.replay.resolved` with outcome `rejected`, write the audit fact, and **leave the
   dead letter open** so a later attributed request can try again after a compatibility deploy
4. If it validates → compute `replay_generation = n + 1`, rebuild the original command with a
   new correlation/causation/trace context, and record **durable authority** in
   `workflow.replay_requests`: the exact `authorized_command_hash` and a freshly minted
   `authorized_outbox_id`
5. Write the restored command into `workflow.outbox` **using that exact outbox ID** and
   generation `n+1`
6. Mark the dead letter `replay_requested`

**The workflow is not reopened in this transaction.** That is the design decision that took the
longest to get right.

### The delivery

Debezium publishes the restored row. Kafka delivers it back to the orchestrator's command
consumer at generation `n+1`.

`admitAuthorizedReplayCommand` then requires **three** things to line up before any provider
work can resume:

- the generation matches a `workflow.replay_requests` row in status `authorized`
- the canonical payload hash matches `authorized_command_hash`
- the `outbox-id` header matches `authorized_outbox_id`

Only then does it reopen or create the workflow, mark the dead letter `replayed`, mark the
authority `completed`, and publish `provisioning.replay.resolved`.

Anything else — wrong hash, wrong outbox ID, no authority — is quarantined as
`REPLAY_COMMAND_UNAUTHORIZED` **without consuming the valid pending authority**, so a forged
record cannot burn a legitimate replay.

On reopen, the stale `provider_resource_id` and `provider_task_reference` are deliberately
cleared. The replay is a fresh provider attempt, and the derived request identity — not an
ambiguous pre-exhaustion task handle — is what protects against a duplicate effect.

### Why the two-phase dance?

Because it removes Kafka from the request transaction while still guaranteeing that every
command receipt is genuine broker evidence.

If Kafka is down after authorization, you are left with a durable authority row and an
immutable outbox row. Nothing is lost, nothing is half-done, and Debezium resumes publication
after recovery. The dead letter simply sits in `replay_requested` until the record actually
arrives.

The earlier design inserted the restored command straight into the workflow transaction. It
worked, but it meant a command receipt could exist for a record Kafka never carried — and the
whole delivery-identity story depended on that not being true. Migration `0005` deletes those
historical placeholders and makes the coordinates `NOT NULL`.

### The trace decision

Replay deliberately **starts a new trace** with a *span link* to the original failed trace,
rather than making the failure the parent.

The failed work is over. An operator action minutes or days later is a new causal story that
*references* the old one. The Control API keeps the failed event's bounded W3C carrier in
`projection.dead_letters.trace_context` purely so it can add that link on
`controlplane.replay.request`.

---

## 9. Audit facts

Any service that changes state writes both its `audit.entries` row **and** an `audit.recorded`
envelope into its own outbox, in the transaction that owns the change.

- **Control API facts** carry the authenticated actor and role.
- **Orchestrator facts** use the fixed service identity `provisioning-orchestrator` with role
  `service`. After the command boundary the orchestrator does not know the original human, and
  it does not pretend to.
- **Replay facts** carry the replay request UUID as `reasonReference`. The reason *text* stays
  in restricted owner storage and never reaches Kafka.

Audit facts get new event IDs at generation 0, because they are new facts rather than replays.
Their `causationId` points at the command, terminal event, or replay request that produced the
decision — giving the archive a walkable causal chain without high-cardinality metric labels or
fabricated broker metadata.

The audit event ID is also the relational row ID, so the two can always be joined.

---

## 10. Telemetry

![Phase 4 telemetry pipeline](../diagrams/rendered/phase-4-telemetry-pipeline.mermaid.svg)

### Tracing across an asynchronous boundary

The hard problem: a request spans HTTP, a database commit, CDC, a broker, a consumer, several
minutes of provider work, a process restart, and a projection. You cannot hold one span open
across that.

The solution has three parts:

1. **Register OpenTelemetry before anything else.** Each entry point calls `startTelemetry()`
   before importing NestJS, the database driver, Kafka, or gRPC, so the instrumentations can
   patch those modules.
2. **Persist the carrier, not the span.** The W3C `traceparent` (and optional `tracestate`) is
   stored in the event envelope, in the Debezium carrier column (`tracingspancontext`), and on
   the workflow checkpoint (`trace_context`).
3. **Restore it into short-lived spans.** Consumers and resumed workflow stages extract the
   stored carrier and start a *new* short span with it as parent.

The rule: **no span stays open while work waits in Kafka, sleeps for a retry backoff, or waits
on a provider task.**

![Phase 4 trace hierarchy](../diagrams/rendered/phase-4-trace-hierarchy.mermaid.svg)

Manual spans mark the business boundaries that driver instrumentation cannot infer:

```
controlplane.command.accept              controlplane.transaction.*
controlplane.outbox.write                controlplane.transaction.command_admission
controlplane.workflow.stage              controlplane.workflow.retry_decision
controlplane.dead_letter.persist         controlplane.replay.request / .decision
controlplane.projection.apply            controlplane.provider.adapter
controlplane.workflow.compensation_decision
```

Standard HTTP, gRPC, PostgreSQL, Undici, host, Node.js runtime, and event-loop
instrumentations stay enabled alongside them.

One deliberate exception: **Kafka auto-instrumentation is disabled.** It overwrites the restored
W3C header with a new root trace, which would sever the very continuity this design exists to
preserve. A checksum-pinned Debezium interceptor restores the Event Router context before the
producer span instead.

### Metrics, and why they are so restrained

Sixteen custom instruments, listed in full in the
[Phase 4 Metric Catalog](../observability/phase-4-metric-catalog.md).

The design constraint is **cardinality**. Prometheus stores one time series per unique label
combination. Putting an instance ID in a label creates one series per VM forever, and that is
how monitoring systems fall over.

So there is a hard rule:

> Project, instance, operation, event, resource, provider-task, address, credential, hostname,
> and tenant-configuration values are **never** metric labels. They may be trace attributes or
> restricted log fields, where allowed.

Metric labels are bounded classifications only: schema names, consumer groups, workflow stages,
outcomes, safe error categories.

And this is not enforced by call-site convention — it is enforced by **one exact OpenTelemetry
SDK view per instrument**, each carrying an explicit attribute allowlist and a 128-series
aggregation cardinality cap (`packages/observability/src/runtime.ts`). An attribute that is not
on the list is dropped by the SDK before export.

Histogram boundaries are explicit rather than defaulted, in seconds:

- **Async delivery and event age:** `0.005 … 900` (5 ms to 15 minutes)
- **Provider and projection operations:** `0.005 … 60` (5 ms to 60 seconds)

Explicit boundaries survive OTLP export and Prometheus translation unchanged, so a dashboard
query means the same thing everywhere.

### The Collector pipeline

Every service pushes OTLP to the Collector. **Prometheus scrapes exactly one target** — the
Collector's consolidated endpoint.

The Collector also:

- receives JMX-derived metrics from the Kafka broker and Connect worker Java agents
- reads PostgreSQL transaction and lock metrics directly
- runs a SQL query receiver for logical replication-slot activity and retained WAL
- scrapes its own pipeline metrics
- runs a **span-metrics connector** that derives latency histograms from traces, which is where
  real trace exemplars come from
- **sanitizes resources** — hostnames, container IDs, process commands, executable paths, PIDs,
  and service-instance IDs are removed before export

That last point was the subject of a whole re-audit. An early pass checked only
`controlplane_*` series for prohibited labels and reported clean, while 406 *standard* HTTP
series were still carrying `server_address` values with local hostnames and an IP. The
redaction is now central, and the check is global.

Applications never push to Prometheus and never depend on a telemetry backend for correctness.
Telemetry going down is an observability incident, not an outage.

---

## 11. Running it locally

```bash
pnpm run verify:phase4-runtime -- --reset
```

That single command builds the production images, starts the full Compose topology from clean
volumes, runs migrations and seeds, registers the connector, executes every drill, scans
exported telemetry for prohibited values, captures Grafana and Tempo screenshots, writes
machine-readable evidence to `docs/verification/evidence/phase4-runtime.json`, and leaves the
stack running.

For inspection without rerunning the drills:

```bash
docker compose -f deploy/local/compose.phase4.yaml up -d --build
docker compose -f deploy/local/compose.phase4.yaml ps -a
```

| Surface | URL |
| --- | --- |
| Control API | `http://127.0.0.1:3100` |
| Grafana | `http://127.0.0.1:3101` |
| Prometheus | `http://127.0.0.1:9090` |
| Tempo | `http://127.0.0.1:3200` |
| Kafka Connect | `http://127.0.0.1:8083` |

The stack runs 13 containers: 12 health-checked long-running services plus Tempo, and five
one-shot initialization jobs (migrate, seed, OIDC issuer, TLS certificate generation, topic
creation, connector registration).

Two things in that topology are worth flagging:

- **The local OIDC issuer is deterministic and local-only.** Its signing key must never leave
  this environment.
- **The Proxmox path runs against a local TLS Proxmox-compatible simulator.** It exercises the
  real adapter, the real gRPC boundary, real HTTPS, allowlisted endpoints, and task polling —
  but **no hypervisor is contacted or mutated.**

Everything is version-pinned: Kafka 4.1.2, Debezium Connect 3.4.3, OpenTelemetry Collector
Contrib 0.158.0, Tempo 2.10.7, Prometheus 3.12.0, Grafana 13.1.0, PostgreSQL 16.10. Remote Java
agents are checksum-verified.

Operational procedures for each failure mode are in the
[Phase 4 Failure Recovery Runbook](../runbooks/phase-4-failure-recovery.md).

---

## 12. Where the system actually stands

This section is deliberately blunt, because the difference between "written" and "proven" is
the whole point of the verification discipline in this repository.

### Proven and committed

Checkpoints 1 through 8 are complete, each with recorded evidence
(`phase-4-completion-checkpoints.md`). As of commit `0d541b5`:

- Durable retry, exhaustion, and recovery policy — with deterministic unit tests for the exact
  eighth-attempt exhaustion, the 15-minute budget, jitter bounds, and terminal routing
- Complete telemetry semantics — real trace exemplars proven through the Prometheus exemplar
  API, global label redaction across 7,169 series, and a verified CDC trace structure
  (`db-log-write` → `debezium-read` → 11 Kafka producer spans) preserving the original context
- Transactional audit publication from both owners, verified against a live Debezium and Kafka
  drill
- The full containerized environment with infrastructure metrics
- A repeatable end-to-end runtime gate covering happy path, Kafka outage, consumer outage,
  checkpoint restart, retryable failure, permanent failure, ambiguous outcome, exact
  eight-attempt exhaustion, denied replay, successful generation-one replay, and poison
  quarantine — measured at 465 seconds from clean volumes, with 290 spans in a single trace
- 28 Mermaid diagrams, each validated against its rendered SVG by `docs:validate`

### In progress right now

**Checkpoint 9 — Kafka-backed authorized replay.** The code described in section 8 is written
and staged in the working tree. Its PostgreSQL drill passed on a clean database: duplicate
request deduplication, deterministic replay denial, wrong-outbox quarantine without consuming
authority, a generation-one command outbox row, and a matching receipt with real broker
coordinates.

The full runtime matrix was **intentionally stopped before completion**. The evidence file
`docs/verification/evidence/phase4-runtime.json` currently records `status: "failed"` on a
duplicate-message metric timeout, and is deliberately left unstaged for follow-up.

**Do not treat the Phase 4 runtime gate as passed.** The README's "complete and verified"
language reflects checkpoint 6; the strict re-audit at checkpoint 7 reopened the gate.

### Not started

- **Checkpoint 10** — extending the repeatable verifier with the new exemplar, global-redaction,
  CDC span-kind, and authorized-replay assertions, then a full clean-volume run with refreshed
  evidence and screenshots.
- **Checkpoint 11** — the final quality gate and closure.

### Known loose ends in the tree

- `apps/control-api/src/app/projections/projection-worker.ts` and
  `ProjectionStore.applyNextWorkflowEvent` are **Phase 3 leftovers**. The class is no longer
  registered in `app.module.ts` — `ProjectionConsumer` replaced it — but the file and the port
  method still exist. They are dead code, not an active second path.
- KafkaJS 2.2.4 on Node.js 24 emits `TimeoutNegativeWarning` from its internal request queue
  during broker recovery. The drills complete; this is recorded openly as a dependency signal to
  reassess before choosing a production runtime, not suppressed.
- The production dependency audit's high and moderate findings all resolve through the
  separately developed `apps/console-web` React Router path. No advisory reaches a Phase 4
  service or shared runtime package.

### What Phase 4 explicitly does not claim

Single-broker local evidence is not production Kafka. This phase makes no claim about
replication, Kubernetes or KEDA deployment, SLOs and alerts, load capacity, database failover,
an active reconciliation loop, centralized logs, or a live Proxmox mutation.

---

## 13. What comes next

The numbered roadmap lives in `private-cloud-control-plan.md` at the repository root — Phases 0
through 10, each with a timebox, a task list, and a completion gate. (That file is currently
untracked in git, so it is referenced here by name rather than linked.) This section maps it
against what is actually built.

### The full phase sequence

| Phase | Subject | State |
| --- | --- | --- |
| 0 | Freeze the product scope — capability matrix, safety invariants, lab boundary | Complete |
| 1 | PRD, SRS, traceability, C4, state machines, threat model, initial ADRs | Complete |
| 2 | Repository, REST/gRPC/event contracts, deterministic fake provider, quality gates | Complete |
| 3 | Synchronous vertical slice — create through the fake provider, then one allowlisted Proxmox create | Complete |
| **4** | **Kafka and transactional outbox** | **Current** |
| 5 | Port the useful lifecycle capabilities | Next |
| 6 | Kubernetes and GitOps deployment | Pending |
| 7 | Observability and SLOs | Pending (partly pulled forward) |
| 8 | Load, backpressure, and failure drills | Pending |
| 9 | AWS serverless and DynamoDB version | Pending |
| 10 | Release and portfolio evidence | Pending |

### Phase 4 against its own gate

The plan sets four completion criteria for this phase, and all four are measured as passing in
the [local verification record](../verification/phase-4-local-verification.md):

1. The API continues accepting committed requests during a Kafka outage.
2. Pending outbox records drain after recovery.
3. Duplicate delivery creates no duplicate VM.
4. Restarting the orchestrator resumes the existing provider task.

So Phase 4 meets the roadmap's gate. What is still open is the repository's own **stricter**
checkpoint ledger — checkpoints 9, 10, and 11 in `phase-4-completion-checkpoints.md`, which
added the Kafka-backed replay path, the extended runtime evidence, and the final quality gate
after the checkpoint 7 re-audit. Those are self-imposed rigour beyond the plan, not plan
requirements.

The implementation has also run ahead of the plan in one direction. The roadmap's Phase 4 asks
only to *"preserve tracing context through the outbox"*; what shipped is a complete metric
contract, SDK-enforced cardinality views, real trace exemplars, and Collector-side
infrastructure metrics. Those are Phase 7 items delivered early.

### Phase 5 — Port the useful lifecycle capabilities

Timeboxed at two days, and explicitly **one capability at a time**, in this order:

1. List, inspect, and observed status
2. Start, graceful shutdown, stop, and reboot
3. CPU and memory resize
4. Disk growth (grow only — never shrink)
5. IPv4 lease reservation and release
6. Snapshot create, list, delete, and rollback
7. Soft deletion and retained-resource state
8. Administrative purge
9. Reconciliation and drift reporting

Each capability must arrive with the full set, not a partial one: contract, authorization rule,
idempotency behaviour, locking behaviour, provider call map, retry classification, compensation
or manual-recovery rule, tests, spans/metrics/logs, and a runbook update. The plan is explicit
that a change may not begin a second capability.

Item 9 is what activates `apps/reconciler` and the reserved `reconciliation.events.v1` topic —
periodic observation, desired-versus-observed drift classification, stale-operation detection,
and **non-destructive** recovery proposals only. Per
[ADR-0008](../adr/0008-non-destructive-reconciliation.md), reconciliation reports destructive
drift; it never automatically destroys, shrinks, detaches, or overwrites.

Two items carry extra safety weight. Disk can grow but never shrink. Purge requires both
database ownership *and* matching live provider ownership markers after a retention window
([ADR-0007](../adr/0007-soft-delete-and-guarded-purge.md)).

The command contracts for all of these already exist in AsyncAPI — `InstancePowerRequested`,
`InstanceResizeRequested`, `SnapshotCreateRequested`, `SnapshotRollbackRequested`,
`SnapshotDeleteRequested`, `InstanceRetentionRequested`, `InstancePurgeRequested`. Only
`create` has an implementation behind it.

### Phase 6 — Kubernetes and GitOps deployment

Strimzi, Kafka, Kafka Connect, CloudNativePG, and KEDA declared declaratively; namespaces,
service accounts, RBAC, network policies, pod disruption budgets, resource requests and limits,
and topology spreading; Strimzi-generated Kafka credentials; the existing Longhorn storage class
and Gateway/certificates/Argo CD reused rather than replaced.

Argo sync waves run in a fixed order: operators and CRDs → database and Kafka → observability →
applications → dashboards and alerts. The gate is a verified cluster from a fresh Argo sync with
the exact commands and results recorded.

Per [Repository Boundaries](repository-boundaries.md), none of this lands here — Kubernetes
runtime state and observability deployments belong in a **separate GitOps repository**. This one
owns application source, contracts, migrations, tests, and documentation.

### Phase 7 — Observability and SLOs

The instrumentation half is largely done. What remains is the operational half: five dashboards
(control-plane overview, event pipeline and backpressure, provider operations, instance
lifecycle, SLO and error-budget), plus alerts on outbox oldest age, non-empty DLQ, queue latency
and consumer lag, provider failure ratio, stuck operations, Kafka replicas below ISR, and
Collector export failure.

Also outstanding from the plan's metric list: Kafka consumer lag, DLQ depth, KEDA replica count,
and OTel exporter failures. The
[metric catalog](../observability/phase-4-metric-catalog.md) says this plainly — its queries are
diagnostic views, and thresholds require measured baselines that do not exist yet.

### Phase 8 — Load, backpressure, and failure drills

k6 against REST and gRPC with the fake provider, ramping to 1,000–2,000 virtual users to measure
*command acceptance* rather than 2,000 real clones; observe Kafka lag and KEDA scaling, find
saturation points, verify the provider concurrency cap. Real Proxmox operations are capped at
5–20.

The drill list extends Phase 4's: broker outage, orchestrator killed mid-operation, duplicate
event, provider timeout, provider reporting late success, **database failover**, reconciler
detecting an externally changed VM, **Collector unavailable**, and DLQ replay. The output is a
resilience report structured as hypothesis, action, signals, result, recovery, follow-up.

### Phase 9 — AWS serverless and DynamoDB version

The same domain and event contracts over API Gateway and a command Lambda, a DynamoDB
transaction writing aggregate and outbox items together, a DynamoDB Streams relay Lambda into SQS
FIFO with partial-batch-failure handling, an EventBridge Scheduler timeout watchdog, an S3 audit
archive, and IAM/KMS/log retention/alarms/PITR/tagging/budgets — deployed with Terraform and
GitHub OIDC.

Gate: duplicate stream records are harmless, partial batch failure retries only the unsuccessful
records, poison messages reach the DLQ, no static AWS access keys exist, and Terraform can create
and destroy the sandbox repeatably. Explicitly excluded: MSK, EKS, production multi-account.

This is the payoff for `packages/application` importing nothing from NestJS — the use cases move
unchanged and only the adapters are rewritten. It accepts commands and demonstrates reliable
publication; it does not run long Proxmox provisioning inside Lambda
([ADR-0009](../adr/0009-bounded-aws-reference-slice.md)).

### Phase 10 — Release and portfolio evidence

Publish the architecture overview, PRD and SRS, ADR index, contracts, threat model, SLOs and
runbooks, failure-test and load-test reports, Grafana screenshots, one full Tempo trace, KEDA
scale evidence, Argo deployment evidence, AWS architecture and Terraform plan, known limitations,
and a five-minute demo script.

The plan is firm about the wording: **do not claim "production grade."** The claim is a
production-oriented architecture validated in a controlled lab.

### Live Proxmox activation

This is a gate rather than a phase, and it blocks any real mutation at any point. Everything so
far has run against a simulator. Going live requires the seven-point activation gate in
[Lab Boundary](lab-boundary.md) — endpoint and cluster identity confirmed, allowlist values
matched, every VMID in the reserved `910000–910099` range verified free or already owned, the
provider identity proven to have VM permissions and *no* host-lifecycle permissions, a dry-run
create resolving only allowlisted values, a passing fake-provider suite, and a recorded test cap
with a named cleanup owner.

### What the plan explicitly removes

Worth knowing so you do not go looking for it: automatic placement and weighted scheduling, live
migration, storage balancing, hypervisor host lifecycle, Proxmox network/SDN orchestration, LXC,
hardware passthrough, image building, billing, multi-region active-active, service mesh, Temporal
or another workflow platform, and a custom identity platform.

Stretch items sit behind the core evidence: VM adoption, backup and restore, noVNC console
tickets, a node-local inventory agent, IPv6, a read-only UI, and a second real provider.

## 14. Reading the code

Suggested order, roughly following a request:

| Order | File | What you learn |
| --- | --- | --- |
| 1 | `packages/application/src/ports.ts` | Every interface the application needs from the outside world |
| 2 | `packages/application/src/control-plane.ts` | The synchronous service layer: authorize, validate, delegate |
| 3 | `packages/postgres-adapter/src/control-plane-store.ts` | The acceptance transaction — start at `acceptCreate` |
| 4 | `packages/messaging/src/message-codec.ts` | The messaging trust boundary |
| 5 | `packages/messaging/src/kafka-consumer.ts` | Explicit offset commits and bounded handler retries |
| 6 | `apps/provisioning-orchestrator/src/app/command-consumer.ts` | Command ingress and the failure-kind decision |
| 7 | `packages/postgres-adapter/src/workflow-store.ts` | Inbox, lease, fencing, dead letters, and the replay authority |
| 8 | `packages/application/src/create-instance-workflow.ts` | The saga, the retry policy, and the safety branches |
| 9 | `apps/control-api/src/app/projections/projection-consumer.ts` | The read-model consumer |
| 10 | `packages/observability/src/runtime.ts` | Spans, instruments, and the SDK views that enforce cardinality |

Two conventions that look wrong and are not:

- **`packages/application` carries no `@Injectable()`.** Its classes are constructed explicitly
  in each `app.module.ts` through `useFactory` with `Symbol` tokens. Adding decorators would
  drag NestJS into the application layer and destroy both the container-free tests and the AWS
  reuse path.
- **There are no pass-through `*.service.ts` files in `apps/`.** The service layer already
  exists; it lives in `packages/application`. A file that only forwards to it adds a hop that
  does nothing.

Dependency direction is enforced mechanically by Nx tags in `eslint.config.mjs`:

```
layer:domain → layer:contract → layer:port → layer:application → layer:adapter
```

A wrong-way import fails `pnpm lint`, not review.

---

## Related reading

- [Pattern Glossary](glossary.md) — each pattern mapped to the code that implements it
- [Code Reading Guide](code-reading-guide.md) — one create request through every file it touches
- [Phase 4 Messaging and Observability](phase-4-messaging-and-observability.md) — the precise reference
- [Phase 4 Persistence](phase-4-persistence.md) — outbox, inbox, and delivery identity rules
- [Phase 4 Failure Recovery](../runbooks/phase-4-failure-recovery.md) — operational procedures
- [Phase 4 Metric Catalog](../observability/phase-4-metric-catalog.md) — instruments and label rules
- [Phase 4 Local Verification](../verification/phase-4-local-verification.md) — measured evidence
- [Safety Invariants](safety-invariants.md) — the non-negotiable rules
- [ADR-0012](../adr/0012-phase-4-delivery-and-telemetry-runtime.md) — why delivery state and trace context are explicit
