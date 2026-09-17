/**
 * Maps contract responses onto the shapes the routes render.
 *
 * WHY a mapping layer at all, when the contract types are right there: the routes were written
 * against a flat presentation shape, and the contract's is a desired/observed pair with a
 * separate lease and a separate catalog. Flattening it once here is better than teaching forty
 * components the difference, and it gives one place to answer the question this console kept
 * getting wrong — *what do we show when the API does not know?*
 *
 * The answer throughout is `null`, never a plausible-looking zero. The predecessor mapped
 * `desired.diskGb`, `desired.vcpus` and `desired.memoryGb`, none of which exist in the contract —
 * the real names are `diskGiB`, `cpuCount` and `memoryMiB` — so every one of those rendered as
 * `0`. A zero is a measurement; an unknown is not, and a console that cannot tell them apart
 * reports hardware that does not exist.
 */
import type { Flavor, Image, Instance as WireInstance, Network, Operation, Snapshot } from './api';
import { priceFor } from './catalog';
import type { ActivityEntry, DiskImage, Instance, InstanceStatus } from './types';

/** MiB per GiB, named because the arithmetic appears in three places. */
const MIB_PER_GIB = 1024;

/**
 * Collapses the contract's lifecycle and power states onto the one status the UI renders.
 *
 * The contract has ten lifecycle states and the list shows a single coloured dot, so the mapping
 * is lossy on purpose. What it must not do is lose the *distinction that matters*: something in
 * flight looks different from something at rest, and something needing attention looks different
 * from both.
 */
export function toStatus(instance: WireInstance): InstanceStatus {
  switch (instance.lifecycleState) {
    case 'pending':
    case 'provisioning':
    case 'updating':
    case 'purge_pending':
      return 'provisioning';
    case 'failed':
    case 'unknown_outcome':
    case 'manual_review':
      return 'error';
    case 'retained':
    case 'purged':
      // Retained is not an error and not running: the provider resource is still there but
      // detached. Rendering it as "off" is the closest honest answer the four-state dot allows.
      return 'off';
    default:
      // `ObservedPowerState` is `running | stopped | suspended | unknown`. The predecessor
      // compared against `'on'`, which is not one of those, so every instance read as "off".
      return instance.observed?.powerState === 'running' ? 'running' : 'off';
  }
}

/**
 * The progress of whatever is currently happening to an instance.
 *
 * Read from the operation the instance itself names, not simulated. The predecessor advanced a
 * counter by 12% every 900ms, which looked convincing and meant nothing.
 */
function progress(
  instance: WireInstance,
  operations: readonly Operation[],
): { readonly progressPercent?: number } {
  if (!instance.activeOperationId) return {};
  const operation = operations.find((entry) => entry.id === instance.activeOperationId);
  // Spread rather than assigned: this workspace sets `exactOptionalPropertyTypes`, so an optional
  // property may be absent but may not be present-and-undefined.
  return operation === undefined ? {} : { progressPercent: operation.progressPercent };
}

/**
 * Builds the presentation shape for one instance.
 *
 * @param instance The instance as the API returned it.
 * @param context.flavors The flavour catalog, for the requested sizing and the display name.
 * @param context.images The image catalog, for the architecture and display name.
 * @param context.networks The network catalog, for a human label instead of an id.
 * @param context.operations Recent operations, for live progress.
 * @returns The view model, with `null` wherever the API reported nothing.
 */
export function toInstance(
  instance: WireInstance,
  context: {
    readonly flavors: readonly Flavor[];
    readonly images: readonly Image[];
    readonly networks: readonly Network[];
    readonly operations: readonly Operation[];
  },
): Instance {
  const desired = instance.desired;
  const flavor = context.flavors.find((entry) => entry.id === desired.flavorId);
  const image = context.images.find((entry) => entry.id === desired.imageId);
  const network = context.networks.find((entry) => entry.id === desired.networkId);
  const observed = instance.observed ?? null;

  return {
    id: instance.id,
    // The contract's only name-like field is `hostname`. There is no separate display name, and
    // inventing one would be a field the user could not change.
    name: desired.hostname,
    status: toStatus(instance),
    ...progress(instance, context.operations),
    flavorId: desired.flavorId,
    flavorName: flavor?.name ?? desired.flavorId,
    architecture: image?.architecture ?? null,
    // Desired sizing comes from the flavour, because that is what was asked for. Observed sizing
    // is what the provider reported and is the one that can disagree — which is the whole point of
    // showing both.
    vcpus: flavor?.cpuCount ?? null,
    memoryGb: flavor ? flavor.memoryMiB / MIB_PER_GIB : null,
    diskGb: flavor?.minimumDiskGiB ?? null,
    observedVcpus: observed?.cpuCount ?? null,
    observedMemoryGb:
      observed?.memoryMiB === null || observed?.memoryMiB === undefined
        ? null
        : observed.memoryMiB / MIB_PER_GIB,
    observedDiskGb: observed?.diskGiB ?? null,
    imageId: desired.imageId,
    imageName: image?.name ?? desired.imageId,
    networkId: desired.networkId,
    networkName: network?.name ?? desired.networkId,
    ipv4: instance.ipv4Lease?.address ?? null,
    ipv4State: instance.ipv4Lease?.state ?? null,
    // This deployment leases IPv4 only. `control.ipv4_leases` has no IPv6 counterpart, so there is
    // nothing to show and nothing to pretend.
    ipv6: null,
    pricePerMonth: priceFor(desired.flavorId),
    lifecycleState: instance.lifecycleState,
    drift: instance.drift,
    retentionDeadline: instance.retentionDeadline ?? null,
    activeOperationId: instance.activeOperationId ?? null,
    createdAt: instance.createdAt,
  };
}

/**
 * Turns operations into the activity feed's entries.
 *
 * The feed shows what the control plane did, which is exactly what the operation journal records,
 * so this is a rename rather than a derivation. Failure text comes from `errorMessage`, which the
 * contract marks `x-classification: tenant-safe` — safe to render as it arrives.
 */
export function toActivity(operation: Operation): ActivityEntry {
  const state =
    operation.state === 'succeeded'
      ? 'succeeded'
      : operation.state === 'failed'
        ? 'failed'
        : 'running';
  const action = operation.action.replaceAll('_', ' ');
  return {
    id: operation.id,
    message:
      state === 'failed' && operation.errorMessage
        ? `${action} failed: ${operation.errorMessage}`
        : action,
    at: operation.completedAt ?? operation.startedAt ?? operation.acceptedAt,
    state,
    operationId: operation.id,
    targetId: operation.targetId,
    ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
  };
}

/**
 * Maps a snapshot onto the shared disk-image shape the tables render.
 *
 * `sizeGb` is `null` because the contract does not carry one. The predecessor showed a size
 * computed as 2.1% of the server's disk — a plausible-looking number with nothing behind it.
 *
 * The five contract states collapse to two for display, but `rolling_back` and `deleting` are
 * kept as in-flight rather than folded into `available`: a snapshot being rolled back is very
 * much not available, and showing it as such would invite a second rollback.
 */
export function toDiskImage(snapshot: Snapshot): DiskImage {
  const inFlight =
    snapshot.state === 'creating' ||
    snapshot.state === 'rolling_back' ||
    snapshot.state === 'deleting';
  return {
    id: snapshot.id,
    description: snapshot.description ?? snapshot.name,
    name: snapshot.name,
    sizeGb: null,
    createdAt: snapshot.createdAt,
    instanceId: snapshot.instanceId,
    status: inFlight ? 'creating' : 'available',
    state: snapshot.state,
  };
}
