# Phase 6 — Kubernetes Deployment and the GitOps Control Loop

Phase 6 does not add a capability. It changes how every capability that already exists gets onto a
cluster, and what happens when a new version of one turns out to be worse than the version it
replaced.

Everything the control plane runs is declared in [`deploy/kubernetes`](../../deploy/kubernetes).
Argo CD reconciles that directory continuously. The four services are deployed as Argo Rollouts
`Rollout` objects with a blue-green strategy, a header-matched route that lets a request opt into
the new version before anyone else sees it, and an automated analysis gate that measures the new
version's HTTP results and refuses to promote it below a 90% success rate.

- [What changed, and why it is not a Deployment](#what-changed-and-why-it-is-not-a-deployment)
- [Layout](#layout)
- [The control loop](#the-control-loop)
- [Sync waves](#sync-waves)
- [Blue-green promotion](#blue-green-promotion)
- [Header-based routing](#header-based-routing)
- [The analysis gate](#the-analysis-gate)
- [Self-healing, stated precisely](#self-healing-stated-precisely)
- [Health checks](#health-checks)
- [The metrics pipeline that makes analysis possible](#the-metrics-pipeline-that-makes-analysis-possible)
- [Boundaries](#boundaries)
- [Secrets](#secrets)
- [Storage: Longhorn, Kafka, and what replication is for](#storage-longhorn-kafka-and-what-replication-is-for)
- [Substitutions this cluster forced](#substitutions-this-cluster-forced)
- [Operating it](#operating-it)

## What changed, and why it is not a Deployment

Through Phase 5 the deployment story was `deploy/local/compose.phase4.yaml`: a Docker Compose
stack, brought up by hand, with `docker compose up -d` as the release procedure. That is a
development environment, and it has no answer to the question a release actually poses — *is the
new version worse than the old one, and how would we know before it matters?*

A Kubernetes `Deployment` does not answer it either. A rolling update replaces pods a few at a time
and declares success when the new pods pass their readiness probe. A readiness probe says the
process is up and its database is reachable. It does not say the new version returns the right
answers, and by the time anyone notices that it does not, the old pods are gone.

A `Rollout` answers it by keeping both versions running:

| | `Deployment` | `Rollout` (blue-green) |
| --- | --- | --- |
| New version receives traffic | Immediately, mixed with the old | Only through the preview `Service` |
| Success criterion | Readiness probe passes | Readiness **and** a measured HTTP success rate |
| Who decides | The kubelet | An `AnalysisRun` querying Prometheus |
| Failure recovery | A second rolling update, forward | Selector never moves; old version never stopped |
| Old version after cutover | Deleted | Kept for `scaleDownDelaySeconds` |

The last row is what makes an abort cheap. When post-promotion analysis fails, blue is still
running, and putting the active `Service` back is a selector change rather than a cold start.

## Layout

```
deploy/kubernetes/
├── bootstrap/        Vendored Argo CD and Argo Rollouts install manifests, digest-pinned
├── gitops-repo/      The in-cluster Git repository Argo CD reads from
├── argocd/           AppProject, the six Applications, and the root Application
├── namespace/        wave 0  Namespace, service accounts, RBAC, network policies, PDBs
├── platform/         wave 1  CloudNativePG, Strimzi, and KEDA as Argo CD Applications
├── data/             wave 2  Postgres, Kafka, topics, users, Kafka Connect, migrations
├── observability/    wave 3  OpenTelemetry Collector and ServiceMonitors
├── applications/     wave 4  Rollouts, Services, HTTPRoute, AnalysisTemplates, autoscaling
└── dashboards/       wave 5  Grafana dashboard and PrometheusRule alerts
```

Each of the six numbered directories is a kustomize root and the `path` of exactly one Argo CD
`Application`. Nothing in the tree is applied by hand after bootstrap.

## The control loop

Argo CD reads a Git repository. This deployment is verified on a single-node minikube with no
external forge, so the repository is *in the cluster*: `gitops-repo` runs `git daemon` over a bare
repository built from a ConfigMap, and `tools/kubernetes/publish-gitops-repo.mjs` packs
`deploy/kubernetes` into that ConfigMap and commits it.

That is a local substitution for a hosted repository, and it is deliberately the only one. Argo CD
sees a normal `git://` remote; the `Application` objects, the sync waves, the diffing, and the
self-healing all behave exactly as they would against GitHub. Pointing this at a real remote is one
`repoURL` change per `Application`.

```bash
pnpm run k8s:bootstrap    # once, on a new cluster
pnpm run k8s:publish      # after every manifest edit
```

`bootstrap.mjs` is the only tool that touches the cluster imperatively, and it does as little as
possible: verify the vendored manifests against their recorded digests, install the controllers
*only if they are absent*, apply the `AppProject`, and apply the root `Application`. From there the
root application manages the other six, and every subsequent change reaches the cluster by being
published to the repository.

## Sync waves

![Phase 6 sync waves](../diagrams/rendered/phase-6-sync-waves.mermaid.svg)

Argo CD applies a wave only once the previous wave's resources are healthy. The ordering is not
cosmetic — three of these edges are correctness constraints that were each discovered by violating
them:

- **Operators before their custom resources** (wave 1 before wave 2). A `Kafka` object applied
  before the Strimzi CRDs exist is not a slow sync; it is a hard failure that Argo CD reports as
  `ComparisonError` on the whole application.
- **The schema migration before the Debezium connector** (wave 3 hook before wave 4). The connector
  uses `publication.autocreate.mode: filtered`, and a filtered publication over tables that do not
  exist yet fails with `No table filters found` — a *permanent* failure the connector does not
  retry. The migration runs as a `Sync` hook so that it is a step in the sync rather than a
  workload competing with it.
- **Observability before the applications** (wave 3 before wave 4). The promotion gate queries
  Prometheus for the green environment's HTTP results. If the `ServiceMonitor` does not exist when
  the first rollout starts, the gate has nothing to read and the traffic floor correctly fails the
  promotion — a confusing way to discover an ordering bug.

## Blue-green promotion

![Blue-green promotion sequence](../diagrams/rendered/phase-6-bluegreen-promotion.mermaid.svg)

The `Rollout` names two `Service` objects, and Argo Rollouts owns their selectors:

| Service | Selector | Who reaches it |
| --- | --- | --- |
| `control-api` | stable pod-template hash | Everything, through the Gateway |
| `control-api-preview` | new pod-template hash | `X-Canary: green` requests, and Prometheus |

Neither `Service` has a hand-written pod-template-hash selector; the controller writes it. That is
why the verification asserts on `spec.selector["rollouts-pod-template-hash"]` — it is the single
field that decides which environment is serving, so "the promotion happened" and "the promotion was
refused" are both statements about that one value.

`autoPromotionEnabled: true` is deliberate. The analysis *is* the gate; a human confirmation step
in front of a passing analysis adds latency without adding evidence, and behind a failing one is
never reached.

### A rollback is not a promotion

One behaviour is worth knowing before it surprises someone. Deploying a pod template that Argo
Rollouts has recently promoted — most often by putting back the image tag that was running a minute
ago — is a **rollback within `scaleDownDelay`**, and Argo Rollouts completes it immediately, without
running any analysis:

```
Rollout completed update to revision 10 (86c8db9988): Rollback to 'control-api-86c8db9988' within scaleDownDelay
```

That is the right behaviour. The old ReplicaSet is still running and its revision already earned its
promotion; making a rollback re-earn it would put the slowest possible gate in front of the fastest
possible recovery.

It does mean that "flip the image tag back and forth" is not a way to exercise the gate. The
verification drills therefore stamp a unique annotation onto the pod template, so that every drill is
a genuine forward promotion regardless of which image it deploys.

## Header-based routing

`applications/routing.yaml` declares one `HTTPRoute` with two rules on the existing Traefik
Gateway:

```yaml
rules:
  - matches:
      - path: { type: PathPrefix, value: / }
        headers:
          - { type: Exact, name: X-Canary, value: green }
    backendRefs:
      - { name: control-api-preview, port: 3000, weight: 1 }
  - matches:
      - path: { type: PathPrefix, value: / }
    backendRefs:
      - { name: control-api, port: 3000, weight: 1 }
```

Gateway API rule precedence is defined, not incidental: among rules with equally specific paths,
the one with more header matches wins. The canary rule therefore takes precedence for requests
carrying the header and never for any other request, without either rule needing a priority field.

This is the mechanism that makes the analysis meaningful. The green environment is not judged on
synthetic traffic invented by the rollout controller; it is judged on real requests that traversed
the real Gateway, the real route, and the real `Service`, differing from production traffic only in
who chose to send them.

Two `weight: 1` values and the explicit `path` are written out because the API server defaults them
and Argo CD's diff does not normalise defaults on every field — leaving them implicit produced
permanent, meaningless `OutOfSync` noise that hides real drift.

## The analysis gate

![The analysis gate](../diagrams/rendered/phase-6-analysis-gate.mermaid.svg)

Three `AnalysisTemplate` objects in `applications/analysis-templates.yaml`, all querying the
cluster Prometheus. They run as `prePromotionAnalysis` (before the active `Service` moves) and,
for two of them, again as `postPromotionAnalysis` (after it does).

### `green-http-success-rate` — the rule the operator asked for

```promql
sum(rate(http_server_request_duration_count{namespace="…",service="control-api-preview",
                                            http_response_status_code="200"}[1m])) or vector(0)
/
clamp_min(sum(rate(http_server_request_duration_count{namespace="…",
                                                      service="control-api-preview"}[1m])), 0.001)
```

`successCondition: result[0] >= 0.90`. Two details in that query are load-bearing:

- **`or vector(0)`** on the numerator. PromQL returns an *empty vector*, not zero, when no series
  match. Without this, a green environment that has served no successful request produces no
  result at all, and an analysis with no result is not a failure — it is an error, which is a
  different and less obvious outcome.
- **`clamp_min(…, 0.001)`** on the denominator. Division by an empty or zero denominator yields
  `NaN`, and `NaN >= 0.90` is false — so it happens to fail, but for the wrong reason and with an
  unreadable message. The clamp makes "no traffic" produce a success rate of 0 and fail the gate
  honestly.

`count: 4`, `interval: 20s`, `failureLimit: 1`. One bad measurement is noise; two is a verdict.

### `green-traffic-floor` — silence is not health

A green environment receiving no traffic at all has a perfectly defensible 0/0 success rate. This
template requires at least 0.10 requests per second before the success rate is allowed to mean
anything. Without it, a broken header route would promote every build.

### `green-scrape-health` — the pods are actually being measured

`count(up{...} == 1) >= minimum-ready-replicas`. Prometheus reporting `up == 0` for a green pod
means the gate is blind, and a blind gate must not pass.

`initialDelay: 45s` on all three, because the preview `ServiceMonitor` scrapes every 10s and a
measurement taken before the second scrape is a measurement of an empty rate window.

## Self-healing, stated precisely

"Self-healing" is used for two different mechanisms here, and conflating them makes both harder to
reason about.

**Argo Rollouts self-heals a bad release.** When an `AnalysisRun` fails, the rollout aborts: the
active `Service` selector does not move (pre-promotion) or moves back (post-promotion), and the
green ReplicaSet is scaled down. The recorded evidence for this is that the active `Service` still
selects the pod-template hash that was stable before the drill — which is a stronger statement than
"the rollout is Degraded", because it says no production request ever reached the bad version.

There is a second abort path that no analysis can cover: green pods that never become ready never
join the preview `Service`, so no metric is ever produced and no `AnalysisRun` can fail.
`progressDeadlineSeconds: 420` with `progressDeadlineAbort: true` is the gate for that branch.

**Argo CD self-heals configuration drift.** `syncPolicy.automated.selfHeal: true` reverts a change
made to a managed object by anything other than the repository, and `prune: true` deletes objects
the repository no longer declares. `tools/kubernetes/verify-phase6.mjs` proves both by causing
drift on purpose: it patches the rollout's replica count and deletes the preview `Service`, then
asserts the cluster puts both back.

`ignoreDifferences` carves out exactly one exception, and only where two controllers legitimately
own the same field: KEDA writes `spec.replicas` on the orchestrator's `Rollout`, so Argo CD is told
not to treat that field as drift. Without the exception, the autoscaler and the GitOps controller
fight over one integer forever.

## Health checks

Three probes per service, answering three different questions:

| Probe | Question | Consults the database? |
| --- | --- | --- |
| `startupProbe` | Has the process finished starting? | No |
| `livenessProbe` | Is the process wedged and worth restarting? | **No** |
| `readinessProbe` | Should this pod receive traffic? | Yes |

The liveness probe deliberately never consults a dependency. A database outage is not something a
restart fixes, and a liveness probe that failed on one would restart every replica of every service
at the worst possible moment. The readiness probe does consult it, via
`isDatabaseReachable()` — a bounded `SELECT 1`, chosen so that readiness does not depend on
migration state.

The startup probe exists because the services connect three Kafka consumers before they begin
listening, which can take a minute; without it the liveness probe would kill the process mid-connect
in a loop.

`proxmox-provider` is the exception: its readiness calls its own provider port's `getCapabilities`,
which is answered by the adapter without contacting a hypervisor.

## The metrics pipeline that makes analysis possible

The analysis needs per-environment HTTP results, and the existing telemetry pipeline could not
supply them. The services export OTLP to a Collector, which aggregates across every pod of a
service — so blue and green are indistinguishable in the resulting series, which is precisely the
distinction the gate is about.

`packages/observability` therefore gained an opt-in Prometheus scrape endpoint, enabled by
`PROMETHEUS_METRICS_PORT`. Each pod is then its own scrape target, and a `ServiceMonitor` on the
*preview* `Service` sees green pods and only green pods.

Three constraints were applied to it, and each is in the code with the reason attached:

- The HTTP server duration histogram is bounded by an SDK view to four attributes —
  `http.request.method`, `http.response.status_code`, `http.route`, `error.type` — with a
  cardinality limit of 512. This is SAFE-034 enforced at the same point the package already
  enforces it for custom instruments.
- `resourceDetectors: []`, because the Prometheus exporter publishes resource attributes as a
  `target_info` series, and the default detectors put the host name, the process owner, and the
  process command line into it.
- Both readers run at once: OTLP to the Collector for the existing dashboards, and the scrape
  endpoint for the gate. They are separate readers over the same meter provider, not a replacement.

The scrape name is `http_server_request_duration_count` — not `..._seconds_count`. The OpenTelemetry
Prometheus exporter drops the unit suffix on histograms whose boundaries are already in seconds,
which is the kind of detail that makes a PromQL query silently return nothing.

## Boundaries

![Network boundaries](../diagrams/rendered/phase-6-network-boundaries.mermaid.svg)

The namespace enforces the `restricted` Pod Security Standard and denies all traffic by default, in
both directions. Every allowance is one rule naming one dependency:

Egress is restricted as tightly as ingress on purpose. A provider adapter that can reach arbitrary
hosts is a provider adapter that can be pointed at a hypervisor nobody authorised — which is the
network-layer restatement of the lab boundary in
[Lab Boundary](lab-boundary.md).

The reconciler's ingress rule to `proxmox-provider` is worth reading twice: it is present because
the reconciler *observes*, and its client exposes exactly one read RPC. The network rule does not
create that restriction — the code does — but it makes the restriction visible to someone reading
the deployment rather than the application.

Every pod additionally runs with `automountServiceAccountToken: false`. None of these workloads
calls the API server, so a projected token in every pod would be a credential with no purpose,
which is the kind an attacker finds useful and an operator never rotates. The single exception is
the analysis reader role, which grants read access to services and endpoints and is bound to
nothing that runs application code.

## Secrets

No credential value is in this repository, and that is verified rather than asserted (SAFE-036).

| Credential | Generated by | Consumed as |
| --- | --- | --- |
| Postgres application role | CloudNativePG, into `control-plane-postgres-app` | `DATABASE_URL` from the `uri` key |
| Kafka client password | Strimzi `KafkaUser`, into `control-plane` | A projected file at `/etc/private-cloud/kafka/password` |
| Kafka cluster CA | Strimzi, into `control-plane-kafka-cluster-ca-cert` | A projected file at `/etc/private-cloud/kafka/ca.crt` |
| Kafka Connect client | Strimzi `KafkaUser`, into `kafka-connect` | Referenced by the `KafkaConnect` object |

The repository names them; it never holds them. Rotation is an operator concern, and a rotated
Secret reaches the pods without any manifest changing.

Exactly one `Secret` is applied from the repository — `control-plane-keda` — and it holds no
credential: the SASL mechanism name, the TLS switch, and the principal KEDA uses to look the real
credential up. The password beside it in the `TriggerAuthentication` is read from the Strimzi
Secret. Both `tools/kubernetes/render-check.mjs` (which rejects any other committed `Secret`) and
`tools/kubernetes/verify-phase6.mjs` (which asserts that every other Secret in the namespace carries
an operator owner reference and no Argo CD tracking annotation) enforce this.

## Storage: Longhorn, Kafka, and what replication is for

The roadmap calls for consuming an existing Longhorn storage class. This cluster is a single-node
minikube whose only class is `standard`, backed by `k8s.io/minikube-hostpath`, with no volume
expansion and a `Delete` reclaim policy. The substitution is recorded here rather than made
silently, because the tradeoff it exposes is worth stating in its own right.

**Longhorn replicates a volume; Kafka replicates a partition. Doing both is usually wrong.**

Longhorn synchronously mirrors every block write to *n* replicas on different nodes, so a lost node
loses no data and the volume reattaches elsewhere. Kafka does the same job one layer up: a topic
with `replication.factor: 3` and `min.insync.replicas: 2` keeps each partition on three brokers and
refuses a write that has not reached two of them.

Running Kafka on 3-replica Longhorn volumes with a 3-replica topic means every produced record is
written nine times and traverses the network twice before it is acknowledged — once for Kafka's
follower fetch, once for Longhorn's replica write. The write amplification is real, the latency cost
is real, and the durability improvement is close to nil, because the failure Longhorn protects
against (a node dies, the volume must move) is the same failure Kafka already handles by promoting a
follower — faster, and without a volume reattach.

The rule this deployment follows:

| Workload | Replication belongs at | Storage class should be |
| --- | --- | --- |
| Kafka brokers | The application (partition replicas + `min.insync.replicas`) | Local or single-replica; fast, unreplicated |
| PostgreSQL under CloudNativePG | The application (streaming replicas, one per instance) | Local or single-replica |
| A single-instance database with no replica | The storage layer | Longhorn, replicated |
| Object-ish state with no application-level redundancy | The storage layer | Longhorn, replicated |

CloudNativePG's own guidance is the same: it manages replicas itself and expects each instance to
own a local volume, because a replicated volume under a replicated database pays twice for one
guarantee.

What this cluster actually runs, and why it is honest about it: one Kafka broker with
`replication.factor: 1` and one Postgres instance. On a single node, three brokers on one kernel
and one disk survive exactly the failures one broker survives, while consuming three times the
6.0 GiB the node has left. The manifests hold the replication factor and the storage class as
values in one place each, so a multi-node cluster changes those numbers and nothing else.

## Substitutions this cluster forced

Four, each recorded in `phase-6-completion-checkpoints.md` at the time it was made:

1. **Longhorn → `standard`.** As above. The storage class is a single value per stateful workload.
2. **Argo CD and Argo Rollouts are not re-installed.** Both were already present and Helm-managed.
   Applying vendored upstream manifests over a live Helm release rewrites ownership metadata and
   can leave the release unrepairable. The pinned manifests are still vendored — that is the
   declarative record, and a fresh cluster is bootstrapped from them — but `bootstrap.mjs` checks
   the installed version first and refuses to overwrite a healthy install it did not create. This is
   also why `render-check.mjs` skips the server-side dry run for `bootstrap/`: dry-running those
   manifests over the Helm release reports an immutable-selector conflict with a foreign
   installation, which says nothing about whether the manifests are valid.
3. **HTTP, not TLS.** There is no cert-manager on this cluster and the existing Gateway has an HTTP
   listener only. The `HTTPRoute` attaches to that listener; adding a TLS listener and a
   `Certificate` later does not restructure anything.
4. **A 6.0 GiB disk budget.** Every PersistentVolume and every image layer comes out of it. It is
   the reason Kafka is a single KRaft-combined node and the reason images are built directly inside
   minikube rather than on the host and loaded.

## Operating it

Every command, in the order it is run, with teardown and image builds, is in the
[Phase 6 Operations Manual](../operations/phase-6-operations-manual.md). The short form:

```bash
# Build the seven images into minikube's own Docker daemon. The one imperative step.
pnpm run k8s:build-images

# Install on a fresh cluster (idempotent; refuses to overwrite a foreign controller install).
pnpm run k8s:bootstrap

# Publish manifest edits and hard-refresh every application.
pnpm run k8s:publish

# Render, validate against the API server, and apply the deployment policies.
pnpm run k8s:render-check

# Terminate a stuck operation and force a sync of every application.
pnpm run k8s:resync -- --wait

# Prove the cluster does what this document says. Writes docs/verification/evidence/phase6-runtime.json.
pnpm run verify:phase6-runtime
pnpm run verify:phase6-runtime -- --skip-drills   # observation only, no rollouts
```

Failure handling for the rollout and GitOps paths is in
[Phase 6 Deployment Runbook](../runbooks/phase-6-deployment.md). The metrics and alerts this
deployment adds are catalogued in
[Phase 6 Deployment Metric Catalog](../observability/phase-6-deployment-metrics.md). The measured
results of the last run — the promoted green, the refused one, and the drift that did not survive —
are in [Phase 6 Cluster Verification](../verification/phase-6-cluster-verification.md). Every object
this deployment creates is catalogued in the
[Phase 6 Manifest Reference](../operations/phase-6-manifest-reference.md), and the API it exposes is
exercised end to end by the
[Phase 6 Postman Collection](../operations/phase-6-postman-collection.md).
