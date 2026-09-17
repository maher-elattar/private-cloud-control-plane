/**
 * Control-plane API client.
 *
 * Covers the sixteen tenant operations in `packages/contracts/openapi/control-plane.v1.yaml`, and
 * nothing else — the administrative surface is deliberately absent from a customer console.
 *
 * Three things about this client are deliberate and were not true of its predecessor.
 *
 * **It never falls back to mock data.** The previous version returned `null` on any failure so the
 * UI could render the static catalog during design review. That is right for design review and
 * wrong for a product: a customer whose API was unreachable would have seen a project full of
 * servers that did not exist. Every call now returns a result carrying either a value or the
 * problem document that explains the failure.
 *
 * **It does not invent fields.** The predecessor synthesised `architecture`, `networkZone`,
 * `trafficIncludedTb` and a location from the network id, and read `diskGb`, `vcpus` and
 * `memoryGb` — none of which exist in the contract, so they were silently zero. What is not in a
 * response is not in the view model.
 *
 * **Types come from the contract.** `@private-cloud/contracts` is generated from the OpenAPI
 * source, so a field rename breaks the build here rather than producing `undefined` at runtime.
 * The one place that cannot be used is noted at `InstanceActionBody` below.
 *
 * Requests go to a relative `/v1`, served by this console's own origin and proxied to the API.
 * That is not a convenience: the API sets no CORS headers at all, so a cross-origin console could
 * not call it.
 */
import type { components } from '@private-cloud/contracts';
import { idempotencyKey } from './idempotency';
import { type ApiResult, type Problem, readProblem, transportProblem } from './problem';

type Schemas = components['schemas'];

export type Project = Schemas['Project'];
export type QuotaSet = Schemas['QuotaSet'];
export type Instance = Schemas['Instance'];
export type InstancePage = Schemas['InstancePage'];
export type Operation = Schemas['Operation'];
export type OperationPage = Schemas['OperationPage'];
export type Snapshot = Schemas['Snapshot'];
export type SnapshotPage = Schemas['SnapshotPage'];
export type Flavor = Schemas['Flavor'];
export type Image = Schemas['Image'];
export type Network = Schemas['Network'];
export type MutationAccepted = Schemas['MutationAccepted'];
export type CreateInstanceRequest = Schemas['CreateInstanceRequest'];
export type InstanceLifecycleState = Schemas['InstanceLifecycleState'];
export type OperationState = Schemas['OperationState'];

/** The four power actions, exactly as the contract enumerates them. */
export type PowerActionName = 'start' | 'shutdown' | 'stop' | 'reboot';

/**
 * The action request body.
 *
 * WHY this is hand-written while everything else is generated: `components['schemas']['PowerAction']`
 * types `action` as the literal `'PowerAction'`, and `ResizeAction` as `'ResizeAction'`. Those are
 * not wire values — openapi-typescript substitutes the schema name when a `oneOf` carries a
 * `discriminator` block. The real enum in `components.v1.yaml` is
 * `[start, shutdown, stop, reboot]` and a `const: resize`, so using the generated type here would
 * compile cleanly and then be rejected by the server.
 */
export type InstanceActionBody =
  | { readonly action: PowerActionName }
  | { readonly action: 'resize'; readonly flavorId: string; readonly diskGiB?: number };

/** A page request. Both filters the contract declares are unimplemented server-side; see below. */
export interface PageRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * The project this console is scoped to.
 *
 * A tenant token carries its project in a `projects` claim, so the browser is told which project
 * it is looking at by the session endpoint rather than guessing. This is the fallback used before
 * a session exists, and `configureProject` replaces it once one does.
 */
let projectId = '';

/** Sets the project every subsequent call is scoped to. Called once, from the session provider. */
export function configureProject(id: string): void {
  projectId = id;
}

/** The project currently in scope, for callers that need it in a cache key. */
export function currentProject(): string {
  return projectId;
}

/**
 * One request, returning a result rather than throwing.
 *
 * @param path Path below the project scope, or an absolute `/v1` path when `absolute` is set.
 * @param init Fetch options.
 * @returns The parsed body, or the problem that explains why there is none.
 */
