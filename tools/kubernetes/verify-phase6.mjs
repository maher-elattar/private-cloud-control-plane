/**
 * Runtime verification for the Kubernetes and GitOps deployment.
 *
 * This does not check that manifests are well formed — `render-check.mjs` does that, and a
 * manifest that renders is not a deployment that works. Everything here is an assertion about a
 * cluster that is actually running: that Argo CD reconciles what the repository says, that the
 * header route reaches the environment it claims to, that a healthy green environment is promoted
 * and a degraded one is not, and that a change made by hand is undone.
 *
 * The drills that change something all change it the same way a person would: by publishing to
 * the GitOps repository and letting the control loop act. A drill that reached past Argo CD with
 * `kubectl patch` would be fighting the self-healing it is supposed to be proving.
 *
 * Usage:
 *   node tools/kubernetes/verify-phase6.mjs                  # every check
 *   node tools/kubernetes/verify-phase6.mjs --only=routing   # one named check
 *   node tools/kubernetes/verify-phase6.mjs --skip-drills    # observation only, no rollouts
 *
 * Evidence is written to `docs/verification/evidence/phase6-runtime.json`.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ARGOCD_NAMESPACE, applicationState, listApplications } from './argocd.mjs';
import { KUBE_CONTEXT, kubectl, kubectlGetJson, waitFor } from './kubectl.mjs';
import { activeTargets, instantQuery, scalarQuery } from './prometheus.mjs';
import { publishGitOpsRepository } from './publish-gitops-repo.mjs';
import {
  listAnalysisRuns,
  readRollout,
  serviceEndpoints,
  serviceSelectedHash,
} from './rollout.mjs';

const NAMESPACE = 'private-cloud';
const MANIFEST_ROOT = resolve('deploy/kubernetes');
const EVIDENCE_PATH = resolve('docs/verification/evidence/phase6-runtime.json');
/** The rollout every promotion drill exercises: the only one with north-south traffic. */
const SUBJECT_ROLLOUT = 'control-api';
const SUBJECT_PREVIEW_SERVICE = 'control-api-preview';
/**
 * Image tag the progress-deadline drill deploys.
 *
 * Deliberately unbuildable and unpullable: the drill needs a green environment whose pods never
 * become ready, and an image that does not exist anywhere produces exactly that without any
 * cooperation from the application.
 */
const UNRESOLVABLE_IMAGE_TAG = 'phase6-does-not-exist';
/** Annotation Argo CD stamps on every object it applied, used to detect what came from Git. */
const ARGOCD_TRACKING_ANNOTATION = 'argocd.argoproj.io/tracking-id';
/** Credentials the cluster must generate for itself, and the custom resource that owns each. */
const OPERATOR_GENERATED_SECRETS = {
  'control-plane-postgres-app': 'Cluster/control-plane-postgres',
  'control-plane': 'KafkaUser/control-plane',
  'kafka-connect': 'KafkaUser/kafka-connect',
  'control-plane-kafka-cluster-ca-cert': 'Kafka/control-plane-kafka',
};
/** Matches the subject rollout's image line, the one field the drills rewrite. */
const SUBJECT_IMAGE_PATTERN = /image: private-cloud\/control-api:[\w.-]+/;
/**
 * Image the promotion drills deploy.
 *
 * Fixed, not alternating. The unique pod-template annotation is what makes each drill a forward
 * promotion, so the drill no longer has to depend on which of two tags happens to be live — a
 * dependency that turned "the restore has not landed yet" into "the drill cannot find its own edit".
 */
const DRILL_IMAGE_TAG = 'phase6-green';
/**
 * Annotation the drills stamp onto the subject rollout's pod template.
 *
 * Its only job is to be different every time, so that each drill is a forward promotion rather than
 * a rollback the controller is entitled to complete without analysis.
 */
const DRILL_REVISION_ANNOTATION = 'private-cloud.io/drill-revision';
/** The only Secret the repository is allowed to apply, and the non-credential keys it may hold. */
const REPOSITORY_SECRET = { name: 'control-plane-keda', keys: ['sasl', 'tls', 'username'] };

const argv = process.argv.slice(2);
const only = argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length);
const skipDrills = argv.includes('--skip-drills');

const evidence = {
  startedAt: new Date().toISOString(),
  context: KUBE_CONTEXT,
  status: 'running',
  checks: {},
};
const failures = [];

/**
 * Runs one named check, recording its outcome rather than aborting the suite.
 *
 * WHY not fail fast: a run that stops at the first problem hides every later one, and the later
 * ones are usually what explains the first.
 *
 * @param {string} name Check identifier, also the evidence key.
 * @param {() => Promise<Record<string, unknown>>} body Check body; its return value is evidence.
 * @returns {Promise<void>} Resolves once the outcome is recorded.
 */
