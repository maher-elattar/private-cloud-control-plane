/**
 * Bootstraps everything the GitOps layer cannot install for itself.
 *
 * Three things live below Argo CD and therefore cannot be reconciled by it: Argo CD, the Argo
 * Rollouts controller, and the repository Argo CD reads from. This tool installs those three and
 * then hands over — the root `Application` it applies last is what brings up everything else.
 *
 * Everything below this layer is reconciled by Argo CD from `deploy/kubernetes`. This layer is
 * not, because Argo CD cannot create itself and because managing the Rollouts controller through
 * a Rollout turns a controller outage into an unrecoverable one.
 *
 * The tool is idempotent and deliberately conservative:
 *
 * - Every vendored manifest is checked against the digest recorded in `provenance.json` before it
 *   is applied, so an edited or truncated file fails loudly instead of installing a mutated
 *   control plane.
 * - An install that already exists at the pinned version is left completely alone. WHY: both
 *   controllers on this cluster were installed by Helm. Applying raw upstream manifests over a
 *   live Helm release rewrites ownership metadata and can leave the release unrepairable, which
 *   is a far worse outcome than skipping an install that is already correct.
 * - A version mismatch is reported and refused rather than silently upgraded. Upgrading a shared
 *   cluster controller is an operator decision, not a side effect of running a bootstrap script.
 *
 * Usage:
 *   node tools/kubernetes/bootstrap.mjs            # install what is missing, verify what exists
 *   node tools/kubernetes/bootstrap.mjs --check    # report only; never writes to the cluster
 *   node tools/kubernetes/bootstrap.mjs --force    # apply even over a foreign-managed install
 *   node tools/kubernetes/bootstrap.mjs --controllers-only   # stop after Argo CD and Rollouts
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { kubectl, kubectlGetJson, waitFor } from './kubectl.mjs';
import { publishGitOpsRepository } from './publish-gitops-repo.mjs';

const BOOTSTRAP_DIRECTORY = resolve('deploy/kubernetes/bootstrap');
const READINESS_TIMEOUT_MS = 300_000;

const KUBERNETES_ROOT = resolve('deploy/kubernetes');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const force = args.has('--force');
const controllersOnly = args.has('--controllers-only');

/**
 * Reads and validates the vendored manifest for one component.
 *
 * @param {{ path: string, sha256: string, name: string }} component Provenance entry.
 * @returns {Promise<string>} The manifest text, once its digest matches.
 */
async function readVerifiedManifest(component) {
  const manifestPath = resolve(BOOTSTRAP_DIRECTORY, component.path);
  const manifest = await readFile(manifestPath, 'utf8');
  const digest = createHash('sha256').update(manifest).digest('hex');
  if (digest !== component.sha256) {
    throw new Error(
      `${component.name}: ${component.path} has digest ${digest}, but provenance.json records ` +
        `${component.sha256}. Re-download from ${component.source} or update provenance.json ` +
        'deliberately; do not hand-edit a vendored upstream manifest.',
    );
  }
  return manifest;
}

/**
 * Describes what is currently installed for one component.
 *
 * @param {{ namespace: string, readinessDeployment: string, versionImage: string }} component
 *   Provenance entry.
 * @returns {Promise<{ present: boolean, image?: string, managedBy?: string, ready?: boolean }>}
 *   Observed state.
 */
async function observeInstalled(component) {
  const deployment = await kubectlGetJson([
    'deployment',
    component.readinessDeployment,
    '-n',
    component.namespace,
  ]);
  if (!deployment) return { present: false };
  const container = deployment.spec?.template?.spec?.containers?.[0];
  const status = deployment.status ?? {};
  return {
    present: true,
    image: container?.image,
    managedBy:
      deployment.metadata?.labels?.['app.kubernetes.io/managed-by'] ??
      (deployment.metadata?.annotations?.['meta.helm.sh/release-name'] ? 'Helm' : undefined),
    ready: (status.readyReplicas ?? 0) > 0 && status.readyReplicas === status.replicas,
  };
}

/**
 * Installs one component, or explains why it was skipped.
 *
 * @param {object} component Provenance entry.
 * @returns {Promise<{ name: string, action: string, detail: string }>} What happened.
 */
