# Phase 6 Completion Checkpoints

This file is the resumable execution record for Phase 6 — Kubernetes and GitOps deployment.
Update it when a checkpoint starts, when its verification completes, and after its commit. Do not
mark a checkpoint complete without recording concrete evidence.

The authoritative scope is `private-cloud-control-plan.md` at the repository root, Phase 6, plus
the operator's explicit instruction for this phase:

> everything should be declarative and save manifest files in folder, apply them on the kube
> cluster here called minikube and install argocd and argo rollouts on it with manifest files if
> they are not, test everything, make the deployment blue green deployment with header based
> routing too in manifest files and use the rollout crd not deployment, add automated analysis for
> argo rollouts with prometheus and health checks and metrics rate of 200 responses of more than
> 90% for the green env and analysis templates with self healing

Both are binding. Where they disagree, the operator instruction governs and the divergence is
recorded as a decision below rather than resolved silently.

## Current State

- Overall status: Complete, pending commit
- Current checkpoint: none — every checkpoint P6-0 through P6-14 is complete
- Last completed checkpoint: P6-12 — Documentation, diagrams, and Phase 6 closure
- Phase 5 dependency: cleared. Phase 5 closed with all thirteen checkpoints complete.
- Nothing is committed yet. The whole of `deploy/kubernetes`, `tools/kubernetes`, and the Phase 6
  documentation is untracked or modified in the working tree.

## Cluster Survey — 2026-09-05

Recorded before a single manifest was written, because five of the roadmap's assumptions are false
on this cluster and the substitutions have to be deliberate.

```
kubectl version --client   Client v1.36.4, Kustomize v5.8.1
kubectl config current-context   minikube
kubectl get nodes          minikube  Ready  control-plane  29d  v1.35.1
minikube profile list      driver docker, runtime docker, IP 192.168.49.2, 1 node
node allocatable           cpu 16, memory 36297544Ki, ephemeral-storage 15652608Ki, pods 110
minikube ssh df -h /var    15G total, 9.0G used, 6.0G available
```

**Already installed, and therefore not to be re-installed.**

| Component             | Version                                  | Namespace       | Age | Managed by          |
| --------------------- | ---------------------------------------- | --------------- | --- | ------------------- |
| Argo CD               | `quay.io/argoproj/argocd:v3.5.1`         | `argocd`        | 14d | Helm                |
| Argo Rollouts         | `quay.io/argoproj/argo-rollouts:v1.9.1`  | `argo-rollouts` | 14d | Helm (chart 2.41.1) |
| kube-prometheus-stack | Prometheus `v3.14.0`, operator `v0.93.1` | `monitoring`    | 12d | Helm                |
| Traefik               | chart 41.3.0, Gateway API controller     | `traefik`       | 13d | Helm                |
| Gateway API           | CRD bundle `v1.6.1`, standard channel    | cluster         | 13d | —                   |

Argo CD holds **no `Application` objects at all** — the GitOps control loop exists but manages
nothing. That is the hole Phase 6 fills.

**Facts that shape the design.**

- `traefik/traefik-gateway` listens on `:80` with `allowedRoutes.namespaces.from: All`, so an
  `HTTPRoute` in our own namespace attaches to the existing Gateway without touching it. The
  roadmap's "use existing Gateway" is satisfiable exactly as written.
- The Prometheus CR selects `ServiceMonitor`, `PodMonitor`, and `PrometheusRule` objects in **any**
  namespace carrying the label `release: my-kube-prometheus-stack`. Every monitoring object we
  write therefore carries that label; nothing about the existing stack is modified.
- The cluster's default scrape interval is 30s. Rollout analysis needs faster feedback than that,
  so our `ServiceMonitor` sets its own `interval`.
- Argo Rollouts already has the `argoproj-labs/gatewayAPI` traffic-router plugin configured. We do
  not need it: blue-green preview traffic is steered by an `HTTPRoute` header match onto the
  preview `Service`, which Argo Rollouts keeps pointed at the green ReplicaSet by pod-template-hash.