async function check(name, body) {
  if (only && only !== name) return;
  const startedAt = Date.now();
  process.stdout.write(`▶ ${name}\n`);
  try {
    const detail = await body();
    evidence.checks[name] = { status: 'passed', durationMs: Date.now() - startedAt, ...detail };
    process.stdout.write(`  ✓ ${name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.checks[name] = {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: message,
    };
    failures.push(`${name}: ${message}`);
    process.stdout.write(`  ✗ ${name}: ${message}\n`);
  }
}

/** Asserts a condition, with a message that says what was expected and what was found. */
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Publishes an alternate manifest tree, runs a body against it, and always restores the original.
 *
 * The restore is in a `finally` on purpose. A drill that leaves a degraded image or a poisoned
 * load generator behind turns one failed run into a cluster nobody can trust afterwards.
 *
 * @param {(root: string) => Promise<void>} mutate Applies the drill's change to a copied tree.
 * @param {() => Promise<Record<string, unknown>>} body Assertions to run while it is published.
 * @returns {Promise<Record<string, unknown>>} Whatever `body` returned.
 */
async function withPublishedMutation(mutate, body) {
  const workspace = await mkdtemp(join(tmpdir(), 'phase6-drill-'));
  try {
    await cp(MANIFEST_ROOT, workspace, { recursive: true });
    await mutate(workspace);
    await publishGitOpsRepository({ root: workspace, refresh: true });
    return await body();
  } finally {
    await publishGitOpsRepository({ refresh: true });
    // Wait for the restore to finish rolling out, not merely to be published. A drill that hands
    // back an unsettled cluster makes the *next* drill's first observation a reading of the
    // previous drill's tail, and the two become impossible to tell apart in the evidence.
    await settleSubjectRollout(await declaredSubjectImage());
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * Reads the image the repository currently declares for the subject rollout.
 *
 * @returns {Promise<string>} The declared image reference.
 */
async function declaredSubjectImage() {
  const content = await readFile(join(MANIFEST_ROOT, 'applications', 'control-api.yaml'), 'utf8');
  const match = SUBJECT_IMAGE_PATTERN.exec(content);
  expect(match, 'the repository declares no control-api image');
  return match[0].slice('image: '.length);
}

/**
 * Waits until the subject rollout is finished moving *and* is running what the repository declares.
 *
 * Both halves are necessary. Healthy with equal stable and current hashes means the rollout is not
 * between environments; matching the declared image means the restore has actually arrived. Without
 * the second, this returns immediately on the drill's own settled state, and the next drill starts
 * from the previous drill's tail.
 *
 * @param {string} expectedImage The image the repository declares.
 * @param {number} [timeoutMs] Deadline.
 * @returns {Promise<Awaited<ReturnType<typeof readRollout>>>} The settled rollout.
 */
function settleSubjectRollout(expectedImage, timeoutMs = 900_000) {
  return waitFor(
    `the ${SUBJECT_ROLLOUT} rollout to settle on ${expectedImage}`,
    async () => {
      const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
      const settled =
        rollout.phase === 'Healthy' &&
        rollout.image === expectedImage &&
        rollout.stableHash !== undefined &&
        rollout.stableHash === rollout.currentHash;
      return settled ? rollout : undefined;
    },
    { timeoutMs, intervalMs: 10_000 },
  );
}

/**
 * Waits until every control-plane application reports Synced and Healthy.
 *
 * @param {number} timeoutMs Deadline.
 * @returns {Promise<Array<{ name: string, sync: string, health: string }>>} Final application state.
 */
async function waitForApplications(timeoutMs = 900_000) {
  return waitFor(
    'every control-plane Argo CD application to be Synced and Healthy',
    async () => {
      const states = (await listApplications()).map(applicationState);
      if (states.length === 0) return undefined;
      return states.every((state) => state.sync === 'Synced' && state.health === 'Healthy')
        ? states
        : undefined;
    },
    { timeoutMs, intervalMs: 10_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------------------------

await check('environment', async () => {
  const nodes = await kubectlGetJson(['nodes']);
  const argocdServer = await kubectlGetJson([
    'deployment',
    'argocd-server',
    '-n',
    ARGOCD_NAMESPACE,
  ]);
  const rolloutsController = await kubectlGetJson([
    'deployment',
    'argo-rollouts',
    '-n',
    'argo-rollouts',
  ]);
  expect(nodes?.items?.length > 0, 'the cluster reports no nodes');
  expect(argocdServer, 'Argo CD is not installed');
  expect(rolloutsController, 'the Argo Rollouts controller is not installed');
  return {
    nodes: nodes.items.map((node) => ({
      name: node.metadata.name,
      version: node.status.nodeInfo.kubeletVersion,
      ready: node.status.conditions.find((condition) => condition.type === 'Ready')?.status,
    })),
    argoCdImage: argocdServer.spec.template.spec.containers[0].image,
    argoRolloutsImage: rolloutsController.spec.template.spec.containers[0].image,
  };
});

// ---------------------------------------------------------------------------------------------
// 2. GitOps reconciliation
// ---------------------------------------------------------------------------------------------

await check('gitops-reconciliation', async () => {
  const applications = await waitForApplications();
  const project = await kubectlGetJson(['appproject', 'private-cloud', '-n', ARGOCD_NAMESPACE]);
  expect(project, 'the private-cloud AppProject does not exist');

  // Automated sync with pruning and self-healing is the property the whole deployment rests on;
  // an application that quietly lost it would drift without anything reporting drift.
  const applicationObjects = await kubectlGetJson([
    'applications',
    '-n',
    ARGOCD_NAMESPACE,
    '-l',
    'app.kubernetes.io/part-of=private-cloud-control-plane',
  ]);
  for (const application of applicationObjects.items) {
    const automated = application.spec?.syncPolicy?.automated;
    expect(automated, `${application.metadata.name} has no automated sync policy`);
    expect(automated.prune === true, `${application.metadata.name} does not prune`);
    expect(automated.selfHeal === true, `${application.metadata.name} does not self-heal`);
  }

  return {
    applications,
    projectDestinations: project.spec.destinations.map((destination) => destination.namespace),
    projectSourceRepositories: project.spec.sourceRepos,
  };
});

await check('sync-waves', async () => {
  // Every application declares the wave the roadmap assigns it. The ordering is what keeps a
  // custom resource from being applied before the operator that defines its kind.
  const expected = {
    'control-plane-foundation': '0',
    'control-plane-platform': '1',
    'control-plane-data': '2',
    'control-plane-observability': '3',
    'control-plane-applications': '4',
    'control-plane-dashboards': '5',
  };
  const applications = await kubectlGetJson([
    'applications',
    '-n',
    ARGOCD_NAMESPACE,
    '-l',
    'app.kubernetes.io/part-of=private-cloud-control-plane',
  ]);
  const observed = {};
  for (const application of applications.items) {
    const wave = application.metadata.annotations?.['argocd.argoproj.io/sync-wave'];
    if (wave !== undefined) observed[application.metadata.name] = wave;
  }
  for (const [name, wave] of Object.entries(expected)) {
    expect(
      observed[name] === wave,
      `${name} is in wave ${observed[name] ?? 'none'}, expected ${wave}`,
    );
  }
  return { waves: observed };
});

// ---------------------------------------------------------------------------------------------
// 3. Workload shape
// ---------------------------------------------------------------------------------------------

await check('rollouts-not-deployments', async () => {
  const services = ['control-api', 'provisioning-orchestrator', 'proxmox-provider', 'reconciler'];
  const detail = {};
  for (const service of services) {
    const deployment = await kubectlGetJson(['deployment', service, '-n', NAMESPACE]);
    expect(
      !deployment,
      `${service} is deployed as a Deployment; the control plane's services must be Rollouts`,
    );
    const rollout = await readRollout(NAMESPACE, service);
    expect(
      rollout.phase === 'Healthy',
      `${service} rollout is ${rollout.phase}: ${rollout.message ?? ''}`,
    );
    expect(
      rollout.available >= 2,
      `${service} has ${rollout.available} available replicas, expected at least 2`,
    );
    detail[service] = rollout;
  }
  return { rollouts: detail };
});

