/**
 * Minimal Prometheus query client for the verification drills.
 *
 * Queries go through the API server's Service proxy rather than a port-forward. A port-forward is
 * a long-lived child process that has to be torn down on every failure path, and a leaked one
 * makes the next run fail on a bound port; the proxy is a plain request with no lifecycle.
 */
import { kubectl } from './kubectl.mjs';

/** The kube-prometheus-stack server this deployment reads. */
export const PROMETHEUS_SERVICE = 'my-kube-prometheus-stack-prometheus';
export const PROMETHEUS_NAMESPACE = 'monitoring';
export const PROMETHEUS_PORT_NAME = 'http-web';

/**
 * Runs an instant query and returns its result vector.
 *
 * @param {string} query PromQL expression.
 * @returns {Promise<Array<{ metric: Record<string, string>, value: [number, string] }>>} Samples.
 */
export async function instantQuery(query) {
  const path =
    `/api/v1/namespaces/${PROMETHEUS_NAMESPACE}/services/${PROMETHEUS_SERVICE}:${PROMETHEUS_PORT_NAME}` +
    `/proxy/api/v1/query?query=${encodeURIComponent(query)}`;
  const result = await kubectl(['get', '--raw', path], { timeoutMs: 60_000 });
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== 'success') {
    throw new Error(`Prometheus rejected the query: ${parsed.error ?? 'unknown error'}`);
  }
  return parsed.data.result;
}

/**
 * Runs an instant query expected to yield a single number.
 *
 * @param {string} query PromQL expression.
 * @returns {Promise<number | undefined>} The scalar, or `undefined` when the result is empty.
 */
export async function scalarQuery(query) {
  const samples = await instantQuery(query);
  if (samples.length === 0) return undefined;
  return Number.parseFloat(samples[0].value[1]);
}

/**
 * Lists the scrape targets Prometheus currently knows about for one namespace.
 *
 * Used to prove that the ServiceMonitor is actually collecting, which is a different question
 * from whether it was accepted: a monitoring object with the wrong release label is valid,
 * accepted, and collected by nothing.
 *
 * @param {string} namespace Namespace to filter on.
 * @returns {Promise<Array<Record<string, string>>>} Target labels, one entry per active target.
 */
export async function activeTargets(namespace) {
  const path =
    `/api/v1/namespaces/${PROMETHEUS_NAMESPACE}/services/${PROMETHEUS_SERVICE}:${PROMETHEUS_PORT_NAME}` +
    '/proxy/api/v1/targets?state=active';
  const result = await kubectl(['get', '--raw', path], { timeoutMs: 60_000 });
  const parsed = JSON.parse(result.stdout);
  return (parsed.data?.activeTargets ?? [])
    .map((target) => ({ ...target.labels, health: target.health, scrapeUrl: target.scrapeUrl }))
    .filter((labels) => labels.namespace === namespace);
}