- There is **no `IngressClass`** on this cluster. Traefik is Gateway-API and CRD driven only, so
  nginx-ingress canary annotations are not available and are not used.

**Decisions where the roadmap does not match the cluster.** Each is a substitution, not a
deferral, and each is written up in `docs/architecture/phase-6-gitops-deployment.md`.

1. _Longhorn._ The roadmap says "consume the existing Longhorn storage class". This cluster is a
   single-node minikube whose only class is `standard` (`k8s.io/minikube-hostpath`), with no
   volume expansion and `Delete` reclaim. Longhorn's whole purpose — replicating a volume across
   failure domains — is meaningless on one node. We consume `standard` through a storage-class
   name held in one overlay value so a real cluster substitutes Longhorn without a manifest edit,
   and the roadmap's required Longhorn/Kafka replication tradeoff write-up is delivered as
   documentation.
2. _Argo CD and Argo Rollouts installation._ Both are present and Helm-managed. Applying vendored
   upstream manifests over a live Helm release rewrites ownership metadata and can leave the
   release unrepairable. The pinned upstream manifests are still vendored — that is the
   declarative record, and a fresh cluster is bootstrapped from them — but the bootstrap tool
   verifies the installed version first and refuses to overwrite a healthy install it did not
   create.
3. _Certificates._ The roadmap says "use existing certificates". There is no cert-manager and the
   existing Gateway has an HTTP listener only. The manifests are written so a TLS listener and a
   `Certificate` drop in without restructuring, and the local path stays HTTP.
4. _Disk budget._ 6.0 GiB free on the node backs every PersistentVolume and every image layer.
   Postgres and Kafka storage requests are sized against that number, and it is the reason the
   Kafka cluster is a single KRaft-combined node rather than three brokers.

## Completion Plan

### Checkpoint P6-0 — Cluster survey and execution ledger — **complete**

The survey above, this ledger, and the manifest layout in `deploy/kubernetes`, mapped in
`deploy/kubernetes/README.md`.

### Checkpoint P6-1 — Declarative bootstrap: Argo CD and Argo Rollouts — **complete**

- `deploy/kubernetes/bootstrap/` vendors the upstream install manifests for Argo CD `v3.5.1` and
  Argo Rollouts `v1.9.1`, with SHA-256 digests recorded in `bootstrap/provenance.json`. Both files
  are listed in `.prettierignore` so reformatting cannot silently break the digest.
- `tools/kubernetes/bootstrap.mjs` verifies those digests, skips a healthy install at the pinned
  version, and refuses a version mismatch without `--force`. Evidence: the cluster's Argo Rollouts
  is Helm-managed (`helm.sh/chart: argo-rollouts-2.41.1`) and was **not** overwritten.
- `deploy/kubernetes/argocd/project.yaml` is the `AppProject`. It is applied by `bootstrap.mjs`
  before the root `Application`, because an `Application` naming a project that does not exist is
  rejected outright — the chicken-and-egg this ordering resolves.

### Checkpoint P6-2 — Scrape endpoint for rollout analysis — **complete**

- `packages/observability/src/runtime.ts` gained `prometheusScrapeReader()`, enabled by
  `PROMETHEUS_METRICS_PORT`, running alongside the existing OTLP reader rather than replacing it.
- The HTTP server duration histogram is bounded by an SDK view to four attributes with a
  cardinality limit of 512 (SAFE-034), and `resourceDetectors: []` keeps host and process identity
  out of the exporter's `target_info` series.
- Four tests in `runtime.spec.ts` cover it, including one that asserts `server_address`,
  `network_peer_address`, `host_name`, `process_owner`, and `process_command` are absent by name.
- Verified live: `http_server_request_duration_count` exists per pod with
  `http_response_status_code="200"` for all four active and all four preview Services.

### Checkpoint P6-3 — Namespace, identity, and boundaries (sync wave 0) — **complete**

`deploy/kubernetes/namespace/`: the namespace with the `restricted` Pod Security Standard enforced,
six service accounts all with `automountServiceAccountToken: false`, one narrow Role for the
analysis reader, six network policies (deny-by-default in both directions plus one allowance per
real dependency), and four PodDisruptionBudgets. Resource requests, limits, and topology spread
constraints are declared on every workload and enforced by `render-check.mjs`.