await check('health-checks-and-boundaries', async () => {
  const rollouts = await kubectlGetJson(['rollouts', '-n', NAMESPACE]);
  const findings = {};
  for (const rollout of rollouts.items) {
    const container = rollout.spec.template.spec.containers[0];
    const name = rollout.metadata.name;
    expect(container.livenessProbe, `${name} has no liveness probe`);
    expect(container.readinessProbe, `${name} has no readiness probe`);
    expect(container.startupProbe, `${name} has no startup probe`);
    expect(container.resources?.requests?.cpu, `${name} has no CPU request`);
    expect(container.resources?.limits?.memory, `${name} has no memory limit`);
    expect(
      container.securityContext?.allowPrivilegeEscalation === false,
      `${name} allows privilege escalation`,
    );
    expect(
      container.securityContext?.readOnlyRootFilesystem === true,
      `${name} has a writable root filesystem`,
    );
    expect(
      rollout.spec.template.spec.topologySpreadConstraints?.length >= 1,
      `${name} declares no topology spread constraint`,
    );
    findings[name] = {
      probes: ['startup', 'liveness', 'readiness'],
      requests: container.resources.requests,
      limits: container.resources.limits,
      spreadTopologies: rollout.spec.template.spec.topologySpreadConstraints.map(
        (constraint) => constraint.topologyKey,
      ),
    };
  }

  const budgets = await kubectlGetJson(['poddisruptionbudgets', '-n', NAMESPACE]);
  const policies = await kubectlGetJson(['networkpolicies', '-n', NAMESPACE]);
  expect(
    (policies?.items ?? []).some((policy) => policy.metadata.name === 'default-deny'),
    'the namespace has no default-deny NetworkPolicy',
  );
  return {
    workloads: findings,
    podDisruptionBudgets: (budgets?.items ?? []).map((budget) => budget.metadata.name),
    networkPolicies: (policies?.items ?? []).map((policy) => policy.metadata.name),
  };
});

