# Pattern Glossary

This document maps the patterns this codebase uses to the code that implements them. It
exists because Phase 3 is not a conventional `Controller → Service → Repository` CRUD
application, and reading it with that model in mind makes correct code look arbitrary.

**The one-sentence reason all of this exists:** creating a VM is a real, expensive,
non-reversible side effect on someone else's machine. A CRUD app can retry a failed `INSERT`
harmlessly. This system cannot retry a failed create harmlessly, because a retry might build
a second VM. Almost every pattern below is a defence against that single problem.

## How this differs from a typical NestJS application

| Typical NestJS app | This codebase | Why |
| --- | --- | --- |
| `InstancesService` in `apps/` | `ControlPlaneApplication` in `packages/application` | The application layer must be testable without a NestJS container and reusable by the future AWS Lambda path. It therefore imports nothing from `@nestjs/*`. |
| Service writes to the DB and then publishes | One transaction writes state *and* the event | A crash between two separate writes would either lose the work or duplicate it. See [Transactional outbox](#transactional-outbox). |
| Request handler does the work | Request handler records *intent*, a worker does the work | Provisioning takes minutes. `202 Accepted` returns immediately with an operation to poll. |
| `try/catch` + retry the call | Persisted stage, lease, and fencing token | A retry must be provably safe before it happens. See [Lease and fencing token](#lease-and-fencing-token). |
| One model for reads and writes | `control.*` write tables, `projection.*` read documents | See [Read projection](#read-projection-cqrs). |

The layer direction is not a suggestion — `eslint.config.mjs` enforces it with Nx tags:
`layer:domain` → `layer:contract` → `layer:port` → `layer:application` → `layer:adapter`.
A `pnpm lint` failure is the feedback if an import points the wrong way.

---

## Ports and adapters (hexagonal architecture)

**What it is.** The application layer declares *interfaces* describing what it needs from
the outside world. Concrete implementations live elsewhere and are injected at startup. The
interface is the "port"; the implementation is the "adapter".

**Why here.** ADR [0003](../adr/0003-postgresql-and-dynamodb-persistence-ports.md) commits
to running the same application logic over PostgreSQL today and DynamoDB later, and ADR
[0011](../adr/0011-provider-port-and-deterministic-fake.md) requires a deterministic fake
provider for tests. Both need the application layer to depend on an interface rather than a
vendor.

**Where in code.**

| Port | Adapter(s) |
| --- | --- |
| `ControlPlaneStore` (`packages/application/src/ports.ts`) | `PostgresControlPlaneStore` |
| `WorkflowStore` (`packages/application/src/ports.ts`) | `PostgresWorkflowStore` |
| `ProjectionStore` (`packages/application/src/ports.ts`) | `PostgresProjectionStore` |
| `ProviderPort` (`packages/provider-sdk/src/provider-port.ts`) | `FakeProvider`, `ProxmoxProvider` |

Wiring happens once per service in `app.module.ts` via `useFactory`. That is *why* the
application classes carry no `@Injectable()` decorator — decorating them would drag NestJS
into `packages/application` and break the property this pattern is buying.

---

## Transactional outbox

**What it is.** Instead of writing to the database and *then* publishing a message, the
message is written as a row in the same database, inside the same transaction as the state
change. A separate process reads that table and delivers the message.

**Why here.** The alternative fails in both directions. Publish first and the database write
may fail — a VM gets built for a request that was never accepted. Write first and the
publish may fail — the caller is told `202 Accepted` for work that never starts. One
transaction makes both impossible: the state change and the intent to act commit or roll
back together.

**Where in code.**

- `control.outbox` — written in `PostgresControlPlaneStore.acceptCreate`, in the same
  transaction as `control.instances`, `control.operations`, and `control.ipv4_leases`.
- `workflow.outbox` — written by `PostgresWorkflowStore.writeEvent`, in the same transaction
  as each workflow checkpoint.

**Phase 4 note.** Phase 3 read the outbox with a database poller. Phase 4 replaced that *reader*
with Debezium and Kafka per ADR [0005](../adr/0005-debezium-transactional-outbox.md); the pollers
have since been deleted. The tables, the transaction boundary, and the event contracts did not
change. That is the point of the pattern.

See also [Data Ownership Map](data-ownership.md).

---

## Inbox and command receipt

**What it is.** Before acting on a message, the consumer records its unique event ID. If the
same message arrives twice, the second arrival is recognised and ignored.

**Why here.** Message delivery is at-least-once by design (ADR
[0004](../adr/0004-kafka-at-least-once-delivery.md)). Duplicate delivery is normal, not
exceptional. Without an inbox, a redelivered create command builds a second VM.

**Where in code.** `workflow.command_receipts`, written by
`PostgresWorkflowStore.receiveCommand`. The claim query only selects outbox rows for which
`NOT EXISTS` a receipt, so a command is converted into a workflow exactly once. The
`payload_hash` column stores a canonical hash of the command so a redelivery whose *content*
differs can be detected rather than silently accepted.

The projection side has its own equivalent: `projection.event_receipts`.

---

## Lease and fencing token

**What it is.** A worker takes a time-limited, exclusive *lease* on an instance before
acting on it. Each lease grant increments a monotonic counter — the *fencing token*. Every
subsequent write must present the current token, so a worker holding an expired lease is
rejected.

**Why here.** Leases alone are not sufficient. Consider: worker A takes a lease, then stalls
(GC pause, network partition). The lease expires. Worker B takes over and proceeds. Worker A
then wakes up, unaware anything happened, and writes. A pure lease cannot stop that write —
the token can, because A's token is now stale.

**Where in code.**

- `workflow.instance_leases` — one row per instance, holding `owner_id`, `fencing_token`,
  and `leased_until`.
- Granted by the `INSERT … ON CONFLICT DO UPDATE` in `PostgresWorkflowStore.claimNextCreate`.
  The `WHERE leased_until <= now() OR owner_id = $worker` clause is what makes it exclusive:
  the update only fires if the lease has expired or the caller already owns it.
- Enforced by `PostgresWorkflowStore.assertLease`, called at the top of every `checkpoint`
  and `complete`. It verifies the workflow row's token, the lease owner, the lease token,
  and the expiry before any write is allowed.

This is why a database failure after a provider call is **not** turned into a business
failure. The lease simply expires, and the identical provider request — same request ID —
can be replayed safely. See [Safety Invariants](safety-invariants.md).

---

## Persisted saga (workflow state machine)

**What it is.** A long-running process broken into discrete stages, where the current stage
lives in the database rather than in a call stack or in process memory. Each execution
performs exactly one transition and commits it.

**Why here.** Creating a VM is roughly eight provider interactions spanning minutes. If that
lived in one `async` function, a process restart would lose all knowledge of how far it had
got — and the only safe response to "I don't know what I already did" is manual intervention.
Persisting the stage means any worker can resume from the last committed point.

**Where in code.**

- `workflow.workflows.stage` — the persisted position.
- `WorkflowStage` in `packages/application/src/workflow-stage.ts` — the stage list as a
  TypeScript union, with the progress table.
- `CreateInstanceWorkflow.execute` — the transition table, one `case` per stage.
- `CreateInstanceWorkflow.runOne` — claims, executes **one** transition, returns. The caller
  must claim again for the next. That is what keeps each transition individually durable.

The stage table with its external action and next safe action is in
[Phase 3 Vertical Slice](phase-3-vertical-slice.md#request-and-workflow).

---

## Read projection (CQRS)

**What it is.** Writes and reads use different models. Writes go to normalised, constrained
tables. Reads are served from pre-built documents shaped exactly like the API response.

**Why here.** An `Instance` API response merges desired state, observed provider state, the
IPv4 lease, drift classification, and the active operation. Assembling that with joins on
every `GET` is both slow and a second place where response shape can drift from the
contract. Building it once, when the state actually changes, keeps reads trivial.

**Where in code.**

| Purpose | Tables |
| --- | --- |
| Authoritative write model | `control.instances`, `control.operations` |
| Read model | `projection.instances`, `projection.operations` (single `document` jsonb column) |

`PostgresProjectionStore` applies each workflow event to both. Note that
`ControlPlaneStore.getInstance` and `listInstances` read from `projection.*`, while
`listImages`/`listFlavors`/`listNetworks` read `control.*` directly — catalog data is static
enough not to need a projection.

**Ordering matters.** Ordering is now the broker's job: commands and events are partitioned by
`partitionKey`, so everything touching one aggregate lands on one partition and is consumed in
order. Without that guarantee a `completed` event could overtake a `progressed` event and be
overwritten by it, leaving an instance permanently stuck at `provisioning`.

---

## Postgres advisory lock

**What it is.** An application-defined lock identified by an integer, held for the duration
of a transaction. It locks a *concept* rather than a row — including concepts whose row does
not exist yet.

**Why here.** Row locks cannot protect against two transactions both discovering that a row
is absent and both creating it. Both of this system's uses have exactly that shape:

1. **Idempotency** (`PostgresControlPlaneStore.lockIdempotencyScope`). Two concurrent
   requests with the same `Idempotency-Key` both `SELECT` from
   `control.idempotency_records`, both find nothing, both proceed to create. The lock
   serialises them, so the second finds the first's committed record and replays its
   response.
2. **IPv4 allocation** (`PostgresControlPlaneStore.reserveIpv4Address`). Two requests on the
   same network both scan existing leases, both compute the same lowest free address, and
   both claim it. The lock serialises the scan-then-allocate sequence.

Both use `pg_advisory_xact_lock`, which releases automatically at transaction end — there is
no unlock call to forget. The partial unique index on `control.ipv4_leases` remains the
final correctness guard; the lock exists to avoid losing work to constraint violations.

---

## Related reading

- [Code Reading Guide](code-reading-guide.md) — one create request traced end to end
- [Comment Standard](comment-standard.md) — how this code is documented and why
- [Phase 3 Vertical Slice](phase-3-vertical-slice.md) — stages, recovery, configuration
- [Phase 3 Persistence](phase-3-persistence.md) — schemas, records, the acceptance transaction
- [Safety Invariants](safety-invariants.md) — the rules every pattern above protects
