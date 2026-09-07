/**
 * Static gate for the Kubernetes manifests.
 *
 * Three questions, asked in order, because each one is only meaningful if the previous one passed:
 *
 *   1. **Does it render?** Every Argo CD source directory is a kustomize root, and a root that
 *      does not build is a synchronisation failure the cluster reports minutes later as
 *      `ComparisonError`.
 *   2. **Does the API server accept it?** A server-side dry run validates every field against the
 *      real schemas, including the operators' custom resources — which is the only way to catch a
 *      `storageClassName` that should have been `storageClass`, or a `metadataVersion` the
 *      installed Strimzi does not know.
 *   3. **Does it obey the rules this deployment sets for itself?** Resource bounds, probes,
 *      `Rollout` rather than `Deployment` for anything that takes traffic, a hardened pod security
 *      context, a sync wave on everything, no floating image tags, and no credential in Git.
 *
 * The third question is the one no upstream tool asks. Its rules live in `POLICIES` below, each
 * with the reason it exists, because a policy whose rationale is not written down is a policy the
 * next person deletes when it becomes inconvenient.
 *
 * Usage:
 *   node tools/kubernetes/render-check.mjs                # render, dry run, and policies
 *   node tools/kubernetes/render-check.mjs --offline      # skip the server-side dry run
 */
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { kubectl } from './kubectl.mjs';

