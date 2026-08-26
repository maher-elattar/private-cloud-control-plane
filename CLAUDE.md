# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## What this is

A provider-neutral control plane for asynchronous VM lifecycle management. REST/gRPC accept
_intent_, PostgreSQL commits it durably with a transactional outbox row, an orchestrator
executes leased and fenced workflow checkpoints against a provider over internal gRPC, and
ordered read projections serve readback. Proxmox is the first provider adapter, not a domain
dependency.

Phase 3 (the synchronous, pre-Kafka create slice) is complete. Kafka and Debezium arrive in
Phase 4 and replace the database pollers _only_ — the tables, transaction boundaries, and
event contracts stay as they are.

## Read these first

- [Pattern Glossary](docs/architecture/glossary.md) — outbox, inbox, lease/fencing token,
  persisted saga, read projection, advisory lock, ports and adapters. **This codebase is not
  a `Controller → Service → Repository` CRUD app; the glossary explains what it is instead.**
- [Code Reading Guide](docs/architecture/code-reading-guide.md) — one create request traced
  end to end through every file it touches.
- [Comment Standard](docs/architecture/comment-standard.md) — **follow this when writing or
  editing code here.** Header blocks, JSDoc on exported symbols, `WHY:` on safety decisions,
  named constants. Partly enforced by `eslint-plugin-jsdoc`.
- [Safety Invariants](docs/architecture/safety-invariants.md) — the non-negotiable rules.

## Layer rule

Dependency direction is enforced mechanically by Nx tags in `eslint.config.mjs`:

```
layer:domain → layer:contract → layer:port → layer:application → layer:adapter
```

`apps/*` (`type:app`) may depend only on projects tagged `visibility:production`. A wrong-way
import fails `pnpm lint`, not review.

| Project                      | Role                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/domain`            | Framework-free types, validation, canonical hashing, IPv4 allocation                       |
| `packages/contracts`         | OpenAPI/protobuf/AsyncAPI sources and generated types                                      |
| `packages/provider-sdk`      | Provider-neutral lifecycle port and transport errors                                       |
| `packages/application`       | **The service layer** — `ControlPlaneApplication`, `CreateInstanceWorkflow`, and the ports |
| `packages/postgres-adapter`  | `ControlPlaneStore`, `WorkflowStore`, `ProjectionStore` implementations                    |
| `packages/provider-adapters` | Deterministic fake and allowlisted Proxmox implementations                                 |
| `apps/*`                     | NestJS transport, DI wiring, and process lifecycle only                                    |

## Conventions that are deliberate — do not "fix" them

- **`packages/application` imports nothing from `@nestjs/*`.** Its classes carry no
  `@Injectable()`; they are constructed in `app.module.ts` through `useFactory` with `Symbol`
  DI tokens. This is what keeps the application layer testable without a Nest container and
  reusable by the planned AWS Lambda path. Adding decorators would destroy that.
- **Do not add pass-through `*.service.ts` files in `apps/`.** A service that only forwards
  to `ControlPlaneApplication` adds a hop that does nothing. The service layer already
  exists; it lives in `packages/application`.
- **Controllers stay thin.** Transport mapping, nothing else. No persistence, no provider
  calls, no business rules.
- **Never add a destructive compensation path.** No failure branch may automatically stop,
  delete, or purge a VM. Ambiguous outcomes go to `manual_review`. See
  [Safety Invariants](docs/architecture/safety-invariants.md).
- **Contracts are generated, not hand-edited.** Change the source in `packages/contracts`,
  then run `pnpm run contracts:generate`. `packages/contracts/src/generated` is lint-ignored.

## Quality gate

Run before considering work complete:

```bash
pnpm run contracts:validate
pnpm run docs:validate
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

`docs:validate` resolves every relative Markdown link, so a new document must not link to a
file that does not exist.

## Testing note

`packages/postgres-adapter` has **no unit tests** — the three stores are exercised only by
the manual end-to-end run described in
[Phase 3 Vertical Slice](docs/architecture/phase-3-vertical-slice.md#verification). Treat
changes there as higher risk and verify with a real database:

```bash
pnpm run db:migrate && pnpm run db:seed
# start control-api, provisioning-orchestrator, proxmox-provider with PROVIDER_ADAPTER=fake
# POST a create → 202; poll the operation → succeeded/active
# replay the same Idempotency-Key → replayed=true, no second resource
```
