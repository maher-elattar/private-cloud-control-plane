# Comment Standard

This repository documents *why*, not *what*. TypeScript already states what a value is; a
comment that repeats the signature costs a line and earns nothing. What the compiler cannot
state is why a lock is held, why a failure is not retried, or which distributed-systems
pattern a block of SQL implements — and in a control plane whose whole job is to avoid
building a second VM, that reasoning is the part a reader actually needs.

## Rules

### 1. Every non-trivial file opens with a header block

State the layer, the pattern it implements, and link the governing document. A reader who
opens the file cold should know where they are within three lines.

```ts
/**
 * PostgreSQL adapter for the `WorkflowStore` port.
 *
 * PATTERN — Inbox + Lease/Fencing + Transactional Outbox. Converts accepted commands into
 * workflow rows exactly once, hands one instance to one worker at a time, and records each
 * transition as an event in the same transaction that advances the stage.
 *
 * @see docs/architecture/glossary.md#lease-and-fencing-token
 * @see docs/architecture/phase-3-persistence.md
 */
```

Trivial files — barrel `index.ts`, DI token modules, `vite.config.ts` — are exempt.

### 2. Exported symbols in `packages/*` carry JSDoc

Every exported class, interface, type alias, function, and public method states its
contract: what it guarantees, what it assumes, what it throws. Not a restatement of its name.

```ts
// Bad — restates the signature.
/** Claims the next create workflow. */

// Good — states the contract the caller has to honour.
/**
 * Claims one instance for exclusive processing and returns its persisted position, or
 * `null` when no workflow is ready.
 *
 * The caller holds the lease only until `leaseSeconds` elapses, and every subsequent write
 * must present the returned `fencingToken`. Callers must execute exactly one transition and
 * claim again rather than looping — see {@link CreateInstanceWorkflow.runOne}.
 *
 * @throws Error if `workerId` is empty or `leaseSeconds` falls outside 5–300.
 */
```

This rule is enforced by `eslint-plugin-jsdoc` in `eslint.config.mjs`, scoped to
`packages/*/src/**/*.ts`. Generated code and `*.spec.ts` are excluded.

`apps/*` is deliberately **not** covered by the lint rule. NestJS controllers describe
themselves through their decorators — `@Post()`, `@Param('projectId')` — and JSDoc on top of
that is noise. Files in `apps/*` still take a header block (rule 1) and `WHY:` notes
(rule 3).

### 3. Non-obvious safety decisions get a `WHY:` comment

If a reader could plausibly delete a line and see the tests still pass, that line needs a
`WHY:`. This applies to locks, fencing checks, `FOR UPDATE … SKIP LOCKED`, ordering
subqueries, deliberate hardcodes, and any place where the *cautious* branch was chosen over
the obvious one.

```ts
// WHY: two concurrent requests carrying the same Idempotency-Key would both miss the SELECT
// below and both insert. Serialising on the key makes the loser deterministically replay the
// winner's stored response instead of provisioning a second VM.
await sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyScope}, 0))`.execute(tx);
```

Grep `WHY:` to find every deliberate safety decision in the codebase.

### 4. Long methods carry section banners

A method with distinct phases names them. If the phases do not have names, that is usually a
sign the method should be split instead.

```ts
// --- Authoritative write model -------------------------------------------------
// --- Idempotency record and outbox ---------------------------------------------
// --- Read projections ----------------------------------------------------------
```

### 5. No magic numbers

Every literal that encodes a policy becomes a named module-level constant with a one-line
doc comment. `500` says nothing; `TASK_POLL_DELAY_MS` says what it controls, and its comment
says why that value.

```ts
/** Delay before re-polling a provider task that is still queued or running. */
const TASK_POLL_DELAY_MS = 500;
```

Exempt: `0`, `1`, array indices, and HTTP status codes used in an obvious mapping.

### 6. Comments state reasoning, never mechanics

```ts
// Bad — the code already says this.
// Loop over the rows and map each one.

// Good — explains a decision the code cannot express.
// Catalog tables are small and static, so these read from `control.*` directly rather than
// through a projection. Instances and operations do need projections; see the glossary.
```

Do not leave commented-out code, changelog entries, or attributions. Git records those.

### 7. Formatting

Prettier governs: `printWidth: 100`, so comment text wraps at 100 columns. Run
`pnpm run format` before committing. Use `@see` with repo-relative paths for documents and
`{@link Symbol}` for code references, so editors resolve them.

## Vocabulary

Use the terms defined in [Pattern Glossary](glossary.md) — transactional outbox, inbox /
command receipt, lease, fencing token, persisted saga, read projection, advisory lock, port,
adapter. Naming a pattern lets a reader look it up. Describing it in ad-hoc words each time
does not.

When a comment leans on a pattern, link the glossary anchor rather than re-explaining:

```ts
/** @see docs/architecture/glossary.md#transactional-outbox */
```

## Checklist for a new file

- [ ] Header block: layer, pattern, `@see` the governing doc
- [ ] JSDoc on every exported symbol (required by lint under `packages/`)
- [ ] `WHY:` on every deliberate safety decision
- [ ] Section banners in any method long enough to have phases
- [ ] Named constants instead of literals
- [ ] `pnpm run format && pnpm run lint` clean