The boundary diagram is `docs/diagrams/rendered/phase-6-network-boundaries.mermaid.svg`, and
`network-policies.yaml` states the invariant: every rule corresponds to an edge in that diagram.

### Checkpoint P6-4 — Operators and CRDs (sync wave 1) — **complete**

`deploy/kubernetes/platform/`: CloudNativePG chart `0.29.0`, Strimzi `1.2.0`, and KEDA `2.20.2`,
each as an Argo CD `Application`. All three report Synced and Healthy.

Two findings recorded here because they cost real time:

- Strimzi `1.2.0` serves only `kafka.strimzi.io/v1`; `v1beta2` is removed, and so are the
  `strimzi.io/node-pools` and `strimzi.io/kraft` annotations.
- KEDA requires one RoleBinding in `kube-system`, so `kube-system` is an explicit destination in
  the `AppProject` with the reason attached and a widened `namespaceResourceBlacklist` beside it.

### Checkpoint P6-5 — Database and Kafka (sync wave 2) — **complete**

`deploy/kubernetes/data/`: a CloudNativePG `Cluster` with `wal_level: logical` for CDC, a Strimzi
KRaft `Kafka` with a TLS listener using SCRAM-SHA-512 and `simple` authorization, two `KafkaUser`
objects, five `KafkaTopic` objects, `KafkaConnect` running the Debezium outbox connector, and the
schema migration as a `Sync` hook.

Verified live: all seven migrations applied and the seed run by the hook; the Debezium connector
`RUNNING` with a publication covering `control.outbox` and `workflow.outbox`.

No credential value is in the repository (SAFE-036). Both `render-check.mjs` and
`verify-phase6.mjs` assert it — the latter by checking that every Secret in the namespace carries an
operator owner reference and no Argo CD tracking annotation, with one named exception holding
protocol switches rather than a secret.

Three admission and schema findings, each fixed structurally rather than worked around:

- `STRIMZI_POD_SECURITY_PROVIDER_CLASS=restricted` is required for Strimzi's pods to be admitted
  under the `restricted` profile; without it the `StrimziPodSet` sits at zero pods.
- Strimzi refuses additional Connect volumes outside `/mnt`, so the Postgres credential is mounted
  at `/mnt/postgres-app`.
- The `KafkaConnector` is at sync wave **4**, behind the wave 3 migration hook. Debezium's
  `publication.autocreate.mode: filtered` fails _permanently_ against tables that do not exist yet,
  so ordering is the fix and a restart annotation is only the recovery.

### Checkpoint P6-6 — Observability (sync wave 3) — **complete**

`deploy/kubernetes/observability/`: an OpenTelemetry Collector pinned to
`otel/opentelemetry-collector-contrib:0.158.0` — the same version as the Compose stack, because
`span_metrics` is named `spanmetrics` in 0.146 and the mismatch is a crash loop — and three
`ServiceMonitor` objects labelled `release: my-kube-prometheus-stack`, with a 10s interval on the
preview and active Services because the cluster default of 30s is too slow for the gate.

Verified live: 18 healthy scrape targets in the `private-cloud` namespace.

### Checkpoint P6-7 — Applications as blue-green Rollouts (sync wave 4) — **complete**

`deploy/kubernetes/applications/`: four `Rollout` objects — no `Deployment` — with blue-green
strategies, active and preview Services, three probes each, and the header-matched `HTTPRoute` that
sends `X-Canary: green` to the preview environment.

`render-check.mjs` enforces the rule as a policy rather than a convention: a `Deployment` named
`control-api`, `provisioning-orchestrator`, `proxmox-provider`, or `reconciler` is a violation.

Findings:

- The kubelet cannot verify a symbolic `USER node` against `runAsNonRoot`, so every pod sets a
  numeric `runAsUser`.
