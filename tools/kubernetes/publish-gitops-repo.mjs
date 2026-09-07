/**
 * Publishes `deploy/kubernetes` to the in-cluster Git repository Argo CD syncs from.
 *
 * This is the `git push` of this deployment. Argo CD reconciles a cluster against a repository,
 * and the repository it reads here is the one served inside the cluster by
 * `deploy/kubernetes/gitops-repo`. Until this tool runs, Argo CD is correctly reconciling the
 * previous publish — the same relationship a normal GitOps setup has with an unpushed commit.
 *
 * What it does:
 *
 *   1. Packs the Argo-managed subdirectories into a gzipped tar.
 *   2. Writes them into a ConfigMap the repository server's init container unpacks and commits.
 *   3. Rolls the repository server so the new commit is served.
 *   4. Waits until the repository proves it is serving *this* publish, then asks Argo CD to
 *      refresh and sync so the new revision is picked up immediately rather than at the next poll.
 *
 * Step 4 is precise about "this publish" for a reason. Argo CD refuses to re-attempt a revision it
 * has already attempted, so a refresh issued while the repository was still serving the previous
 * commit strands the new one: the application reports `OutOfSync` against a revision it believes
 * it has already synced, and only the self-heal backoff — up to five minutes — ever retries. The
 * publisher therefore reads back a digest marker committed into the repository before telling Argo
 * CD anything, and requests a sync rather than only a refresh.
 *
 * Two directories are deliberately excluded. `bootstrap/` holds vendored upstream installers that
 * Argo CD must not manage — it cannot reconcile itself — and they are far larger than a ConfigMap
 * may be. `gitops-repo/` is the repository server itself: an application that manages the
 * repository it is read from is a circular dependency that makes a broken publish unrecoverable.
 *
 * Usage:
 *   node tools/kubernetes/publish-gitops-repo.mjs
 *   node tools/kubernetes/publish-gitops-repo.mjs --no-refresh   # publish only; do not tell Argo CD
 *
 * Also importable: `bootstrap.mjs` calls {@link publishGitOpsRepository} directly, because the
 * root application cannot sync against a repository that has never been published to.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  hardRefresh,
  listApplications,
  requestSync,
  terminateRunningOperation,
} from './argocd.mjs';
import { kubectl, kubectlGetJson, run, waitFor } from './kubectl.mjs';

const MANIFEST_ROOT = resolve('deploy/kubernetes');
const REPOSITORY_NAMESPACE = 'private-cloud-gitops';
const REPOSITORY_DEPLOYMENT = 'gitops-repo';
const MANIFEST_CONFIGMAP = 'gitops-manifests';
/** A ConfigMap may hold 1 MiB in total; refuse well before the API server does. */
const MAXIMUM_ARCHIVE_BYTES = 700 * 1024;
/** Directories Argo CD must not manage. See the module comment for why each one is excluded. */
const EXCLUDED_DIRECTORIES = ['bootstrap', 'gitops-repo'];
/** File the repository server commits, carrying the digest of the publish it was built from. */
const PUBLISH_MARKER = '.publish-digest';

const skipRefresh = process.argv.slice(2).includes('--no-refresh');

/**
 * Packs the Argo-managed manifest tree into a deterministic gzipped tar.
 *
 * `--sort=name` and a fixed modification time make the archive a function of its content alone, so
 * republishing an unchanged tree produces an identical digest and no spurious commit.
 *
 * @param {string} root Manifest tree to pack.
 * @returns {Promise<{ archive: Buffer, digest: string }>} Archive bytes and their SHA-256.
 */
async function packManifests(root) {
  const archivePath = join(tmpdir(), `gitops-manifests-${randomUUID()}.tar.gz`);
  const excludeArguments = EXCLUDED_DIRECTORIES.flatMap((directory) => [
    '--exclude',
    `./${directory}`,
  ]);
  try {
    await run('tar', [
      '--create',
      '--gzip',
      '--file',
      archivePath,
      '--directory',
      root,
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      ...excludeArguments,
      '.',
    ]);
    const archive = await readFile(archivePath);
    return { archive, digest: createHash('sha256').update(archive).digest('hex') };
  } finally {
    await rm(archivePath, { force: true });
  }
}

/**
 * Reads the digest of whatever is currently published, if anything.
 *
 * @returns {Promise<string | undefined>} Published digest, or `undefined` when nothing is.
 */
async function publishedDigest() {
  const configMap = await kubectlGetJson([
    'configmap',
    MANIFEST_CONFIGMAP,
    '-n',
    REPOSITORY_NAMESPACE,
  ]);
  return configMap?.data?.['manifests-sha256'];
}

/**
 * Packs, publishes, and waits for the in-cluster repository to serve the new revision.
 *
 * @param {{ refresh?: boolean, root?: string }} [options] `refresh` nudges Argo CD to re-read
 *   immediately; `root` publishes a different manifest tree, which is how the verification drills
 *   introduce a change without editing the working tree.
 * @returns {Promise<{ digest: string, revision: string, changed: boolean }>} The published digest,
 *   the commit now serving it, and whether the digest differed from what was already there.
 */