// ---------------------------------------------------------------------------------------------
// 4. Telemetry pipeline
// ---------------------------------------------------------------------------------------------

await check('metrics-pipeline', async () => {
  // The promotion gate is only as real as the series it reads. This proves three things in order:
  // that Prometheus found the pods, that it is scraping them, and that the exact series the
  // AnalysisTemplates name exists with the dimensions they filter on.
  const targets = await waitFor(
    'Prometheus to report healthy control-plane scrape targets',
    async () => {
      const found = await activeTargets(NAMESPACE);
      const healthy = found.filter((target) => target.health === 'up');
      return healthy.length >= 8 ? healthy : undefined;
    },
    { timeoutMs: 300_000, intervalMs: 10_000 },
  );

  const previewSeries = await scalarQuery(
    `count(group by (service) (http_server_request_duration_count{namespace="${NAMESPACE}", service=~".*-preview"}))`,
  );
  expect(
    previewSeries >= 4,
    `only ${previewSeries ?? 0} preview services publish the request histogram; the promotion gate would read no data`,
  );

  const statusCodes = await instantQuery(
    `count by (http_response_status_code) (http_server_request_duration_count{namespace="${NAMESPACE}"})`,
  );
  expect(statusCodes.length > 0, 'no request histogram carries an http_response_status_code label');

  // SAFE-034: addresses are never metric labels. The scrape path has no Collector in front of it,
  // so this is the assertion that the SDK view is doing its job in the deployed image.
  const forbidden = await instantQuery(
    `count(group by (server_address, network_peer_address) (http_server_request_duration_count{namespace="${NAMESPACE}"}))`,
  );
  const leaked = forbidden.filter(
    (sample) => sample.metric.server_address || sample.metric.network_peer_address,
  );
  expect(
    leaked.length === 0,
    `the request histogram carries address labels: ${JSON.stringify(leaked)}`,
  );

  return {
    scrapeTargets: targets.map((target) => ({ service: target.service, pod: target.pod })),
    previewServicesPublishing: previewSeries,
    statusCodes: statusCodes.map((sample) => sample.metric.http_response_status_code),
  };
});

// ---------------------------------------------------------------------------------------------
// 5. Header-based routing
// ---------------------------------------------------------------------------------------------

await check('header-routing', async () => {
  const route = await kubectlGetJson(['httproute', 'control-api', '-n', NAMESPACE]);
  expect(route, 'the control-api HTTPRoute does not exist');

  const accepted = (route.status?.parents ?? []).some((parent) =>
    (parent.conditions ?? []).some(
      (condition) => condition.type === 'Accepted' && condition.status === 'True',
    ),
  );
  expect(accepted, 'the Gateway has not accepted the control-api HTTPRoute');

  const headerRule = route.spec.rules.find((rule) =>
    (rule.matches ?? []).some((match) =>
      (match.headers ?? []).some(
        (header) => header.name === 'X-Canary' && header.value === 'green',
      ),
    ),
  );
  expect(headerRule, 'no rule matches the X-Canary: green header');
  expect(
    headerRule.backendRefs[0].name === SUBJECT_PREVIEW_SERVICE,
    `the X-Canary rule points at ${headerRule.backendRefs[0].name}, not the preview Service`,
  );

  const defaultRule = route.spec.rules.find((rule) => rule !== headerRule);
  expect(
    defaultRule.backendRefs[0].name === SUBJECT_ROLLOUT,
    `the default rule points at ${defaultRule.backendRefs[0].name}, not the active Service`,
  );

  // The declaration is one thing; where requests actually land is another. The two load generators
  // differ only in the header, so a comparison of what each environment received is a direct
  // measurement of whether the header rule is doing anything at all.
  const before = {
    preview:
      (await scalarQuery(
        `sum(http_server_request_duration_count{namespace="${NAMESPACE}", service="${SUBJECT_PREVIEW_SERVICE}"})`,
      )) ?? 0,
  };
  const rate = await scalarQuery(
    `sum(rate(http_server_request_duration_count{namespace="${NAMESPACE}", service="${SUBJECT_PREVIEW_SERVICE}"}[2m]))`,
  );
  expect(
    (rate ?? 0) > 0,
    'the preview environment is receiving no traffic, so header routing cannot be observed',
  );

  return {
    routeAccepted: accepted,
    headerRule: { header: 'X-Canary: green', backend: headerRule.backendRefs[0].name },
    defaultRule: { backend: defaultRule.backendRefs[0].name },
    previewRequestRatePerSecond: Number(rate.toFixed(3)),
    previewRequestsObserved: before.preview,
  };
});