- `control-plane-config` is a kustomize `configMapGenerator`, so a configuration change produces a
  new Rollout revision and is promoted through the same analysis an image change is. Kustomize does
  not rewrite ConfigMap references inside a `Rollout` — an unknown kind — so
  `applications/kustomize-config/name-reference.yaml` teaches it to.

### Checkpoint P6-8 — Automated analysis and self-healing — **complete**

Three `AnalysisTemplate` objects wired as pre- and post-promotion analysis with
`autoPromotionEnabled: true` and `progressDeadlineAbort: true`, plus Argo CD `selfHeal` and `prune`.

The success rate gate is `result[0] >= 0.90` over
`http_server_request_duration_count{...http_response_status_code="200"}` divided by all responses,
with `or vector(0)` on the numerator and `clamp_min(…, 0.001)` on the denominator so that "no
traffic" fails honestly instead of erroring or reading as perfect. `green-traffic-floor` and
`green-scrape-health` exist so that silence and blindness cannot pass.

### Checkpoint P6-9 — Dashboards and alerts (sync wave 5) — **complete**

`deploy/kubernetes/dashboards/`: five `PrometheusRule` alerts (`RolloutDegraded`,
`RolloutStuckPaused`, `GreenSuccessRateBelowGate`, `ArgoApplicationOutOfSync`, `OutboxNotDraining`)
and a Grafana dashboard with uid `private-cloud-bluegreen`, provisioned by the
`grafana_dashboard: '1'` label into the existing Grafana.

### Checkpoint P6-10 — Render, schema, and policy checks — **complete**

`tools/kubernetes/render-check.mjs`, run as `pnpm run k8s:render-check`. Three stages:

1. `kubectl kustomize` over all nine roots.
2. A server-side dry run against the live API server, which is what validates the operators' custom
   resource schemas. The vendored `bootstrap/` root is excluded: this cluster runs both controllers
   from a Helm release with different selectors, so a dry run there reports an immutable-selector
   conflict with a foreign installation rather than a verdict on the manifests.
3. Eight deployment policies, each carrying the reason it exists: a `Rollout` for anything that
   takes traffic, resource requests and limits, liveness and readiness probes, an unprivileged pod
   with a numeric user, no mounted service-account token, pinned images, a sync wave on every
   object, and no committed credential.

An object may opt out of a named policy with `private-cloud.io/policy-exempt`, but an exemption
without `private-cloud.io/policy-exempt-reason` is itself a violation — the only way an exemption
stays reviewable after it is merged.

Result: **161 objects render, validate, and satisfy every policy.**

### Checkpoint P6-11 — Verification from a fresh Argo sync — **complete**

**Result: 12 of 12 runtime checks passed** in one run, `2026-09-05T22:51:39Z` to
`2026-09-05T23:19:28Z`, against Argo CD revision `d6a042cc6242`. Evidence:
`docs/verification/evidence/phase6-runtime.json`; the narrative record with the measurements is
`docs/verification/phase-6-cluster-verification.md`.

`tools/kubernetes/verify-phase6.mjs`, run as `pnpm run verify:phase6-runtime`. Evidence is written
to `docs/verification/evidence/phase6-runtime.json`.

Every drill changes the cluster the way a person would — by publishing to the GitOps repository and
letting the control loop act. A drill that reached past Argo CD with `kubectl patch` would be
fighting the self-healing it is supposed to be proving. The one exception is the drift drill, where
reaching past Argo CD _is_ the thing under test.

Two defects were found by running this and fixed in the manifests and tooling, not worked around:

1. **Argo Rollouts owns `rollouts-pod-template-hash` in every active and preview Service selector,
   and nothing told Argo CD that.** The application was permanently `OutOfSync`, which is worse than
   noisy: the controller stops treating a new revision as a new sync and starts treating it as
   another self-heal attempt, behind a backoff that reaches five minutes — so real changes silently
   stopped arriving. Fixed by an `ignoreDifferences` entry in `argocd/applications.yaml`, which
   `RespectIgnoreDifferences` turns into an exclusion from the apply as well as the diff. Stripping
   that field would point a Service at both environments at once, or neither, mid-promotion.
