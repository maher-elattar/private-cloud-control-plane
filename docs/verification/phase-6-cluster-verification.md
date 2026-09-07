# Phase 6 Cluster Verification

- Execution date: 2026-09-05 Africa/Cairo
- Result: **12 of 12 runtime checks passed** in one run, `2026-09-05T22:51:39Z` to
  `2026-09-05T23:19:28Z`, against Argo CD revision `d6a042cc6242`
- Cluster: minikube, single node, docker driver — Kubernetes server `v1.35.1`, kubelet `v1.35.1`,
  container runtime `docker://29.2.1`
- Tooling: `kubectl` client `v1.36.4` with Kustomize `v5.8.1`, Node.js `24.18.0`
- Pre-existing and not reinstalled: Argo CD `quay.io/argoproj/argocd:v3.5.1`, Argo Rollouts
  `quay.io/argoproj/argo-rollouts:v1.9.1`, kube-prometheus-stack, Traefik with Gateway API `v1.6.1`
- Installed by these manifests: CloudNativePG chart `0.29.0`, Strimzi `1.2.0`, KEDA `2.20.2`
- Provider: the deterministic fake adapter and the local TLS Proxmox-compatible simulator. **No
  hypervisor was contacted or mutated.**

## The gates

Three, in the order they are useful.

```bash
pnpm run k8s:render-check        # renders, schema-validates, and policy-checks the manifests
pnpm run k8s:publish             # publishes to the in-cluster repository and syncs
pnpm run verify:phase6-runtime   # asserts against the running cluster
```

`render-check` result: **161 objects render, validate against the live API server, and satisfy all
eight deployment policies.** The vendored `bootstrap/` root is rendered and policy-exempt but not
dry-run, because this cluster's Argo CD and Argo Rollouts come from a Helm release with different
label selectors and a dry run there reports an immutable-selector conflict with a foreign
installation rather than a verdict on the manifests.

`verify:phase6-runtime` writes machine-readable evidence to
[`evidence/phase6-runtime.json`](evidence/phase6-runtime.json).

## Runtime results

| Check | What it asserts | Measured result |
| --- | --- | --- |
| `environment` | The context, the namespace, and the controllers are the ones this suite is about | Passed |
| `gitops-reconciliation` | All ten applications Synced and Healthy against the published revision | Passed |
| `sync-waves` | The applications carry the roadmap's wave order | Passed |
| `rollouts-not-deployments` | All four services are `Rollout` objects; no `Deployment` stands in | Passed |
| `health-checks-and-boundaries` | Startup, liveness, and readiness probes; network policies; disruption budgets | Passed |
| `metrics-pipeline` | Prometheus is scraping the preview and active Services and the series the gate queries exists | Passed |
| `header-routing` | `X-Canary: green` reaches the preview environment and nothing else does | Passed |
| `promotion-passes-on-healthy-green` | A healthy green is promoted, and the active Service moves to it | Passed |
| `analysis-aborts-and-self-heals-on-degraded-green` | A green below the 90% gate is refused, and the active Service does not move | Passed |
| `progress-deadline-aborts-an-unready-green` | A green that never becomes ready aborts on its own | Passed |
| `argocd-reverts-manual-drift` | A hand-changed field and a hand-deleted object are both put back | Passed |
| `secrets-are-generated-not-committed` | Every credential is operator-generated; none came from the repository | Passed |

## The promotion decision, measured

The healthy promotion and the refused one were driven the same way — by publishing to the GitOps
repository and letting the control loop act — and they differ only in what the green environment was
returning.

**Promoted.** Pre-promotion analysis over four measurements twenty seconds apart:

| Metric | Measurements | Verdict |
| --- | --- | --- |
| `green-ready-replicas` | `2, 2, 2, 2` | Successful (≥ 2) |
| `green-request-rate` | `1.88, 2.52, 2.54, 2.50` req/s | Successful (≥ 0.10) |
| `green-http-200-rate` | `1, 1, 1, 1` | Successful (≥ 0.90) |

Post-promotion analysis repeated the scrape-health and success-rate metrics and also passed. The
active Service's `rollouts-pod-template-hash` moved to the promoted ReplicaSet.

**Refused.** With a load generator sending a majority of `X-Canary: green` requests to paths the API
does not serve — degrading the *traffic*, not the build, so that the gate rather than the image is
what is under test:

| Metric | Measurements | Verdict |
| --- | --- | --- |
| `green-ready-replicas` | `2, 2` | Successful |
| `green-request-rate` | `4.11, 5.42` req/s | Successful |
| `green-http-200-rate` | `0.652, 0.646` | **Failed** (< 0.90) |

```
RolloutAborted: Rollout aborted update to revision 11:
  Blue/green pre-promotion analysis phase error/failed:
  Metric "green-http-200-rate" assessed Failed due to failed (2) > failureLimit (1)
```

The two passing metrics matter as much as the failing one: availability and traffic were both fine,
so the refusal was about the *responses*. The active Service still selected the pre-drill stable
ReplicaSet, which is the precise statement that no production request reached the degraded version.

**Aborted without any analysis.** Deploying an image tag that exists nowhere gives a green
environment whose pods never become ready, so they never join the preview Service and no metric is
ever produced. `progressDeadlineSeconds: 420` with `progressDeadlineAbort: true` aborted it anyway:

```
RolloutAborted: Rollout aborted update to revision 26
```

recorded with `readyPreviewEndpoints: 0` and the active Service still selecting `66cddf49d`.

The measurements quoted above are from the run that first exposed the abort path. The final green
run reproduced every verdict: `control-api-6c7d9c86f-22-post` Successful over four measurements,
`control-api-865cfcf4fd-24-pre` Failed on `green-http-200-rate` with `green-request-rate` and
`green-ready-replicas` both Successful, and the active Service still on `66cddf49d` afterwards.

## Self-healing, both kinds

| Drift | Introduced by | Result |
| --- | --- | --- |
| Changed field | `kubectl patch rollout control-api --type=merge -p '{"spec":{"replicas":4}}'` | Argo CD reverted `spec.replicas` from 4 to the declared 2 |
| Deleted object | `kubectl delete service control-api-preview` | Argo CD recreated it, with a new UID (`d42d4a12-…`) |

Both were then followed by every application returning to Synced and Healthy.

## Defects this run found

Three real ones, all fixed in the manifests and tooling rather than worked around. They are written
up with their reasoning in `phase-6-completion-checkpoints.md`, checkpoint P6-11:

1. Argo Rollouts owns `rollouts-pod-template-hash` in the active and preview Service selectors, and
   nothing declared it as such — leaving the application permanently `OutOfSync`, which in turn made
   Argo CD stop treating new revisions as new syncs.
2. The in-cluster repository server rolled with `RollingUpdate`, so two pods briefly served two
   unrelated histories behind one Service.
3. Two bugs in the verification tool itself: `AnalysisRun` objects were queried by a label Argo
   Rollouts does not set, and the drills exercised the gate by alternating two image tags — which
   Argo Rollouts correctly treats as a rollback and completes without analysis.

## Scope

This verifies the deployment: that Argo CD reconciles what the repository says, that the header route
reaches the environment it claims to, that the promotion gate judges the green environment on real
traffic, and that changes made outside the repository do not survive. It does **not** re-verify the
control plane's own semantics; those are covered by
[Phase 4 Local Verification](phase-4-local-verification.md) and the Phase 5 capability tests.