/** Manifest published by the degradation drill. Kept beside the drill that uses it. */
const DEGRADE_MANIFEST = `# Drill-only. Published by \`tools/kubernetes/verify-phase6.mjs\` and removed when the drill ends.
#
# Sends a majority of its requests to a path the API does not serve, with the header that reaches
# the green environment. The result is a green HTTP 200 rate below the 90% promotion gate, caused
# by traffic rather than by a deliberately broken build — which is what makes it a test of the
# gate rather than a test of the image.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rollout-load-degrade
  namespace: private-cloud
  labels: { app.kubernetes.io/name: rollout-load, app.kubernetes.io/part-of: private-cloud-control-plane }
  annotations: { argocd.argoproj.io/sync-wave: '4' }
spec:
  replicas: 3
  selector:
    matchLabels: { app.kubernetes.io/name: rollout-load, private-cloud.io/load-target: degrade }
  template:
    metadata:
      labels:
        app.kubernetes.io/name: rollout-load
        app.kubernetes.io/part-of: private-cloud-control-plane
        private-cloud.io/load-target: degrade
    spec:
      serviceAccountName: control-plane-jobs
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: curl
          image: curlimages/curl:8.16.0
          imagePullPolicy: IfNotPresent
          command: ['/bin/sh', '/etc/rollout-load/generate.sh']
          env:
            - { name: GATEWAY, value: traefik.traefik.svc.cluster.local }
            - { name: ROUTE_HOST, value: control-plane.test }
            - { name: CANARY, value: green }
            - { name: PATHS, value: /health/does-not-exist /health/also-missing /health/ready }
            - { name: INTERVAL, value: '1' }
          volumeMounts:
            - { name: script, mountPath: /etc/rollout-load, readOnly: true }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { cpu: 200m, memory: 64Mi }
      volumes:
        - name: script
          configMap: { name: rollout-load, defaultMode: 0555 }
`;

// ---------------------------------------------------------------------------------------------
// 6. Promotion drills
// ---------------------------------------------------------------------------------------------

/**
 * Gives the subject rollout a pod template Argo Rollouts has never seen.
 *
 * WHY not simply flip the image tag between two values: flipping back to a tag that is still the
 * previous ReplicaSet's is a *rollback within `scaleDownDelay`*, and Argo Rollouts completes a
 * rollback immediately without running analysis. That is correct behaviour — a fast rollback should
 * not have to re-earn a gate it already passed — and it makes an alternating tag useless as a
 * drill, because every second run silently skips the thing under test.
 *
 * A unique annotation on the pod template makes every drill a genuine forward promotion, whatever
 * image it deploys.
 *
 * @param {string} root Copied manifest tree.
 * @param {{ tag: string, id: string }} revision Image tag to deploy, and a value unique to this run.
 * @returns {Promise<void>} Resolves once the file is rewritten.
 */
async function applyDrillRevision(root, revision) {
  const path = join(root, 'applications', 'control-api.yaml');
  const content = await readFile(path, 'utf8');

  expect(
    SUBJECT_IMAGE_PATTERN.test(content),
    'the drill did not find the control-api image line to rewrite',
  );
  const retagged = content.replace(
    SUBJECT_IMAGE_PATTERN,
    `image: private-cloud/control-api:${revision.tag}`,
  );

  const templateLabels = '  template:\n    metadata:\n      labels:\n';
  expect(
    retagged.includes(templateLabels),
    'the drill did not find the pod template metadata block to annotate',
  );
  const annotated = retagged.replace(
    templateLabels,
    `  template:\n    metadata:\n      annotations:\n` +
      `        ${DRILL_REVISION_ANNOTATION}: '${revision.id}'\n` +
      `      labels:\n`,
  );
  await writeFile(path, annotated);
}

/**
 * Waits for a rollout to reach one of the given phases.
 *
 * @param {string[]} phases Acceptable phases.
 * @param {number} timeoutMs Deadline.
 * @returns {Promise<Awaited<ReturnType<typeof readRollout>>>} The rollout once it settles.
 */
async function waitForRolloutPhase(phases, timeoutMs) {
  return waitFor(
    `the ${SUBJECT_ROLLOUT} rollout to reach ${phases.join(' or ')}`,
    async () => {
      const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
      return phases.includes(rollout.phase) ? rollout : undefined;
    },
    { timeoutMs, intervalMs: 10_000 },
  );
}