2. **The repository server rolled with `RollingUpdate`, so two pods served two unrelated
   histories behind one Service during a publish.** Argo CD resolving a revision from one pod and
   fetching it from the other reports a stale render as a successful sync. Fixed with
   `strategy: { type: Recreate }`, plus a `.publish-digest` marker the publisher reads back through
   the Git protocol before telling Argo CD anything — so "the repository answers" became "the
   repository is serving _this_ publish". The publisher now requests a sync rather than only a
   refresh, because a refresh alone leaves the controller free to decide it has already attempted
   the revision.

Three further defects were in the verification tool itself:

3. `listAnalysisRuns` selected by a `rollout.argoproj.io/name` label that Argo Rollouts does not set.
   It now selects by owner reference, because "the gate did not run" is exactly the wrong conclusion
   to draw from a query that cannot see it.
4. The drills exercised the gate by flipping the image tag between `phase6` and `phase6-green`. Every
   second flip was therefore a **rollback within `scaleDownDelay`**, which Argo Rollouts completes
   immediately and without analysis — correct behaviour, and useless as a drill. The drills now stamp
   a unique `private-cloud.io/drill-revision` annotation onto the pod template, so every drill is a
   forward promotion whatever image it deploys, and the target tag is fixed rather than alternating.
   `withPublishedMutation` waits for the restored rollout to settle **on the image the repository
   declares**, so one drill's tail is never the next drill's first observation — settling on "some
   quiet state" was not enough, because the drill's own promoted state is quiet too.
5. `readRollout` reported `status.replicas`, which counts blue and green pods together during a
   promotion, so the drift drill asserted that Argo CD would restore a replica count the repository
   never declares. It now reports `spec.replicas` beside it, and the drill uses the declared one.

The abort path was proven along the way, before the drill mechanism was fixed: with the degraded load
generator running, the restore's promotion was refused by `control-api-66cddf49d-11-pre` on
`green-http-200-rate` at 0.652 and 0.646 against the 0.90 gate, with
`green-ready-replicas` and `green-request-rate` both passing — so the refusal was about the responses,
not about availability. The rollout aborted at `2026-09-05T21:44:01Z` with
`Metric "green-http-200-rate" assessed Failed due to failed (2) > failureLimit (1)`, and the active
Service stayed on the stable ReplicaSet throughout.

#### One deviation from "do not modify the existing cluster foundation manually"

While diagnosing defect 2, the `argocd-repo-server` pod was deleted once, to rule out a stale
manifest cache. Nothing about Argo CD's configuration was changed and the Deployment recreated the
pod identically; it is recorded here because the instruction is worth honouring literally rather
than approximately. The diagnosis it produced was negative — the cache was not the cause — and the
actual fix was made in this repository's own manifests and tooling.

### Checkpoint P6-12 — Documentation, diagrams, and Phase 6 closure — **complete**

Delivered:

- `docs/architecture/phase-6-gitops-deployment.md` — the architecture, both meanings of
  self-healing, the four recorded substitutions, and the Longhorn/Kafka replication tradeoff the
  roadmap requires.
- `docs/runbooks/phase-6-deployment.md` — stuck rollouts, aborted promotions, applications that will
  not converge, publishes that do not land, and two things the runbook deliberately refuses to do.
- `docs/observability/phase-6-deployment-metrics.md` — the per-pod scrape path, why it exists beside
  the Phase 4 pipeline, the analysis queries, and the deployment alerts.
- `deploy/kubernetes/README.md` — the directory map and the two conventions that look like noise.
- Four Mermaid diagrams, rendered and listed in `docs/diagrams/README.md`:
  `phase-6-sync-waves`, `phase-6-bluegreen-promotion`, `phase-6-analysis-gate`,
  `phase-6-network-boundaries`.
- `README.md` — a Phase 6 section, three documentation-map entries, and a rewritten Current State.
- `docs/verification/phase-6-cluster-verification.md` — the exact gates, the measured promotion and
  the measured refusal, and the defects the run found.
- `package.json` — `k8s:bootstrap`, `k8s:publish`, `k8s:render-check`, `k8s:resync`, and
  `verify:phase6-runtime`.

