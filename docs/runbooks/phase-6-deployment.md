# Phase 6 Deployment Runbook

Failure handling for the Kubernetes deployment and the two control loops that keep it correct:
Argo CD, which reconciles the cluster against the repository, and Argo Rollouts, which decides
whether a new version is allowed to replace the one serving traffic.

The architecture this operates is described in
[Phase 6 GitOps Deployment](../architecture/phase-6-gitops-deployment.md). Everything below assumes
`kubectl` is pointed at the cluster and the working directory is the repository root.

## Orientation

```bash
kubectl get applications -n argocd -l app.kubernetes.io/part-of=private-cloud-control-plane
kubectl get rollouts,svc,httproute -n private-cloud
kubectl get analysisruns -n private-cloud --sort-by=.metadata.creationTimestamp
kubectl argo rollouts get rollout control-api -n private-cloud   # if the plugin is installed
```

A healthy steady state is ten applications `Synced`/`Healthy`, four rollouts `Healthy`, and no
`AnalysisRun` newer than the last promotion.

```bash
pnpm run verify:phase6-runtime -- --skip-drills    # ~4 minutes, changes nothing
```

## A rollout is stuck in `Paused` or `Progressing`

**Expected state:** green pods are running, the preview `Service` selects them, and an
`AnalysisRun` is taking measurements. A rollout legitimately sits here for the length of the
analysis — `initialDelay` plus `count × interval`, about two minutes.

1. Read the analysis, not the rollout. The rollout's message is a summary; the measurements are the
   evidence.

   ```bash
   kubectl get analysisruns -n private-cloud --sort-by=.metadata.creationTimestamp -o json \
     | jq '.items[-1].status.metricResults[] | {name, phase, message, measurements: (.measurements|length)}'
   ```

2. If `green-scrape-health` is failing, Prometheus is not scraping green. Check that the preview
   `Service` has endpoints and that the target is up:

   ```bash
   kubectl get endpointslices -n private-cloud -l kubernetes.io/service-name=control-api-preview
   node -e "import('./tools/kubernetes/prometheus.mjs').then(async m =>
     console.log((await m.activeTargets('private-cloud')).length))"
   ```

3. If `green-traffic-floor` is failing, nothing is reaching green. Confirm the header route and the
   load generator:

   ```bash
   kubectl get httproute control-api -n private-cloud -o yaml | grep -A6 headers
   kubectl logs -n private-cloud -l private-cloud.io/load-target=green --tail=20
   ```

4. If `green-http-200-rate` is failing, green is answering but answering badly. **This is the gate
   working.** Do not override it; read what green is returning:

   ```bash
   kubectl logs -n private-cloud -l app.kubernetes.io/name=control-api --tail=100 \
     --selector-from-rollout-preview 2>/dev/null || \
     kubectl logs -n private-cloud deploy/control-api --tail=100
   ```

**Never** promote past a failing analysis by patching the rollout. The correct recovery is to fix
the image or configuration, publish it, and let the gate judge the next revision.

## A rollout aborted

**Expected state:** `status.abortedAt` is set, the active `Service` still selects the previous
ReplicaSet, and production traffic never touched green.

1. Confirm the active `Service` is still on the stable revision. This is the fact that matters —
   it says whether anyone was affected.

   ```bash
   kubectl get svc control-api -n private-cloud -o jsonpath='{.spec.selector}'
   kubectl get rollout control-api -n private-cloud -o jsonpath='{.status.stableRS} {.status.currentPodHash}'
   ```

2. Identify which branch aborted it:
   - An `AnalysisRun` in `Failed` → the measured gate refused the promotion.
   - No `AnalysisRun` at all, and a message mentioning the progress deadline → green never became
     ready, so no analysis could run. Look at the green pods:

     ```bash
     kubectl get pods -n private-cloud -l app.kubernetes.io/name=control-api \
       -o custom-columns=NAME:.metadata.name,HASH:.metadata.labels.rollouts-pod-template-hash,STATUS:.status.phase,READY:.status.containerStatuses[0].ready
     kubectl describe pod -n private-cloud <green-pod>
     ```

     The usual causes are an image tag that does not exist on the node, a readiness probe failing
     because the database is unreachable, and a pod rejected by the `restricted` Pod Security
     profile.

3. Fix the cause in `deploy/kubernetes`, publish, and let the next revision go through the gate.

   ```bash
   pnpm run k8s:publish
   ```

The aborted ReplicaSet is scaled down after `abortScaleDownDelaySeconds`; nothing needs deleting.

An aborted rollout does not retry on its own — its desired spec has not changed, and retrying the
same spec unprompted would loop. Once the cause is fixed and published, the new spec starts a fresh
rollout. To retry the *same* spec deliberately, for instance after fixing something outside the
manifest:

```bash
kubectl argo rollouts retry rollout control-api -n private-cloud
```

## A deployment completed without running any analysis

