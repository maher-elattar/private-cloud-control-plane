# Phase 6 Postman Collection

An importable collection that exercises the whole control plane on the minikube cluster, and a
headless runner that executes the same file in continuous verification.

| Artifact | Path |
| --- | --- |
| Collection | `tools/postman/private-cloud-control-plane.postman_collection.json` |
| Environment | `tools/postman/minikube.postman_environment.json` |
| Source of truth | `tools/postman/requests.mjs` |
| Generator | `tools/postman/generate-collection.mjs` |
| Headless runner | `tools/postman/run-collection.mjs` |

**Both JSON files are generated. Do not hand-edit them** — edit `requests.mjs` and run
`node tools/postman/generate-collection.mjs`. `pnpm run postman:check` fails if they are stale, and
also fails if the collection stops covering every operation the OpenAPI document declares. That
coverage check is what keeps a hand-run collection honest as the API grows: adding a REST operation
without a collection entry breaks the build.

## Setting up

### 1. Start the port-forward

The identity fixture is `ClusterIP` only and has no `HTTPRoute` — an identity provider anyone can
reach from outside the cluster is not one. Postman reaches it through a forward:

```bash
kubectl port-forward -n private-cloud svc/local-oidc 18085:18080
```

Leave it running. **18085, not 18080**: the Phase 4 Compose stack binds 18080 on the host, and a
forward that loses that race fails in a way that looks like an API problem rather than a tunnel
problem — `kubectl` reports `address already in use`, while Postman cheerfully gets a token from
the Compose fixture whose `iss` claim the cluster rejects with a bare `401`.

### 2. Confirm the Gateway address

```bash
minikube ip                          # 192.168.49.2
kubectl get svc -n traefik traefik   # 80:30000/TCP
```

If they differ from the defaults, update `gatewayUrl` in the environment.

### 3. Import

In Postman: **Import** → both files → select **Phase 6 — minikube** as the active environment.

### 4. Run

Use the collection runner (**Run collection**), top to bottom. Order matters: this is a lifecycle
API, and a snapshot cannot be taken of an instance that does not exist yet.

Run the **`00 Identity`** folder first if you are sending requests by hand — it mints the tokens
every other request carries.

## What it covers

63 requests in 10 folders, covering all 39 declared REST operations.

| Folder | Requests | What it establishes |
| --- | --- | --- |
| `00 Identity` | 3 | Tenant, administrator, and foreign-project tokens |
| `01 Health and routing` | 3 | Liveness, readiness, and the `X-Canary: green` header reaching the preview Service |
| `02 Project, quota, and catalog` | 5 | The reads a caller needs before composing a create |
| `03 Create an instance` | 7 | Accept, replay, idempotency conflict, poll to completion, read back |
| `04 Power and resize` | 7 | All four power actions, a resize, and a refused disk shrink |
| `05 Snapshots` | 7 | Create, list, roll back, delete, each polled to completion |
| `06 Retention and purge` | 5 | Soft delete, retention deadline, and both purge guards refusing |
| `07 Administration` | 5 | Admin operation read, audit events, dead letters, reconciliation, replay |
| `08 Authorization and validation` | 6 | 401, 403 twice, 404, and two validation refusals |
| `09 Declared but not yet served` | 15 | The operations that answer 404 today, asserted as such |

### Refusals are assertions, not tolerances

Several requests assert a **failure**: a `403` for a foreign project, a `409` for a purge inside
the retention window, a `422` for a disk shrink. These are the safety rules the control plane
exists to enforce. A run in which they stopped failing would be a regression that a happy-path
collection would never notice, so they are asserted as precisely as the successes.

## Variables

Environment values — edit these for a different cluster:

| Variable | Default | Notes |
| --- | --- | --- |
| `gatewayUrl` | `http://192.168.49.2:30000` | minikube IP and the Traefik node port |
| `gatewayHost` | `control-plane.test` | Sent as the `Host` header, so no `/etc/hosts` entry is needed |
| `oidcUrl` | `http://127.0.0.1:18085` | The local end of the port-forward |
| `projectId` | `00000000-0000-4000-8000-000000000001` | Seeded by `db/seeds/0001_phase3_fake.sql` |
| `foreignProjectId` | `…0000000000ff` | A project the tokens are not members of, to prove the 403 |
| `absentInstanceId` | `…00000000dead` | An instance that does not exist, to prove the 404 |
| `imageId`, `flavorId`, `networkId` | seeded values | The catalog entries a create references |
| `flavorIdLarger` | `lab-medium` | The resize target; larger in every dimension |
| `sshPublicKey` | a syntactically valid mock key | Non-functional on purpose. Real key material is never committed |