**Quality gate, all green:**

| Gate                             | Result                                                 |
| -------------------------------- | ------------------------------------------------------ |
| `pnpm run contracts:validate`    | 39 REST operations, 54 gRPC methods, 20 event messages |
| `pnpm run docs:validate`         | 55 Markdown files and 35 Mermaid artifacts             |
| `pnpm run format:check`          | All matched files use Prettier code style              |
| `pnpm run lint`                  | 14 projects                                            |
| `pnpm run typecheck`             | 14 projects                                            |
| `pnpm run test`                  | 11 projects plus 3 tool tests                          |
| `pnpm run test:integration`      | 5 files, 83 tests                                      |
| `pnpm run build`                 | 14 projects                                            |
| `pnpm run k8s:render-check`      | 161 objects render, validate, and satisfy 8 policies   |
| `pnpm run verify:phase6-runtime` | 12 of 12 runtime checks                                |

`format:check` needed `.prettierignore` entries for `pnpm-lock.yaml` and the `.agents/`, `.claude/`,
and `.cursor/` tooling directories: a generated lockfile and other people's local editor
configuration are not this project's source, and leaving them in made the gate fail for reasons
nothing in the repository could fix.

Remaining: the commit. Nothing in this phase is committed — the working tree carries Phase 5's work
as well, which is also uncommitted. Committing was not requested and has not been done.

## Checkpoint P6-13 — Operations documentation and API verification — Complete

Added on request: full Phase 6 documentation, an operations manual, an importable Postman
collection with a way to obtain a bearer token, request and response examples, image build and
deployment commands, a manifest reference, and Mermaid diagrams.

### Delivered

