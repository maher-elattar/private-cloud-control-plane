/**
 * Control-plane API client.
 *
 * Talks to the endpoints defined in `packages/contracts/openapi/control-plane.v1.yaml`, proxied
 * through Vite at `/v1`. Every call degrades to `null` when the backend is unreachable so the
 * console still renders against `catalog.ts` during design review and offline development.
 */
import type { CreateInstanceInput, Instance, InstanceStatus } from './types';

const PROJECT_ID = import.meta.env['VITE_PROJECT_ID'] ?? 'default';

/** Maps the contract's lifecycle/power pair onto the single status the UI renders. */
function toStatus(lifecycle: string, power: string | undefined): InstanceStatus {
  if (lifecycle === 'creating' || lifecycle === 'updating') return 'provisioning';
  if (lifecycle === 'failed' || lifecycle === 'manual_review') return 'error';
  return power === 'on' ? 'running' : 'off';
}

type Json = Record<string, unknown>;

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(`/v1/projects/${PROJECT_ID}${path}`, {
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // WHY: a design-review build has no control API behind it. Returning null lets the caller
    // fall back to the static catalog instead of rendering an error page.
    return null;
  }
}

/** Projects an API instance payload onto the view model. */
function mapInstance(raw: Json): Instance {
  const desired = (raw['desired'] ?? {}) as Json;
  const observed = (raw['observed'] ?? {}) as Json;
  const lease = (observed['ipv4Lease'] ?? null) as Json | null;

  return {
    id: String(raw['id'] ?? ''),
    name: String(raw['name'] ?? ''),
    status: toStatus(
      String(observed['lifecycleState'] ?? 'active'),
      observed['powerState'] as string,
    ),
    flavorId: String(desired['flavorId'] ?? ''),
    flavorName: String(desired['flavorId'] ?? '').toUpperCase(),
    architecture: 'x86',
    diskGb: Number(desired['diskGb'] ?? 0),
    vcpus: Number(desired['vcpus'] ?? 0),
    memoryGb: Number(desired['memoryGb'] ?? 0),
    imageName: String(desired['imageId'] ?? ''),
    locationId: String(desired['networkId'] ?? ''),
    locationCity: String(desired['networkId'] ?? ''),
    networkZone: 'eu-central',
    ipv4: lease ? String(lease['address'] ?? '') : null,
    ipv6: null,
    pricePerMonth: 0,
    trafficUsedTb: 0,
    trafficIncludedTb: 20,
    createdAt: String(raw['createdAt'] ?? new Date().toISOString()),
    labels: (raw['labels'] ?? {}) as Record<string, string>,
  };
}

export async function listInstances(): Promise<readonly Instance[] | null> {
  const page = await request<{ items?: Json[] }>('/instances');
  return page?.items ? page.items.map(mapInstance) : null;
}

export async function createInstance(input: CreateInstanceInput): Promise<Instance | null> {
  const created = await request<Json>('/instances', {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      name: input.name,
      flavorId: input.flavorId,
      imageId: `${input.imageId}-${input.imageVersion}`,
      networkId: input.locationId,
      labels: input.labels,
    }),
  });
  return created ? mapInstance(created) : null;
}

export async function listOperations(): Promise<readonly Json[] | null> {
  const page = await request<{ items?: Json[] }>('/operations');
  return page?.items ?? null;
}
