# Kubernetes Manifests

Every object the control plane runs on a cluster is declared here. Nothing in this tree is applied
by hand after bootstrap: `tools/kubernetes/publish-gitops-repo.mjs` publishes it to the in-cluster
Git repository, and Argo CD reconciles the cluster against that.

The full explanation — why a `Rollout` instead of a `Deployment`, how the analysis gate decides, and
which substitutions this cluster forced — is in
[Phase 6 GitOps Deployment](../../docs/architecture/phase-6-gitops-deployment.md). This file is the
map.

## Directories

| Directory | Wave | Applied by | Contents |
| --- | --- | --- | --- |
| `bootstrap/` | — | `bootstrap.mjs` | Vendored Argo CD `v3.5.1` and Argo Rollouts `v1.9.1` install manifests, digest-pinned in `provenance.json` |
| `gitops-repo/` | — | `bootstrap.mjs` | The in-cluster `git daemon` Argo CD reads from |
| `argocd/` | — | root Application | `AppProject`, the six control-plane Applications, and the root Application |
| `namespace/` | 0 | `control-plane-foundation` | Namespace, service accounts, RBAC, network policies, disruption budgets |
| `platform/` | 1 | `control-plane-platform` | CloudNativePG, Strimzi, and KEDA as Argo CD Applications |
| `data/` | 2 | `control-plane-data` | Postgres cluster, Kafka cluster, topics, users, Kafka Connect, migration hook |
| `observability/` | 3 | `control-plane-observability` | OpenTelemetry Collector and `ServiceMonitor` objects |
| `applications/` | 4 | `control-plane-applications` | Rollouts, Services, `HTTPRoute`, `AnalysisTemplate` objects, KEDA autoscaling |
| `dashboards/` | 5 | `control-plane-dashboards` | Grafana dashboard and `PrometheusRule` alerts |

`bootstrap/` and `gitops-repo/` are excluded from the publish on purpose. Argo CD cannot reconcile
its own installation, and an application that manages the repository it is read from is a circular
dependency that makes a broken publish unrecoverable.

## Working on these files

```bash
pnpm run k8s:render-check          # render, schema-validate, and policy-check
pnpm run k8s:publish   # publish, then refresh and sync every application
pnpm run verify:phase6-runtime         # prove the running cluster behaves as declared
```

`render-check.mjs` is the fast gate and should pass before every publish. It builds each kustomize
root, validates the result against the live API server's schemas, and applies eight deployment
policies — resource bounds, probes, a `Rollout` for anything that takes traffic, a hardened pod
security context, no mounted service-account tokens, pinned images, a sync wave on every object, and
no committed credential.

## Two conventions that look like noise and are not

**API-server defaults are written out explicitly.** `protocol: TCP` on a container port,
`weight: 1` and the `path` match on an `HTTPRoute` rule. Argo CD normalises defaults for built-in
kinds but not for custom resource definitions, so a field left implicit on a `Rollout` or an
`HTTPRoute` is reported as permanent drift — which buries the real drift in noise and, worse, keeps
the application `OutOfSync` so that new revisions stop being auto-synced.

**A field a controller owns belongs in `ignoreDifferences`, not in the manifest.** Argo Rollouts
writes `rollouts-pod-template-hash` into every active and preview `Service` selector; KEDA writes
`spec.replicas` on the orchestrator's `Rollout`. Both are declared as exceptions in
`argocd/applications.yaml` with the reason attached. Adding a controller that writes to a managed
object means adding an entry there.

## Exempting an object from a policy

`render-check.mjs` accepts a declared exemption, and requires a reason for it:

```yaml
metadata:
  annotations:
    private-cloud.io/policy-exempt: probes
    private-cloud.io/policy-exempt-reason: >-
      A shell loop calling curl serves nothing and exposes no endpoint, so a probe could only
      assert that a process exists — which the kubelet already knows.
```

An exemption without a reason is itself a violation. That is the only way an exemption stays
reviewable after it is merged.

## Full catalogue

Every object here, the sync wave that places it, the Argo CD application that owns it, and
the reasoning behind each shape, is in
[Phase 6 Manifest Reference](../../docs/operations/phase-6-manifest-reference.md).
The commands that build, publish, and verify these manifests are in the
[Phase 6 Operations Manual](../../docs/operations/phase-6-operations-manual.md).