Collection variables (`tenantToken`, `instanceId`, `operationId`, `snapshotId`, …) are populated at
run time by test scripts and start empty.

### Idempotency keys are generated per run

Each mutating request generates a fresh `Idempotency-Key` in a pre-request script. A key stored in
the environment would replay the previous run's stored response, and the request would silently
stop testing anything.

The two replay requests deliberately reuse the first create's key — that is what makes them a
replay test.

## Polling

Operations are asynchronous, so the collection polls. Each poll request re-sends itself with
`postman.setNextRequest(pm.info.requestName)` until the operation's `state` settles, up to 60
attempts. A non-2xx response ends the poll immediately rather than retrying against an error, so a
mistyped identifier reports itself in seconds instead of two minutes.

Sending a poll request once by hand simply shows the current state; the loop only runs inside a
collection run.

## Running it headlessly

```bash
pnpm run postman:run                       # everything; manages its own port-forward
pnpm run postman:run -- --folder=03        # folders whose name starts with "03"
pnpm run postman:run -- --no-forward       # a port-forward is already running elsewhere
pnpm run postman:check                     # verify the generated files are current and complete
```

The runner executes **the generated collection file itself**, not a parallel reimplementation, so a
green run proves the artifact a person would import actually works. It supports exactly the Postman
surface the generator emits — `pm.response`, `pm.test`, `pm.expect` with `eql` / `oneOf` /
`property` / `lengthOf` / `include` and `.not`, `pm.collectionVariables`, `pm.variables.replaceIn`,
`pm.info.requestName`, `pm.execution.skipRequest`, and `postman.setNextRequest`. A script reaching
for anything else fails loudly rather than being quietly skipped.

There is no `newman` dependency: running one JSON file did not justify a dependency tree, and the
runner also handles the port-forward, which `newman` would not.

Output:

```console
▶ 03 Create an instance
  ✓ Create instance
  ✓ Create instance again with the same key (replay)
  ✓ Create instance with the same key but a different payload
  ✓ Poll the create operation until it settles (3 attempts, 4.0s)
  ✓ Get instance
  ✓ List instances
  ✓ List operations

──────────────────────────────────────────────────────────────────────────────
62/62 requests passed, 100 assertions, 1 skipped.
Evidence: docs/verification/evidence/phase6-api-examples.json
```

The skipped request is the dead-letter replay, which has nothing to act on when the run found no
dead letters — the normal case. It skips rather than passing silently.

Every request and response is written to
`docs/verification/evidence/phase6-api-examples.json`, with `Authorization` headers redacted.
[Phase 6 API Examples](phase-6-api-examples.md) is transcribed from that file.

## Adding a request

1. Add an entry to the right folder in `tools/postman/requests.mjs`.
2. Name its `operationId` if it exercises a declared REST operation.
3. `node tools/postman/generate-collection.mjs`
4. `pnpm run postman:run -- --folder=<n>` to check it against the cluster.
5. Commit `requests.mjs` and both generated files together.

## What it found

The collection was not written to document a working system — it was written to test one, and its
first complete run passed 42 of 62 requests. Eight defects surfaced, every one of them invisible to
the existing unit, integration, and deployment checks because each needed the *whole* path from
HTTP through Kafka to the provider and back:

| # | Defect | Symptom |
| --- | --- | --- |
| 1 | The in-memory fake provider ran at two replicas | Roughly half of creates ended in `manual_review` with `PROVIDER_TASK_UNKNOWN` |
| 2 | Every stored command was decoded against the create contract | Non-create workflows were never claimed; operations sat at `accepted` forever |
| 3 | Non-create workflows were admitted with no provider resource id | Failed at the first mutation stage with `PROVIDER_PROTOCOL_ERROR`, never reaching the provider |
| 4 | `retentionDeadline` sent as a string where the wire needs a `Timestamp` | Retention and purge failed client-side; the provider logged nothing |
| 5 | `ListSnapshots` response timestamps were not encoded | Provider logged success, caller got `INTERNAL` and failed the workflow |
| 6 | The projection never settled snapshot state | Snapshots stayed `creating`, so rollback and delete were refused forever |
| 7 | Terminal audit entries were hardcoded to `create_instance` | The audit log claimed a VM was built once per power change, resize, and snapshot |
| 8 | `retentionDeadline` was never written to the read projection | A retained instance never showed when it stops being recoverable |

Details and the fixes are in `phase-6-completion-checkpoints.md`. Assertions guarding 6, 7, and 8
are now in the collection.
