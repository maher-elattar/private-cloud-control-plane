/**
 * Forces the control-plane applications to re-read the repository and sync now.
 *
 * Argo CD's retry backoff reaches five minutes, and it refuses to re-attempt a revision it has
 * already tried. Both are correct for a production control loop and both make bring-up and
 * verification slow: a fixed manifest can sit unapplied for minutes while the previous attempt's
 * backoff runs down.
 *
 * This tool terminates any in-flight operation, refreshes each application against the current
 * revision, and requests a sync. It changes nothing about what is deployed — the repository is
 * still the only source of truth — it only stops the wait.
 *
 * `publish-gitops-repo.mjs` does the same thing at the end of every publish, so this tool is for
 * the case where the repository has not changed but the cluster has drifted from it.
 *
 * Usage:
 *   node tools/kubernetes/resync.mjs
 *   node tools/kubernetes/resync.mjs --wait     # also block until everything is Synced and Healthy
 */
import { resyncAll, waitForApplications } from './argocd.mjs';

const wait = process.argv.slice(2).includes('--wait');

const names = await resyncAll({ terminate: true });
if (names.length === 0) {
  throw new Error('No control-plane applications exist; run bootstrap first.');
}
for (const name of names) process.stdout.write(`resync        ${name}\n`);

if (wait) {
  for (const state of await waitForApplications()) {
    process.stdout.write(`synced        ${state.name.padEnd(30)} ${state.health}\n`);
  }
}