**Expected state:** every forward promotion runs pre-promotion analysis.

If the rollout's events say

```
Rollout completed update to revision N (<hash>): Rollback to 'control-api-<hash>' within scaleDownDelay
```

then this was a rollback, not a promotion: the pod template matched a ReplicaSet Argo Rollouts had
recently promoted and had not yet scaled down, so it switched back to it directly. That is correct —
a rollback should not have to re-earn a gate it already passed — but it means putting an old image
tag back is not a way to test the gate, and it is not evidence that the gate is disabled.

To confirm the gate still runs, deploy a pod template the controller has not seen. The verification
drills do this by stamping a unique `private-cloud.io/drill-revision` annotation onto the pod
template.

## An application will not leave `OutOfSync`

**Expected state:** an application reaches `Synced` within a minute of a publish.

1. Ask what actually differs, rather than guessing:

   ```bash
   argocd app diff control-plane-applications --core     # requires the kube context namespace to be argocd
   kubectl get application control-plane-applications -n argocd -o json \
     | jq -r '.status.resources[] | select(.status != "Synced") | "\(.kind)/\(.name)"'
   ```

2. **If the difference is a field a controller owns, the manifest is wrong, not the cluster.** Argo
   Rollouts writes `rollouts-pod-template-hash` into Service selectors; KEDA writes `spec.replicas`
   on the orchestrator's `Rollout`. Both are declared in `ignoreDifferences` in
   `argocd/applications.yaml`. A newly introduced controller-owned field needs an entry there.

   This failure mode is worth recognising quickly because of what it does *next*: a permanently
   `OutOfSync` application stops being auto-synced on new revisions and starts being self-healed on
   a backoff that reaches five minutes, so genuine changes appear to be ignored.

3. If the difference is a field the API server defaults, write the default explicitly in the
   manifest rather than adding an exception.

4. To clear a stuck operation or a backoff without waiting:

   ```bash
   pnpm run k8s:resync -- --wait
   ```

## A publish does not reach the cluster

**Expected state:** `publish-gitops-repo.mjs` prints `published`, then `serving <commit>`, then
`resynced 10 applications`.

1. If it stops at the `serving` wait, the repository server did not come back with this publish.

   ```bash
   kubectl get pods -n private-cloud-gitops
   kubectl logs -n private-cloud-gitops deploy/gitops-repo -c build-repository
   ```

2. Confirm what the repository is actually serving:

   ```bash
   kubectl exec -n private-cloud-gitops deploy/gitops-repo -c git-daemon -- \
     sh -c 'git --git-dir=/srv/git/control-plane.git show main:.publish-digest'
   ```

   That digest must equal the one the publisher printed. The Deployment uses the `Recreate`
   strategy specifically so that two pods never serve two different repositories at once.

3. If the archive exceeded its ceiling, the publisher refuses rather than truncating. Move the new
   content into its own Argo CD `Application` with its own source.

## The database or Kafka is not ready and the applications will not start

**Expected state:** wave 2 completes before wave 4 begins, so this should not happen from a clean
sync. It does happen when a wave-2 object is edited in place.

```bash
kubectl get cluster -n private-cloud control-plane-postgres
kubectl get kafka,kafkanodepool,kafkatopic,kafkauser -n private-cloud
kubectl get kafkaconnector -n private-cloud -o wide
kubectl get jobs -n private-cloud            # the schema migration hook
```

If the Debezium connector is `FAILED` with `No table filters found for filtered publication`, it
started before the migration created the tables. That failure is permanent, not retried:

```bash
kubectl annotate kafkaconnector private-cloud-outbox -n private-cloud strimzi.io/restart-task=0 --overwrite
```

The structural fix is already in place — the connector is at sync wave 4, behind the wave 3
migration hook — so this should only appear after a hand edit.

## Something was changed by hand

Argo CD reverts it. That is the intended behaviour and it is verified:
`verify-phase6.mjs` patches a rollout's replica count and deletes a Service, then asserts both come
back.

If a change genuinely needs to survive, it belongs in `deploy/kubernetes` and in a publish. There is
no supported path for a durable manual change, by design.

## Escalation boundary

Two things this runbook deliberately does not tell you to do:

- **Do not promote past a failing analysis.** The gate exists because a readiness probe cannot tell
  a working version from a broken one. Overriding it discards the only evidence there was.
- **Do not delete a `Rollout` to "reset" it.** Deleting it deletes both environments, including the
  one currently serving. An aborted rollout is already the safe state.

## Related documents

- [Phase 6 Operations Manual](../operations/phase-6-operations-manual.md) — the commands, for when nothing is wrong
- [Phase 6 Manifest Reference](../operations/phase-6-manifest-reference.md) — what each object is and which application owns it
- [Phase 6 Postman Collection](../operations/phase-6-postman-collection.md) — exercising the API after a repair
- [Phase 6 API Examples](../operations/phase-6-api-examples.md) — expected responses, including every refusal
