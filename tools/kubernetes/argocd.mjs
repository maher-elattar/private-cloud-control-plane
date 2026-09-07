/**
 * Argo CD application control, shared by the publisher, the resync tool, and the verifier.
 *
 * Argo CD's auto-sync is deliberately conservative in two ways that a bring-up loop has to work
 * with rather than against:
 *
 *   - It refuses to re-attempt a revision it has already attempted. A first attempt that rendered
 *     stale manifests therefore strands that revision: the application stays `OutOfSync`, and the
 *     only thing that retries is the self-heal path, behind a backoff that reaches five minutes.
 *   - Its retry backoff applies to failures, not to staleness, so waiting it out is the only
 *     remedy the controller offers on its own.
 *
 * Requesting a sync explicitly is what breaks both. It changes nothing about *what* is deployed —
 * the repository is still the only source of truth, and the sync is against `HEAD` — it only
 * removes the wait.
 */
import { kubectl, kubectlGetJson, waitFor } from './kubectl.mjs';

/** Namespace holding the `Application` objects. */
export const ARGOCD_NAMESPACE = 'argocd';
/** Label every application this project owns carries. */
const PART_OF_LABEL = 'app.kubernetes.io/part-of=private-cloud-control-plane';

/**
 * Lists the control-plane applications.
 *
 * @returns {Promise<Array<Record<string, any>>>} Application objects, or an empty array.
 */
export async function listApplications() {
  const applications = await kubectlGetJson([
    'applications',
    '-n',
    ARGOCD_NAMESPACE,
    '-l',
    PART_OF_LABEL,
  ]);
  return applications?.items ?? [];
}

/**
 * Summarises an application's reconciliation state.
 *
 * @param {Record<string, any>} application Application object.
 * @returns {{ name: string, sync: string, health: string, revision: string | undefined }} Summary.
 */
export function applicationState(application) {
  return {
    name: application.metadata.name,
    sync: application.status?.sync?.status ?? 'Unknown',
    health: application.status?.health?.status ?? 'Unknown',
    revision: application.status?.sync?.revision,
  };
}

/**
 * Terminates an in-flight operation, if one is running.
 *
 * While an operation is in flight every later revision waits behind it, so a stuck sync blocks
 * the fix for the thing that made it stick.
 *
 * @param {string} name Application name.
 * @returns {Promise<void>} Resolves once the patch is attempted.
 */
export async function terminateRunningOperation(name) {
  const application = await kubectlGetJson(['application', name, '-n', ARGOCD_NAMESPACE]);
  if (application?.status?.operationState?.phase !== 'Running') return;
  await kubectl(
    [
      'patch',
      'application',
      name,
      '-n',
      ARGOCD_NAMESPACE,
      '--type=merge',
      '-p',
      JSON.stringify({ status: { operationState: { phase: 'Terminating' } } }),
    ],
    { allowFailure: true },
  );
}

/**
 * Asks Argo CD to re-read the repository, discarding its cached manifests.
 *
 * @param {string} name Application name.
 * @returns {Promise<void>} Resolves once the annotation is set.
 */
export async function hardRefresh(name) {
  await kubectl([
    'annotate',
    'application',
    name,
    '-n',
    ARGOCD_NAMESPACE,
    'argocd.argoproj.io/refresh=hard',
    '--overwrite',
  ]);
}

/**
 * Requests a sync of one application against `HEAD`.
 *
 * @param {Record<string, any>} application Application object, read for its sync options.
 * @returns {Promise<void>} Resolves once the operation is requested.
 */
export async function requestSync(application) {
  await kubectl(
    [
      'patch',
      'application',
      application.metadata.name,
      '-n',
      ARGOCD_NAMESPACE,
      '--type=merge',
      '-p',
      JSON.stringify({
        operation: {
          initiatedBy: { username: 'phase6-tooling' },
          sync: {
            revision: 'HEAD',
            syncOptions: application.spec?.syncPolicy?.syncOptions ?? [],
          },
        },
      }),
    ],
    { allowFailure: true },
  );
}

/**
 * Refreshes and syncs every control-plane application.
 *
 * @param {{ terminate?: boolean }} [options] `terminate` also cancels in-flight operations.
 * @returns {Promise<string[]>} Names of the applications acted on.
 */
export async function resyncAll(options = {}) {
  const applications = await listApplications();
  for (const application of applications) {
    if (options.terminate) await terminateRunningOperation(application.metadata.name);
    await hardRefresh(application.metadata.name);
    await requestSync(application);
  }
  return applications.map((application) => application.metadata.name);
}

/**
 * Waits until every control-plane application is Synced and Healthy.
 *
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] Deadline and poll spacing.
 * @returns {Promise<Array<ReturnType<typeof applicationState>>>} Final states.
 */
export async function waitForApplications(options = {}) {
  const { timeoutMs = 900_000, intervalMs = 10_000 } = options;
  return waitFor(
    'every control-plane Argo CD application to be Synced and Healthy',
    async () => {
      const states = (await listApplications()).map(applicationState);
      if (states.length === 0) return undefined;
      return states.every((state) => state.sync === 'Synced' && state.health === 'Healthy')
        ? states
        : undefined;
    },
    { timeoutMs, intervalMs },
  );
}