async function request<T>(
  path: string,
  init?: RequestInit & { readonly absolute?: boolean },
): Promise<ApiResult<T>> {
  const url = init?.absolute ? path : `/v1/projects/${projectId}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    // A genuine transport failure: the console's own origin is unreachable, or the browser
    // cancelled the request. There is no problem document to read, so one is synthesised.
    return {
      ok: false,
      problem: transportProblem(
        503,
        'The console could not reach the control plane',
        error instanceof Error ? error.message : 'The request did not complete.',
      ),
    };
  }
  if (!response.ok) return { ok: false, problem: await readProblem(response) };
  if (response.status === 204) return { ok: true, value: undefined as T };
  try {
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return {
      ok: false,
      problem: transportProblem(502, 'Unreadable response', 'The response body was not JSON.'),
    };
  }
}

/** Builds a query string, omitting absent values so no `?limit=undefined` is ever sent. */
function query(page: PageRequest): string {
  const pairs = Object.entries(page).filter(([, value]) => value !== undefined);
  return pairs.length === 0
    ? ''
    : `?${new URLSearchParams(pairs.map(([key, value]) => [key, String(value)])).toString()}`;
}

/**
 * One mutation, with a derived idempotency key.
 *
 * Every mutating route requires the header. Deriving it here rather than at each call site means
 * no route can forget it, and no route can accidentally use a random one.
 */
async function mutate<T>(input: {
  readonly action: string;
  readonly path: string;
  readonly method: 'POST' | 'DELETE' | 'PATCH';
  readonly targetId?: string | undefined;
  readonly body?: unknown;
}): Promise<ApiResult<T>> {
  const key = await idempotencyKey({
    action: input.action,
    projectId,
    targetId: input.targetId,
    body: input.body,
  });
  return request<T>(input.path, {
    method: input.method,
    headers: { 'idempotency-key': key },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

// --- Project and quota ------------------------------------------------------------------------

/** The project's identity, which replaces the hardcoded name the shell used to display. */
export function getProject(): Promise<ApiResult<Project>> {
  return request<Project>('');
}

/** Limits and live usage. The console shows this because the real quotas are small enough to hit. */
export function getQuota(): Promise<ApiResult<QuotaSet>> {
  return request<QuotaSet>('/quota');
}

// --- Catalog ---------------------------------------------------------------------------------

export function listImages(page: PageRequest = {}): Promise<ApiResult<Schemas['ImagePage']>> {
  return request<Schemas['ImagePage']>(`/catalog/images${query(page)}`);
}

export function listFlavors(page: PageRequest = {}): Promise<ApiResult<Schemas['FlavorPage']>> {
  return request<Schemas['FlavorPage']>(`/catalog/flavors${query(page)}`);
}

export function listNetworks(page: PageRequest = {}): Promise<ApiResult<Schemas['NetworkPage']>> {
  return request<Schemas['NetworkPage']>(`/catalog/networks${query(page)}`);
}

// --- Instances -------------------------------------------------------------------------------

/**
 * A page of instances.
 *
 * The contract declares a `lifecycleState` filter that the controller does not implement — it
 * reads only `limit` and `cursor`. Passing one would be silently ignored, which is worse than not
 * offering it, so the console filters client-side and this signature does not pretend otherwise.
 */
export function listInstances(page: PageRequest = {}): Promise<ApiResult<InstancePage>> {
  return request<InstancePage>(`/instances${query(page)}`);
}

export function getInstance(instanceId: string): Promise<ApiResult<Instance>> {
  return request<Instance>(`/instances/${instanceId}`);
}

/**
 * Accepts a create. Answers 202 with an operation to poll; the instance does not exist yet.
 *
 * The body is exactly the five fields `CreateInstanceRequest` declares. The API sets
 * `forbidNonWhitelisted`, so one extra property is a hard rejection — which is what the previous
 * client's `name` and `labels` fields would have produced had the create ever been wired.
 */
export function createInstance(body: CreateInstanceRequest): Promise<ApiResult<MutationAccepted>> {
  return mutate<MutationAccepted>({
    action: 'create-instance',
    path: '/instances',
    method: 'POST',
    body,
  });
}

/** Power or resize. Both go through one route, discriminated by `action`. */
export function actOnInstance(
  instanceId: string,
  body: InstanceActionBody,
): Promise<ApiResult<MutationAccepted>> {
  return mutate<MutationAccepted>({
    action: `instance-${body.action}`,
    path: `/instances/${instanceId}/actions`,
    method: 'POST',
    targetId: instanceId,
    body,
  });
}

/**
 * Soft delete.
 *
 * SAFE-028: this detaches access and **retains** the provider resource for review. It is not a
 * destroy, and any UI in front of it must say so — the only destroy is an administrative purge,
 * which a customer console does not expose.
 */
export function retainInstance(instanceId: string): Promise<ApiResult<MutationAccepted>> {
  return mutate<MutationAccepted>({
    action: 'retain-instance',
    path: `/instances/${instanceId}`,
    method: 'DELETE',
    targetId: instanceId,
  });
}

// --- Snapshots -------------------------------------------------------------------------------

export function listSnapshots(
  instanceId: string,
  page: PageRequest = {},
): Promise<ApiResult<SnapshotPage>> {
  return request<SnapshotPage>(`/instances/${instanceId}/snapshots${query(page)}`);
}

export function createSnapshot(
  instanceId: string,
  body: Schemas['CreateSnapshotRequest'],
): Promise<ApiResult<MutationAccepted>> {
  return mutate<MutationAccepted>({
    action: 'create-snapshot',
    path: `/instances/${instanceId}/snapshots`,
    method: 'POST',
    targetId: instanceId,
    body,
  });
}

export function rollbackSnapshot(
  instanceId: string,
  snapshotId: string,
): Promise<ApiResult<MutationAccepted>> {
  return mutate<MutationAccepted>({
    action: 'rollback-snapshot',
    path: `/instances/${instanceId}/snapshots/${snapshotId}/actions`,
    method: 'POST',
    targetId: snapshotId,
    body: { action: 'rollback' },
  });
}

export function deleteSnapshot(
  instanceId: string,
  snapshotId: string,
): Promise<ApiResult<MutationAccepted>> {
  return mutate<MutationAccepted>({
    action: 'delete-snapshot',
    path: `/instances/${instanceId}/snapshots/${snapshotId}`,
    method: 'DELETE',
    targetId: snapshotId,
  });
}

// --- Operations ------------------------------------------------------------------------------

/**
 * A page of operations, newest first.
 *
 * As with `listInstances`, the declared `instanceId` and `state` filters are unimplemented
 * server-side, so callers that need them filter the page they receive.
 */
export function listOperations(page: PageRequest = {}): Promise<ApiResult<OperationPage>> {
  return request<OperationPage>(`/operations${query(page)}`);
}

export function getOperation(operationId: string): Promise<ApiResult<Operation>> {
  return request<Operation>(`/operations/${operationId}`);
}

// --- Session ---------------------------------------------------------------------------------

/** Who the browser is, as the console's own proxy sees it. */
export interface Session {
  readonly subject: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly expiresAt: string;
}

/**
 * The current session, or a problem when there is none.
 *
 * Served by this console's own origin, not the control plane: the access token lives in a
 * server-side session behind an httpOnly cookie, so the browser can ask who it is but can never
 * read the credential that proves it.
 */
export function getSession(): Promise<ApiResult<Session>> {
  return request<Session>('/auth/session', { absolute: true });
}

export function signIn(credentials: {
  readonly username: string;
  readonly password: string;
}): Promise<ApiResult<Session>> {
  return request<Session>('/auth/login', {
    absolute: true,
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}

export function signOut(): Promise<ApiResult<void>> {
  return request<void>('/auth/logout', { absolute: true, method: 'POST' });
}

export type { ApiResult, Problem };
