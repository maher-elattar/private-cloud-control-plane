/**
 * Argo Rollouts state readers used by the verification drills.
 *
 * Everything here is derived from the `Rollout` object and the ReplicaSets and Services around it,
 * with no dependency on the `kubectl argo rollouts` plugin. WHY: the plugin is an optional local
 * install, and a verification suite that silently reports "not installed" as "not verified" is
 * worse than one that reads the API directly.
 */
import { kubectlGetJson } from './kubectl.mjs';

/** Label Argo Rollouts stamps onto every ReplicaSet, Service selector, and pod it manages. */
export const POD_TEMPLATE_HASH_LABEL = 'rollouts-pod-template-hash';

/**
 * Reads the interesting parts of a rollout's current state.
 *
 * @param {string} namespace Namespace holding the rollout.
 * @param {string} name Rollout name.
 * @returns {Promise<{
 *   phase: string,
 *   message: string | undefined,
 *   stableHash: string | undefined,
 *   currentHash: string | undefined,
 *   activeSelector: string | undefined,
 *   previewSelector: string | undefined,
 *   image: string | undefined,
 *   specReplicas: number | undefined,
 *   replicas: number,
 *   available: number,
 *   abortedAt: string | undefined,
 * }>} Rollout state.
 */
export async function readRollout(namespace, name) {
  const rollout = await kubectlGetJson(['rollout', name, '-n', namespace]);
  if (!rollout) throw new Error(`Rollout ${namespace}/${name} does not exist.`);
  const blueGreen = rollout.status?.blueGreen ?? {};
  return {
    phase: rollout.status?.phase ?? 'Unknown',
    message: rollout.status?.message,
    stableHash: rollout.status?.stableRS,
    currentHash: rollout.status?.currentPodHash,
    activeSelector: blueGreen.activeSelector,
    previewSelector: blueGreen.previewSelector,
    image: rollout.spec?.template?.spec?.containers?.[0]?.image,
    // Declared and observed replica counts are different questions, and during a blue-green update
    // they are different numbers: `status.replicas` counts the pods of *both* ReplicaSets, so a
    // rollout that declares two replicas reports four mid-promotion.
    specReplicas: rollout.spec?.replicas,
    replicas: rollout.status?.replicas ?? 0,
    available: rollout.status?.availableReplicas ?? 0,
    abortedAt: rollout.status?.abortedAt,
  };
}

/**
 * Reads the pod-template hash a Service currently selects.
 *
 * This is the single field that decides which environment receives traffic, which makes it the
 * field every blue-green assertion in the drills is ultimately about.
 *
 * @param {string} namespace Namespace holding the Service.
 * @param {string} name Service name.
 * @returns {Promise<string | undefined>} The selected hash, or `undefined` when unset.
 */
export async function serviceSelectedHash(namespace, name) {
  const service = await kubectlGetJson(['service', name, '-n', namespace]);
  return service?.spec?.selector?.[POD_TEMPLATE_HASH_LABEL];
}

/**
 * Lists the analysis runs a rollout has produced, newest first.
 *
 * Selected by owner reference rather than by label. Argo Rollouts labels an `AnalysisRun` with the
 * *rollout's own* `spec.selector.matchLabels` — whatever those happen to be — plus the pod-template
 * hash and the promotion phase. There is no label that names the rollout, so a label selector here
 * would silently return nothing for a rollout whose selector key differs, and "the gate did not
 * run" is exactly the wrong thing to conclude from a query that cannot see it.
 *
 * @param {string} namespace Namespace holding the runs.
 * @param {string} rolloutName Rollout the runs belong to.
 * @returns {Promise<Array<{
 *   name: string,
 *   phase: string,
 *   promotion: string | undefined,
 *   podTemplateHash: string | undefined,
 *   createdAt: string,
 *   metrics: Array<{ name: string, phase: string, message: string | undefined, measurements: number }>,
 * }>>} Analysis runs.
 */
export async function listAnalysisRuns(namespace, rolloutName) {
  const runs = await kubectlGetJson(['analysisruns', '-n', namespace]);
  return (runs?.items ?? [])
    .filter((run) =>
      (run.metadata.ownerReferences ?? []).some(
        (reference) => reference.kind === 'Rollout' && reference.name === rolloutName,
      ),
    )
    .map((run) => ({
      name: run.metadata.name,
      phase: run.status?.phase ?? 'Pending',
      promotion: run.metadata.labels?.['rollout-type'],
      podTemplateHash: run.metadata.labels?.[POD_TEMPLATE_HASH_LABEL],
      createdAt: run.metadata.creationTimestamp,
      metrics: (run.status?.metricResults ?? []).map((metric) => ({
        name: metric.name,
        phase: metric.phase,
        message: metric.message,
        measurements: (metric.measurements ?? []).length,
      })),
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Reads the pod IP addresses currently behind a Service.
 *
 * @param {string} namespace Namespace holding the Service.
 * @param {string} name Service name.
 * @returns {Promise<string[]>} Ready endpoint addresses.
 */
export async function serviceEndpoints(namespace, name) {
  const slices = await kubectlGetJson([
    'endpointslices',
    '-n',
    namespace,
    '-l',
    `kubernetes.io/service-name=${name}`,
  ]);
  return (slices?.items ?? []).flatMap((slice) =>
    (slice.endpoints ?? [])
      .filter((endpoint) => endpoint.conditions?.ready !== false)
      .flatMap((endpoint) => endpoint.addresses ?? []),
  );
}