export async function publishGitOpsRepository(options = {}) {
  const refresh = options.refresh ?? true;
  const { archive, digest } = await packManifests(options.root ?? MANIFEST_ROOT);
  if (archive.byteLength > MAXIMUM_ARCHIVE_BYTES) {
    throw new Error(
      `The manifest archive is ${archive.byteLength} bytes, over the ${MAXIMUM_ARCHIVE_BYTES}-byte ` +
        'ceiling for a ConfigMap-delivered publish. Move the new content into its own Argo CD ' +
        'Application with its own source, or publish from a real Git remote instead.',
    );
  }

  const previous = await publishedDigest();
  if (previous === digest) {
    process.stdout.write(`unchanged     ${digest.slice(0, 12)} (${archive.byteLength} bytes)\n`);
  } else {
    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: MANIFEST_CONFIGMAP,
        namespace: REPOSITORY_NAMESPACE,
        labels: { 'app.kubernetes.io/part-of': 'private-cloud-control-plane' },
      },
      data: {
        'manifests-sha256': digest,
        // Becomes the commit message, so `argocd app get` shows which publish a revision came from.
        'publish-id': `${new Date().toISOString()} ${digest.slice(0, 12)}`,
      },
      binaryData: { 'manifests.tar.gz': archive.toString('base64') },
    };

    const manifestPath = join(tmpdir(), `gitops-manifests-${randomUUID()}.json`);
    try {
      await writeFile(manifestPath, JSON.stringify(configMap));
      await kubectl(['apply', '-f', manifestPath]);
    } finally {
      await rm(manifestPath, { force: true });
    }

    await kubectl([
      'rollout',
      'restart',
      `deployment/${REPOSITORY_DEPLOYMENT}`,
      '-n',
      REPOSITORY_NAMESPACE,
    ]);
    process.stdout.write(`published     ${digest.slice(0, 12)} (${archive.byteLength} bytes)\n`);
  }

  await kubectl([
    'rollout',
    'status',
    `deployment/${REPOSITORY_DEPLOYMENT}`,
    '-n',
    REPOSITORY_NAMESPACE,
    '--timeout=180s',
  ]);

  // Prove the repository is serving *this* publish before telling Argo CD to look at it.
  //
  // Asked of the daemon itself, from the pod that runs it. The Git protocol is not HTTP, so the
  // API server's Service proxy cannot speak it, and a separate probe pod would need a full
  // `restricted` security context to be admitted into this namespace — a probe that fails on
  // admission is indistinguishable from a repository that is not serving.
  //
  // The marker file is what makes this a proof rather than a liveness check. `git ls-remote`
  // succeeding only says some repository answered; reading back the digest says the repository
  // that answered was built from the archive this run just wrote.
  const head = await waitFor(
    `the GitOps repository to serve publish ${digest.slice(0, 12)}`,
    async () => {
      const pods = await kubectlGetJson([
        'pods',
        '-n',
        REPOSITORY_NAMESPACE,
        '-l',
        `app.kubernetes.io/name=${REPOSITORY_DEPLOYMENT}`,
        '--field-selector=status.phase=Running',
      ]);
      const name = pods?.items?.[0]?.metadata?.name;
      if (!name) return undefined;
      const result = await kubectl(
        [
          'exec',
          '-n',
          REPOSITORY_NAMESPACE,
          name,
          '--',
          'sh',
          '-c',
          `git ls-remote git://127.0.0.1:9418/control-plane.git refs/heads/main && ` +
            `git --git-dir=/srv/git/control-plane.git show main:${PUBLISH_MARKER}`,
        ],
        { allowFailure: true, timeoutMs: 60_000 },
      );
      if (result.code !== 0) return undefined;
      const revision = /^([0-9a-f]{40})\s+refs\/heads\/main/m.exec(result.stdout)?.[1];
      const served = result.stdout.trim().split('\n').at(-1)?.trim();
      return revision && served === digest ? revision : undefined;
    },
    { timeoutMs: 180_000, intervalMs: 5_000 },
  );
  process.stdout.write(`serving       ${head.slice(0, 12)}\n`);

  if (refresh) {
    // Refresh *and* sync. A refresh alone leaves the controller free to decide it has already
    // attempted this revision, which is exactly the state a stale first attempt leaves behind.
    const applications = await listApplications();
    for (const application of applications) {
      await terminateRunningOperation(application.metadata.name);
      await hardRefresh(application.metadata.name);
      await requestSync(application);
    }
    process.stdout.write(`resynced      ${applications.length} applications\n`);
  }

  return { digest, revision: head, changed: previous !== digest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await publishGitOpsRepository({ refresh: !skipRefresh });
}