const MANIFEST_ROOT = resolve('deploy/kubernetes');
/** Directories Argo CD points an Application at, plus the bootstrap tree applied before it. */
const RENDER_ROOTS = [
  'bootstrap',
  'gitops-repo',
  'namespace',
  'platform',
  'data',
  'observability',
  'applications',
  'dashboards',
  'argocd',
];
/** Kinds whose pods run indefinitely, and therefore must be probed. */
const LONG_RUNNING_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Rollout']);
/** Every kind that carries a pod template, and where in the object that template lives. */
const POD_TEMPLATE_PATHS = {
  Deployment: ['spec', 'template'],
  StatefulSet: ['spec', 'template'],
  DaemonSet: ['spec', 'template'],
  Rollout: ['spec', 'template'],
  Job: ['spec', 'template'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template'],
};
/** Services that take traffic and must therefore be deployed blue-green, never as a Deployment. */
const ROLLOUT_REQUIRED = new Set([
  'control-api',
  'provisioning-orchestrator',
  'proxmox-provider',
  'reconciler',
]);
/** The one Secret the repository may apply, and the non-credential keys it may hold. */
const REPOSITORY_SECRET = { name: 'control-plane-keda', keys: ['sasl', 'tls', 'username'] };
/**
 * Directories holding upstream artifacts rather than this project's manifests.
 *
 * `bootstrap` vendors the Argo CD and Argo Rollouts install manifests verbatim, pinned by SHA-256
 * in `bootstrap/provenance.json`. They are exempt from two steps:
 *
 *   - The policies, because reformatting them to satisfy a local convention would break the digest
 *     that proves they are unmodified.
 *   - The server-side dry run, because this cluster already runs both controllers from a Helm
 *     release whose label selectors differ. Dry-running the vendored manifests over it reports an
 *     immutable-selector conflict with a foreign installation, which says nothing about whether
 *     the manifests are valid. `tools/kubernetes/bootstrap.mjs --check` is what validates them:
 *     it verifies the digests and refuses to install over a controller it did not install.
 */
const VENDORED_ROOTS = new Set(['bootstrap']);
/**
 * Directories `tools/kubernetes/bootstrap.mjs` applies with `kubectl`, before Argo CD exists.
 *
 * A sync wave on an object no Argo CD sync ever orders is a comment pretending to be a
 * constraint, so the wave policy does not apply to these.
 */
const BOOTSTRAP_APPLIED_ROOTS = new Set(['gitops-repo']);
/** Annotation an object uses to opt out of a named policy, and the annotation stating why. */
const EXEMPTION_ANNOTATION = 'private-cloud.io/policy-exempt';
const EXEMPTION_REASON_ANNOTATION = 'private-cloud.io/policy-exempt-reason';

const argv = process.argv.slice(2);
const offline = argv.includes('--offline');
const problems = [];

/**
 * Records a policy violation against the object that caused it.
 *
 * @param {{ root: string, object: Record<string, unknown> }} subject Where the violation is.
 * @param {string} message What is wrong, phrased as the expectation that was not met.
 * @returns {void}
 */
function violation(subject, message) {
  const { kind, metadata } = subject.object;
  problems.push(`${subject.root}: ${kind}/${metadata?.name ?? '<unnamed>'} — ${message}`);
}

/**
 * Reads the pod spec out of any object that has one.
 *
 * @param {Record<string, any>} object Rendered Kubernetes object.
 * @returns {Record<string, any> | undefined} The pod spec, or `undefined` when there is none.
 */
function podSpec(object) {
  const path = POD_TEMPLATE_PATHS[object.kind];
  if (!path) return undefined;
  const template = path.reduce((node, key) => node?.[key], object);
  return template?.spec;
}

/**
 * Every policy this deployment holds itself to, with the reason it exists.
 *
 * Each entry receives one rendered object and reports what is wrong with it. Splitting them this
 * way keeps the reason beside the rule rather than in a commit message nobody reads again.
 */
const POLICIES = [
  {
    id: 'rollout-required',
    name: 'traffic-taking services use a Rollout',
    // A Deployment cannot be gated. Substituting one for a Rollout silently removes the preview
    // environment, the analysis, and the abort — the entire promotion decision — while leaving a
    // manifest that still looks like a deployment of the same service.
    check(subject) {
      const { kind, metadata } = subject.object;
      if (kind === 'Deployment' && ROLLOUT_REQUIRED.has(metadata?.name)) {
        violation(subject, 'is a Deployment; this service must be deployed as a Rollout');
      }
    },
  },
  {
    id: 'resource-bounds',
    name: 'containers declare requests and limits',
    // Without requests the scheduler is guessing, and without limits one leaking container takes
    // the node down with it — on a single-node cluster, that is every other workload.
    check(subject) {
      const spec = podSpec(subject.object);
      if (!spec) return;
      for (const container of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
        const resources = container.resources ?? {};
        if (!resources.requests?.cpu || !resources.requests?.memory) {
          violation(subject, `container ${container.name} declares no CPU and memory requests`);
        }
        if (!resources.limits?.memory) {
          violation(subject, `container ${container.name} declares no memory limit`);
        }
      }
    },
  },
  {
    id: 'probes',
    name: 'long-running containers are probed',
    // Readiness is what decides whether a green environment counts as available during a
    // promotion. A container without one is reported healthy the instant it starts, which turns
    // the blue-green gate into a formality.
    check(subject) {
      if (!LONG_RUNNING_KINDS.has(subject.object.kind)) return;
      const spec = podSpec(subject.object);
      for (const container of spec?.containers ?? []) {
        if (!container.readinessProbe) {
          violation(subject, `container ${container.name} has no readiness probe`);
        }
        if (!container.livenessProbe) {
          violation(subject, `container ${container.name} has no liveness probe`);
        }
      }
    },
  },
  {
    id: 'pod-security',
    name: 'pods run unprivileged with a numeric user',
    // The namespace enforces the `restricted` Pod Security Standard, so a pod that violates this
    // is not rejected at review — it is rejected at admission, after a sync has already started.
    // A symbolic `USER` in the image is the subtle one: the kubelet cannot verify it is non-root
    // and refuses to start the container at all.
    check(subject) {
      const spec = podSpec(subject.object);
      if (!spec) return;
      const pod = spec.securityContext ?? {};
      if (pod.runAsNonRoot !== true) violation(subject, 'does not set runAsNonRoot: true');
      if (typeof pod.runAsUser !== 'number') {
        violation(subject, 'does not set a numeric runAsUser');
      }
      if (pod.seccompProfile?.type !== 'RuntimeDefault') {
        violation(subject, 'does not set seccompProfile.type: RuntimeDefault');
      }
      for (const container of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
        const security = container.securityContext ?? {};
        if (security.allowPrivilegeEscalation !== false) {
          violation(subject, `container ${container.name} allows privilege escalation`);
        }
        if (!security.capabilities?.drop?.includes('ALL')) {
          violation(subject, `container ${container.name} does not drop all capabilities`);
        }
      }
    },
  },
  {
    id: 'no-api-token',
    name: 'service account tokens are not mounted by default',
    // None of these workloads calls the API server. A projected token in every pod is a credential
    // with no purpose, which is the kind an attacker finds useful and an operator never rotates.
    check(subject) {
      const spec = podSpec(subject.object);
      if (!spec) return;
      if (spec.automountServiceAccountToken !== false) {
        violation(subject, 'does not set automountServiceAccountToken: false');
      }
    },
  },
  {
    id: 'pinned-images',
    name: 'images are pinned',
    // `latest` makes the manifest a description of what was deployed once rather than of what is
    // deployed now, and it makes a rollback impossible to express.
    check(subject) {
      const spec = podSpec(subject.object);
      if (!spec) return;
      for (const container of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
        const image = container.image ?? '';
        if (!image.includes(':') || image.endsWith(':latest')) {
          violation(subject, `container ${container.name} uses the floating image ${image}`);
        }
      }
    },
  },
  {
    id: 'sync-wave',
    name: 'objects declare a sync wave',
    // The ordering constraints here are real — Kafka before the connector, the schema migration
    // before the connector reads the tables — and an object with no wave lands in wave 0, which is
    // exactly where an ordering bug is hardest to see.
    check(subject) {
      const { kind, metadata } = subject.object;
      if (BOOTSTRAP_APPLIED_ROOTS.has(subject.root)) return;
      if (kind === 'Namespace' || kind === 'CustomResourceDefinition') return;
      if (!metadata?.annotations?.['argocd.argoproj.io/sync-wave']) {
        violation(subject, 'declares no argocd.argoproj.io/sync-wave annotation');
      }
    },
  },
  {
    id: 'no-committed-secret',
    name: 'no credential is committed',
    // SAFE-036. Every credential this deployment uses is generated in-cluster by the operator that
    // owns it. The single exception holds protocol switches, not a secret, and is named here so
    // that adding a second one has to be a deliberate edit to this file.
    check(subject) {
      const object = subject.object;
      if (object.kind !== 'Secret') return;
      const keys = Object.keys({ ...(object.data ?? {}), ...(object.stringData ?? {}) }).sort();
      if (object.metadata?.name !== REPOSITORY_SECRET.name) {
        violation(subject, `is a Secret committed to the repository, holding ${keys.join(', ')}`);
        return;
      }
      const unexpected = keys.filter((key) => !REPOSITORY_SECRET.keys.includes(key));
      if (unexpected.length > 0) {
        violation(subject, `holds keys beyond the allowed switches: ${unexpected.join(', ')}`);
      }
    },
  },
];

/**
 * Renders one kustomize root.
 *
 * @param {string} root Directory name under `deploy/kubernetes`.
 * @returns {Promise<{ yaml: string, objects: Array<Record<string, any>> }>} Rendered output.
 */
async function render(root) {
  const result = await kubectl(['kustomize', resolve(MANIFEST_ROOT, root)], { allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`kustomize build failed for ${root}.\n${result.stderr.trim()}`);
  }
  const objects = parseAllDocuments(result.stdout)
    .map((document) => document.toJS())
    .filter((object) => object && object.kind);
  return { yaml: result.stdout, objects };
}

process.stdout.write(`Rendering ${RENDER_ROOTS.length} kustomize roots from ${MANIFEST_ROOT}\n\n`);

const rendered = [];
for (const root of RENDER_ROOTS) {
  const output = await render(root);
  rendered.push({ root, ...output });
  process.stdout.write(
    `  ✓ ${root.padEnd(16)} ${String(output.objects.length).padStart(3)} objects\n`,
  );
}

// ---------------------------------------------------------------------------------------------
// Schema validation against the live API server
// ---------------------------------------------------------------------------------------------

if (offline) {
  process.stdout.write('\nSkipping the server-side dry run (--offline).\n');
} else {
  process.stdout.write('\nValidating against the API server (server-side dry run)\n');
  for (const { root, yaml } of rendered) {
    if (VENDORED_ROOTS.has(root)) {
      process.stdout.write(`  · ${root} (vendored upstream; verified by digest instead)\n`);
      continue;
    }
    // `--force-conflicts` under a dedicated field manager, and only because this is a dry run.
    // Without it every object Argo CD already owns comes back as an ownership conflict rather
    // than a schema verdict, which is the opposite of what this step is asking about. Nothing is
    // written: `--dry-run=server` validates and discards.
    const result = await kubectl(
      [
        'apply',
        '--dry-run=server',
        '--server-side',
        '--force-conflicts',
        '--field-manager=phase6-render-check',
        '-f',
        '-',
      ],
      { input: yaml, allowFailure: true, timeoutMs: 300_000 },
    );
    if (result.code !== 0) {
      problems.push(
        `${root}: server-side dry run rejected the manifests.\n${result.stderr.trim()}`,
      );
      process.stdout.write(`  ✗ ${root}\n`);
    } else {
      process.stdout.write(`  ✓ ${root}\n`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Deployment policies
// ---------------------------------------------------------------------------------------------

process.stdout.write(`\nApplying ${POLICIES.length} deployment policies\n`);
const beforePolicies = problems.length;
for (const { root, objects } of rendered) {
  if (VENDORED_ROOTS.has(root)) continue;
  for (const object of objects) {
    const subject = { root, object };
    const annotations = object.metadata?.annotations ?? {};
    const exempt = new Set(
      (annotations[EXEMPTION_ANNOTATION] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    // An exemption without a stated reason is indistinguishable from an oversight, so it is
    // itself a violation. This is the only way an exemption stays reviewable once it is merged.
    if (exempt.size > 0 && !annotations[EXEMPTION_REASON_ANNOTATION]) {
      violation(subject, `is exempt from ${[...exempt].join(', ')} without a stated reason`);
    }
    for (const policy of POLICIES) {
      if (exempt.has(policy.id)) continue;
      policy.check(subject);
    }
  }
}
for (const policy of POLICIES) process.stdout.write(`  · ${policy.name}\n`);
process.stdout.write(
  `  ${problems.length === beforePolicies ? '✓' : '✗'} ${problems.length - beforePolicies} violations\n`,
);

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

process.stdout.write(`\n${'-'.repeat(94)}\n`);
if (problems.length === 0) {
  const total = rendered.reduce((sum, entry) => sum + entry.objects.length, 0);
  process.stdout.write(`${total} objects render, validate, and satisfy every policy.\n`);
} else {
  for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);
  process.stdout.write(`\n${problems.length} problems.\n`);
  process.exitCode = 1;
}