| Artifact                                        | Contents                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/operations/phase-6-operations-manual.md`  | Prerequisites, fresh bring-up, restart after a stop, image builds, deploying code and manifest changes, reaching the API, obtaining a JWT, verification, inspection, and three kinds of teardown |
| `docs/operations/phase-6-api-examples.md`       | Every request with the response the cluster actually returned, the asynchronous contract, all nine refusals, and the 24-of-39 endpoint coverage table                                            |
| `docs/operations/phase-6-postman-collection.md` | Import and run instructions, variables, polling, the headless runner, and how to add a request                                                                                                   |
| `docs/operations/phase-6-manifest-reference.md` | All 161 objects by directory, sync-wave ordering, network policies, rollout strategy, analysis templates, and the eight render policies                                                          |
| `tools/kubernetes/build-images.mjs`             | Builds the seven images into minikube's own Docker daemon; `--only`, `--tag`, `--list`, `--host`                                                                                                 |
| `tools/postman/requests.mjs`                    | The collection's request list as data — the single source of truth                                                                                                                               |
| `tools/postman/generate-collection.mjs`         | Generates both Postman JSON files and fails if coverage of the OpenAPI operation set is incomplete                                                                                               |
| `tools/postman/run-collection.mjs`              | Executes the generated collection headlessly, managing its own port-forward                                                                                                                      |
| 5 new Mermaid diagrams                          | Operations lifecycle, image supply chain, token acquisition, API request path, manifest map                                                                                                      |

New scripts: `k8s:build-images`, `postman:check`, `postman:run`.

### The image build gap this closed

Phase 6 had no image build tooling at all. The seven images existed in the node's Docker daemon
from commands typed by hand, and nothing in the repository recorded how to reproduce them. The
Dockerfiles were committed; the invocation was not. `k8s:build-images` makes the whole set
reproducible and records which manifest consumes each image.

### Defects the Postman collection found

The collection's first complete run passed 42 of 62 requests. Every failure was a real defect, and
every one was invisible to the existing unit, integration, and deployment checks, because each
needed the whole path from HTTP through Kafka to the provider and back. The final run passes 62 of
62 with 100 assertions.

| #   | Defect                                                                                        | Root cause                                                                                                                                                                                                                                     | Fix                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Roughly half of all creates ended in `manual_review` with `PROVIDER_TASK_UNKNOWN`             | `proxmox-provider` ran `replicas: 2` while the configured adapter is the fake, which holds its task ledger in in-process maps. A task started on one replica was polled on the other, which correctly reported no authoritative result         | `replicas: 1` with the reasoning recorded in the manifest, the analysis floor moved to `1`, and the PDB relaxed to `minAvailable: 0`                    |
| 2   | Every non-create operation stayed `accepted` forever                                          | `claimNext`, `deadLetterWorkflow`, and the replay path decoded every stored command against the create contract, so a power, resize, snapshot, retention, or purge workflow threw on claim and retried forever. Nothing surfaced to the caller | A `Record<WorkflowAction, validator>` keyed by the action the row was admitted under; total, so a new capability without a validator is a compile error |
| 3   | Every non-create workflow failed at 20% with `PROVIDER_PROTOCOL_ERROR`                        | Workflows were admitted with `provider_resource_id: null`, correct for a create and wrong for everything else. The first mutation stage raised `protocol_error` before reaching the provider                                                   | Admission seeds the identifier from the create workflow for the same instance, the rule the reconciliation sweep already used                           |
| 4   | Retention and purge failed before the RPC left the process                                    | `retentionDeadline` was sent as an ISO string where the proto declares `google.protobuf.Timestamp`. Only the decoding half of the conversion had ever been written                                                                             | `wireTimestamp` on the client and `isoTimestamp` on the provider, so the port speaks ISO on both sides and the wire speaks `Timestamp`                  |
| 5   | Snapshot creation failed at its observation stage while the provider logged success           | `ListSnapshots` returned unencoded timestamps. The handler returns and logs before grpc-js serializes, so the failure appeared to come from nowhere                                                                                            | Encoded `ProviderSnapshot.createdAt` and `ListSnapshotsResponse.observedAt`; all six response timestamp fields are now covered                          |
| 6   | Snapshots stayed `creating`, so rollback and delete were refused with `INSTANCE_BUSY` forever | The projection never settled snapshot state on completion                                                                                                                                                                                      | `settleSnapshot` in `applyCompleted`, resolving the snapshot from the operation's target; a delete removes both rows so the unique name is freed        |
| 7   | The audit log claimed a VM was created once per power change, resize, snapshot, and retention | `complete()` hardcoded `'create_instance'` for every capability's terminal audit entry; the replay admission path hardcoded the same action                                                                                                    | Both use the workflow's own action                                                                                                                      |
| 8   | A retained instance never reported when it stops being recoverable                            | `acceptRetention` stamps `retention_deadline` onto `control.instances` and does not touch the projection, and `applyCompleted` copied the previous document forward                                                                            | The terminal projection reads retention state back from the authoritative row                                                                           |

Defects 1 and 3 are safety-relevant in opposite directions. In 1, the safety rules worked exactly
as designed — an ambiguous provider outcome went to `manual_review` rather than risking a second
VM — and the deployment was what was wrong. In 3, a real internal inconsistency was correctly
classified as `protocol_error` and _not_ escalated to manual review, because a malformed request
that never reached the provider cannot have applied an effect.

### Regression coverage added

| Test                                                                                | Guards                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `claims a non-create workflow and hands back its own command`                       | Defect 2                                                    |
| `refuses a workflow whose stored command does not match its action`                 | Corruption, and the narrowing that defect 2's fix relies on |
| `seeds a non-create workflow with the provider resource the create discovered`      | Defect 3                                                    |
| `moves a created snapshot out of \`creating\` so it can be used`                    | Defect 6                                                    |
| `removes both rows when a snapshot is deleted, freeing its name`                    | Defect 6's delete path                                      |
| Collection assertions on `retentionDeadline`, `purgeEligible`, and the audit action | Defects 7 and 8                                             |

`pnpm run test:integration` is now 5 files and 88 tests, up from 83.

Defects 4 and 5 have no unit-level guard: both are wire-encoding faults that only appear across a
real gRPC boundary, and the Postman run is what exercises that. This is recorded rather than
papered over — `pnpm run postman:run` is the regression test for them, and it is not part of
`pnpm run test`.