async function reconcileComponent(component) {
  const manifest = await readVerifiedManifest(component);
  const installed = await observeInstalled(component);

  if (installed.present) {
    const versionMatches = installed.image === component.versionImage;
    if (versionMatches && !force) {
      return {
        name: component.name,
        action: 'skipped',
        detail:
          `already installed at ${component.version}` +
          (installed.managedBy ? ` (managed by ${installed.managedBy})` : '') +
          (installed.ready ? ' and ready' : ' but not ready'),
      };
    }
    if (!versionMatches && !force) {
      return {
        name: component.name,
        action: 'mismatch',
        detail:
          `installed image is ${installed.image}, this repository pins ${component.versionImage}. ` +
          'Upgrading a shared cluster controller is an operator decision: re-run with --force to ' +
          'apply the pinned manifests, or update provenance.json to match the cluster.',
      };
    }
  }

  if (checkOnly) {
    return {
      name: component.name,
      action: installed.present ? 'would-apply' : 'would-install',
      detail: `${component.version} from ${component.path}`,
    };
  }

  const namespacePath = resolve(
    BOOTSTRAP_DIRECTORY,
    component.path.replace(/[^/]+$/, 'namespace.yaml'),
  );
  await kubectl(['apply', '-f', namespacePath]);
  // Server-side apply keeps the vendored manifest as one field manager instead of stuffing a
  // 1.9 MB last-applied-configuration annotation onto every object, which exceeds the annotation
  // size limit on several of the Argo CD CRDs.
  await kubectl([
    'apply',
    '--server-side',
    '--force-conflicts',
    '-n',
    component.namespace,
    '-f',
    resolve(BOOTSTRAP_DIRECTORY, component.path),
  ]);

  await waitFor(
    `${component.name} deployment ${component.readinessDeployment} to become available`,
    async () => {
      const state = await observeInstalled(component);
      return state.present && state.ready ? state : undefined;
    },
    { timeoutMs: READINESS_TIMEOUT_MS },
  );

  return {
    name: component.name,
    action: installed.present ? 'reapplied' : 'installed',
    detail: `${component.version} ready in namespace ${component.namespace}`,
  };
}

const provenance = JSON.parse(
  await readFile(resolve(BOOTSTRAP_DIRECTORY, 'provenance.json'), 'utf8'),
);
const outcomes = [];
for (const component of provenance.components) {
  outcomes.push(await reconcileComponent(component));
}

for (const outcome of outcomes) {
  process.stdout.write(
    `${outcome.action.padEnd(13)} ${outcome.name.padEnd(16)} ${outcome.detail}\n`,
  );
}

const mismatched = outcomes.filter((outcome) => outcome.action === 'mismatch');
if (mismatched.length > 0) {
  process.exitCode = 1;
}

if (checkOnly || controllersOnly || mismatched.length > 0) {
  process.exit(process.exitCode ?? 0);
}

// The repository server, then its first publish, then the root application. The order is the
// whole point: an `Application` pointed at a repository with no commits reports a clone failure
// that reads like a broken manifest.
await kubectl([
  'apply',
  '--server-side',
  '--force-conflicts',
  '-k',
  resolve(KUBERNETES_ROOT, 'gitops-repo'),
]);
process.stdout.write(`applied       gitops-repo      in-cluster repository server\n`);

const publish = await publishGitOpsRepository({ refresh: false });
process.stdout.write(
  `${publish.changed ? 'published' : 'unchanged'}     manifests        ${publish.digest.slice(0, 12)}\n`,
);

// The AppProject before the Application that names it. An `Application` referencing a project
// that does not exist is rejected outright and never reaches the sync that would have created it,
// so the project cannot bootstrap itself. It is still declared in the repository and reconciled
// from there afterwards; this apply only breaks the cycle.
await kubectl([
  'apply',
  '--server-side',
  '--force-conflicts',
  '-f',
  resolve(KUBERNETES_ROOT, 'argocd/project.yaml'),
]);
process.stdout.write('applied       app project      private-cloud\n');

await kubectl([
  'apply',
  '--server-side',
  '--force-conflicts',
  '-f',
  resolve(KUBERNETES_ROOT, 'argocd/root-application.yaml'),
]);
process.stdout.write('applied       root application control-plane-root\n');