if (!skipDrills) {
  await check('promotion-passes-on-healthy-green', async () => {
    const before = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
    const drillId = `promotion-${Date.now()}`;

    return withPublishedMutation(
      (root) => applyDrillRevision(root, { tag: DRILL_IMAGE_TAG, id: drillId }),
      async () => {
        // Progressing first: proves the change was actually picked up, so a rollout that never
        // started is not mistaken for one that finished instantly.
        await waitFor(
          'the rollout to pick up the new image',
          async () => {
            const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
            return rollout.image?.endsWith(`:${DRILL_IMAGE_TAG}`) ? rollout : undefined;
          },
          { timeoutMs: 420_000, intervalMs: 10_000 },
        );

        const settled = await waitForRolloutPhase(['Healthy', 'Degraded'], 900_000);
        const runs = await listAnalysisRuns(NAMESPACE, SUBJECT_ROLLOUT);
        const latest = runs[0];

        expect(
          settled.phase === 'Healthy',
          `the rollout ended ${settled.phase}: ${settled.message ?? 'no message'}`,
        );
        expect(latest, 'the promotion produced no AnalysisRun; the gate did not run');
        expect(
          latest.phase === 'Successful',
          `the latest AnalysisRun is ${latest.phase}: ${JSON.stringify(latest.metrics)}`,
        );

        const activeHash = await serviceSelectedHash(NAMESPACE, SUBJECT_ROLLOUT);
        expect(
          activeHash === settled.currentHash,
          'the active Service was not switched to the promoted ReplicaSet',
        );

        return {
          promotedTo: DRILL_IMAGE_TAG,
          rolloutPhase: settled.phase,
          analysisRun: latest,
          analysisMetrics: latest.metrics,
          activeServiceSelectsPromotedRevision: true,
        };
      },
    );
  });

  await check('analysis-aborts-and-self-heals-on-degraded-green', async () => {
    const before = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
    const stableBefore = before.stableHash;
    const drillId = `degraded-${Date.now()}`;

    return withPublishedMutation(
      async (root) => {
        await applyDrillRevision(root, { tag: DRILL_IMAGE_TAG, id: drillId });
        // Poison the green environment's traffic rather than its image. WHY: the assertion under
        // test is that the gate reads the *green* environment's HTTP results and refuses a
        // promotion below 90% success. Sending a majority of green requests to a path that does
        // not exist produces exactly that, measured through the real header route, without
        // shipping a deliberately broken build.
        const path = join(root, 'applications', 'load-generator-degrade.yaml');
        await writeFile(path, DEGRADE_MANIFEST);
        const kustomizationPath = join(root, 'applications', 'kustomization.yaml');
        const kustomization = await readFile(kustomizationPath, 'utf8');
        await writeFile(
          kustomizationPath,
          kustomization.replace(
            '  - load-generator.yaml\n',
            '  - load-generator.yaml\n  - load-generator-degrade.yaml\n',
          ),
        );
      },
      async () => {
        await waitFor(
          'the rollout to pick up the drill image',
          async () => {
            const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
            return rollout.image?.endsWith(`:${DRILL_IMAGE_TAG}`) ? rollout : undefined;
          },
          { timeoutMs: 420_000, intervalMs: 10_000 },
        );

        const settled = await waitFor(
          'the rollout to abort',
          async () => {
            const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
            return rollout.abortedAt || rollout.phase === 'Degraded' ? rollout : undefined;
          },
          { timeoutMs: 900_000, intervalMs: 10_000 },
        );

        const runs = await listAnalysisRuns(NAMESPACE, SUBJECT_ROLLOUT);
        const failed = runs.find((run) => run.phase === 'Failed' || run.phase === 'Error');
        expect(
          failed,
          `no AnalysisRun failed; runs were ${runs.map((run) => run.phase).join(', ')}`,
        );

        const successRateMetric = failed.metrics.find(
          (metric) => metric.name === 'green-http-200-rate',
        );
        expect(
          successRateMetric &&
            (successRateMetric.phase === 'Failed' || successRateMetric.phase === 'Error'),
          `the failing run did not fail on the success rate: ${JSON.stringify(failed.metrics)}`,
        );

        // Self-healing, stated precisely: the active Service still selects the ReplicaSet that was
        // stable before the drill. No production traffic ever reached the degraded environment.
        const activeHash = await serviceSelectedHash(NAMESPACE, SUBJECT_ROLLOUT);
        expect(
          activeHash === stableBefore,
          `the active Service moved to ${activeHash} despite the failed analysis (was ${stableBefore})`,
        );

        return {
          rolloutPhase: settled.phase,
          abortedAt: settled.abortedAt,
          failedAnalysisRun: failed,
          activeServiceStillOnPreviousRevision: activeHash,
        };
      },
    );
  });

  await check('progress-deadline-aborts-an-unready-green', async () => {
    // The analysis gate can only judge a green environment that exists. This drill removes that
    // premise: green pods that never become ready never join the preview Service, so no analysis
    // ever runs and no metric ever fails. The rollout must still abort on its own, and it must
    // still leave the active Service where it was. That is what `progressDeadlineAbort` buys, and
    // it is the failure mode a Deployment would have papered over by simply waiting forever.
    const before = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
    const stableBefore = before.stableHash;
    const activeBefore = await serviceSelectedHash(NAMESPACE, SUBJECT_ROLLOUT);

    return withPublishedMutation(
      (root) =>
        applyDrillRevision(root, { tag: UNRESOLVABLE_IMAGE_TAG, id: `deadline-${Date.now()}` }),
      async () => {
        await waitFor(
          'the rollout to pick up the unresolvable image',
          async () => {
            const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
            return rollout.image?.endsWith(`:${UNRESOLVABLE_IMAGE_TAG}`) ? rollout : undefined;
          },
          { timeoutMs: 420_000, intervalMs: 10_000 },
        );

        // Deliberately longer than `progressDeadlineSeconds` (420s) plus the time Argo CD needs to
        // deliver the change, because the abort cannot happen before the deadline elapses.
        const settled = await waitFor(
          'the rollout to abort on its progress deadline',
          async () => {
            const rollout = await readRollout(NAMESPACE, SUBJECT_ROLLOUT);
            return rollout.abortedAt || rollout.phase === 'Degraded' ? rollout : undefined;
          },
          { timeoutMs: 900_000, intervalMs: 15_000 },
        );

        expect(
          settled.abortedAt !== undefined,
          `the rollout reached ${settled.phase} without aborting: ${settled.message ?? 'no message'}`,
        );

        const activeAfter = await serviceSelectedHash(NAMESPACE, SUBJECT_ROLLOUT);
        expect(
          activeAfter === activeBefore,
          `the active Service moved from ${activeBefore} to ${activeAfter} behind an unready green`,
        );
        expect(
          activeAfter === stableBefore,
          `the active Service no longer selects the stable revision ${stableBefore}`,
        );

        const previewAddresses = await serviceEndpoints(NAMESPACE, SUBJECT_PREVIEW_SERVICE);
        return {
          rolloutPhase: settled.phase,
          rolloutMessage: settled.message,
          abortedAt: settled.abortedAt,
          readyPreviewEndpoints: previewAddresses.length,
          activeServiceUnchanged: activeAfter,
        };
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// 7. Argo CD self-healing
// ---------------------------------------------------------------------------------------------

if (!skipDrills) {
  await check('argocd-reverts-manual-drift', async () => {
    // Two kinds of drift, because Argo CD answers them by different mechanisms: a *changed* field
    // is corrected by a sync, and a *deleted* object is recreated by one. Both are what "the
    // repository is the only way to change the cluster" has to mean in practice — otherwise the
    // manifests in `deploy/kubernetes` describe an intention rather than a state.
    // The *declared* count, not the observed one. `status.replicas` counts blue and green together
    // during a promotion, so asserting against it would wait for a number the repository never asks
    // for.
    const desiredReplicas = (await readRollout(NAMESPACE, SUBJECT_ROLLOUT)).specReplicas;
    expect(
      typeof desiredReplicas === 'number',
      'the subject rollout declares no replica count to drift from',
    );
    const driftedReplicas = desiredReplicas + 2;

    try {
      await kubectl([
        'patch',
        'rollout',
        SUBJECT_ROLLOUT,
        '-n',
        NAMESPACE,
        '--type=merge',
        '-p',
        JSON.stringify({ spec: { replicas: driftedReplicas } }),
      ]);

      const restoredReplicas = await waitFor(
        `Argo CD to revert ${SUBJECT_ROLLOUT} to ${desiredReplicas} replicas`,
        async () => {
          const rollout = await kubectlGetJson(['rollout', SUBJECT_ROLLOUT, '-n', NAMESPACE]);
          const spec = rollout?.spec?.replicas;
          return spec === desiredReplicas ? spec : undefined;
        },
        { timeoutMs: 420_000, intervalMs: 5_000 },
      );

      await kubectl(['delete', 'service', SUBJECT_PREVIEW_SERVICE, '-n', NAMESPACE]);
      const recreated = await waitFor(
        `Argo CD to recreate the ${SUBJECT_PREVIEW_SERVICE} Service`,
        async () => {
          const service = await kubectlGetJson([
            'service',
            SUBJECT_PREVIEW_SERVICE,
            '-n',
            NAMESPACE,
          ]);
          return service?.metadata?.uid;
        },
        { timeoutMs: 420_000, intervalMs: 5_000 },
      );

      const applications = await waitForApplications(600_000);
      return {
        changedField: {
          resource: `Rollout/${SUBJECT_ROLLOUT}`,
          field: 'spec.replicas',
          driftedTo: driftedReplicas,
          revertedTo: restoredReplicas,
        },
        deletedObject: {
          resource: `Service/${SUBJECT_PREVIEW_SERVICE}`,
          recreatedWithUid: recreated,
        },
        applications,
      };
    } finally {
      // If self-healing is what is broken, the drift is still sitting in the cluster. A hard
      // refresh is the least intrusive way to give the reconciler another chance before the run
      // ends, and it leaves a working cluster behind either way.
      await publishGitOpsRepository({ refresh: true });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// 8. Secret handling
// ---------------------------------------------------------------------------------------------

await check('secrets-are-generated-not-committed', async () => {
  // SAFE-036 as a runtime assertion rather than a promise. Every credential this deployment uses
  // must have been produced inside the cluster by the operator that owns it, so that rotating one
  // is an operator concern and the repository never holds a value it could leak.
  //
  // Argo CD stamps `argocd.argoproj.io/tracking-id` onto everything it applied, which makes
  // "came from the repository" a property the cluster can be asked about directly rather than a
  // property of a file scan that a generator could have slipped past.
  const secrets = await kubectlGetJson(['secrets', '-n', NAMESPACE]);
  const items = secrets?.items ?? [];
  const describe = (secret) => ({
    owners: (secret.metadata.ownerReferences ?? []).map(
      (reference) => `${reference.kind}/${reference.name}`,
    ),
    keys: Object.keys(secret.data ?? {}).sort(),
    trackedByArgo: secret.metadata.annotations?.[ARGOCD_TRACKING_ANNOTATION] !== undefined,
  });
  const byName = Object.fromEntries(
    items.map((secret) => [secret.metadata.name, describe(secret)]),
  );

  for (const [name, expectedOwner] of Object.entries(OPERATOR_GENERATED_SECRETS)) {
    const secret = byName[name];
    expect(secret, `the ${name} Secret does not exist; its operator never generated it`);
    expect(
      secret.owners.includes(expectedOwner),
      `the ${name} Secret is owned by ${secret.owners.join(', ') || 'nothing'}, expected ${expectedOwner}`,
    );
    expect(
      !secret.trackedByArgo,
      `the ${name} Secret carries Argo CD's tracking annotation, so its value came from Git`,
    );
  }

  // Exactly one Secret is allowed to come from the repository, and only because it holds no
  // credential: KEDA's Kafka scaler needs the mechanism name, the TLS switch, and the principal
  // to look the real credential up with. The password beside them is read from the Strimzi Secret.
  const fromRepository = items
    .filter((secret) => byName[secret.metadata.name].trackedByArgo)
    .map((secret) => secret.metadata.name)
    .sort();
  expect(
    fromRepository.length === 1 && fromRepository[0] === REPOSITORY_SECRET.name,
    `Secrets applied from the repository: ${fromRepository.join(', ') || 'none'}; only ${REPOSITORY_SECRET.name} may be`,
  );
  const declared = byName[REPOSITORY_SECRET.name].keys;
  expect(
    declared.length === REPOSITORY_SECRET.keys.length &&
      declared.every((key, index) => key === REPOSITORY_SECRET.keys[index]),
    `${REPOSITORY_SECRET.name} holds ${declared.join(', ')}; only ${REPOSITORY_SECRET.keys.join(', ')} are non-credential switches`,
  );

  return {
    secretsInNamespace: items.length,
    operatorGenerated: Object.fromEntries(
      Object.keys(OPERATOR_GENERATED_SECRETS).map((name) => [name, byName[name].owners]),
    ),
    appliedFromRepository: { name: REPOSITORY_SECRET.name, keys: declared },
  };
});

// ---------------------------------------------------------------------------------------------
// Evidence and exit
// ---------------------------------------------------------------------------------------------

evidence.finishedAt = new Date().toISOString();
evidence.status = failures.length === 0 ? 'passed' : 'failed';
evidence.failures = failures;
evidence.skippedDrills = skipDrills;
if (only) evidence.only = only;

await mkdir(resolve('docs/verification/evidence'), { recursive: true });
await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, undefined, 2)}\n`);

const names = Object.keys(evidence.checks);
process.stdout.write(`\n${'-'.repeat(94)}\n`);
for (const name of names) {
  const outcome = evidence.checks[name];
  process.stdout.write(
    `${outcome.status === 'passed' ? '✓' : '✗'} ${name.padEnd(48)} ${((outcome.durationMs ?? 0) / 1000).toFixed(1)}s\n`,
  );
}
process.stdout.write(`${'-'.repeat(94)}\n`);
process.stdout.write(
  `${names.length - failures.length}/${names.length} checks passed. Evidence: ${EVIDENCE_PATH}\n`,
);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
  process.exitCode = 1;
}