### Verification

| Gate                        | Result                                                                 |
| --------------------------- | ---------------------------------------------------------------------- |
| `pnpm run postman:run`      | 62 of 62 requests, 100 assertions, 1 skipped                           |
| `pnpm run postman:check`    | 63 requests across 10 folders, all 39 declared REST operations covered |
| `pnpm run test:integration` | 5 files, 88 tests                                                      |
| `pnpm run k8s:render-check` | 161 objects render, validate, and satisfy 8 policies                   |
| `pnpm run docs:validate`    | 59 Markdown files, 40 Mermaid artifacts                                |

Evidence: `docs/verification/evidence/phase6-api-examples.json`, captured `2026-09-06T20:41:43Z`.

### Deviation recorded

The cluster was found stopped at the start of this checkpoint — the `minikube` container had exited
with code 137 during an idle period — and was restarted with `minikube start`. That is a cluster
lifecycle action, not a modification of the cluster foundation: no foundation object was created,
edited, or deleted, and the deployment came back from its own manifests.

Rollouts were restarted with `kubectl argo rollouts restart` after each image rebuild. This is
necessary because a rebuild under an unchanged tag produces no manifest change for Argo CD to
reconcile. It creates no new rollout revision and therefore runs no analysis, which is why the
operations manual presents it as the local iteration loop and a new image tag as the way to
exercise a real gated promotion.

## Checkpoint P6-14 — Credential redaction in committed evidence — Complete

### Defect

`pnpm run postman:run` redacted the `Authorization` request header before writing an exchange to
`docs/verification/evidence/phase6-api-examples.json`, but not the response _body_ of the identity
folder's three token requests. The fixture's token endpoint returns the bearer token as
`access_token`, so every run wrote three fully signed JWTs into a file staged for commit.

SAFE-036 governs what enters history, not how exploitable a particular value is. These tokens are
short-lived and valid only against an in-cluster issuer, but the rule does not have an exception
for weak credentials, and a redaction that covers only the header is the kind of partial control
that reads as complete.

### Fix

`tools/postman/run-collection.mjs` gained `redactTokens`, applied to every captured response body.
It walks the parsed body and replaces any `access_token`, `id_token`, `refresh_token`, or
`client_secret` value with `<redacted>`, at any depth. The header redaction beside it is unchanged.

The evidence file was regenerated by a full re-run rather than edited in place, so the committed
artifact is what the fixed runner actually produces.

### Verification

| Gate                              | Result                                       |
| --------------------------------- | -------------------------------------------- |
| `pnpm run postman:run`            | 62 of 62 requests, 100 assertions, 1 skipped |
| JWT scan of the evidence file     | no `eyJ`-prefixed signed token remains       |
| `access_token` values in evidence | `<redacted>` only                            |

Evidence: `docs/verification/evidence/phase6-api-examples.json`, captured `2026-09-07T14:51:07Z`.

### Deviation recorded

The re-run first failed with `503 no available server` at the Gateway. The Kafka broker pod was
`Running` and `Ready` while its log output had stopped fifteen hours earlier, and every client
reached it with `ECONNREFUSED` on the bootstrap Service — a wedged process the readiness probe
still counted as healthy. `control-plane-kafka-combined-0` and `control-plane-connect-connect-0`
were deleted so their StatefulSets could recreate them; `control-api` and
`provisioning-orchestrator` recovered on their own restart backoff. Persistent volumes and every
manifest were untouched, so this is a cluster lifecycle action rather than a foundation change.

Worth recording for its own sake: a readiness probe that reports healthy while the broker accepts
no connections is a gap in the deployment's own health semantics, not in the application.

## Resume Instructions

1. Read this file and `git status --short` before changing anything.
2. Continue only the checkpoint marked `In progress`.
3. Update this file with implementation and verification evidence before committing that
   checkpoint.
4. Record the commit hash, mark the checkpoint complete, and move `Current checkpoint` to the next
   pending item.
5. Never modify the existing cluster foundation by hand. If a foundation change is genuinely
   required, write it as a manifest and record why in the decision list above.
