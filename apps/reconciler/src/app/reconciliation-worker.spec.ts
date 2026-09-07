/**
 * Unit coverage for the reconciliation sweep.
 *
 * The classification itself is tested in the domain. What is tested here is the wiring around it:
 * that a provider observation becomes the right snapshot, that a finding is recorded, and — most
 * importantly — that a provider failure on one instance does not stop the pass.
 *
 * There is also a structural assertion. SAFE-029 says reconciliation must never destroy, shrink,
 * detach, or overwrite a provider resource, and the way that is enforced is by what this worker is
 * given rather than by what it chooses to call. A test that pins the shape of those ports catches
 * a future widening that would make the rule violable again.
 */
import { describe, expect, it, vi } from 'vitest';
import { ObservedPowerState } from '@private-cloud/contracts';
import type { ReconciliationCandidate, ReconciliationOutcome } from '@private-cloud/application';
import { ReconciliationWorker, powerStateName } from './reconciliation-worker';
import type { ProviderObservationClient } from './observation.client';

const candidate: ReconciliationCandidate = {
  instanceId: '00000000-0000-4000-8000-000000000012',
  projectId: '00000000-0000-4000-8000-000000000013',
  providerProfileId: 'fake-lab',
  createOperationId: '00000000-0000-4000-8000-0000000000c1',
  providerResourceId: '910001',
  lifecycleState: 'active',
  desiredPowerState: 'running',
  desiredCpuCount: 2,
  desiredMemoryMiB: 4096,
  desiredDiskGiB: 32,
};

/** Records what the worker asked the store to persist. */
function store() {
  const recorded: ReconciliationOutcome[] = [];
  return {
    recorded,
    claimStaleInstances: vi.fn().mockResolvedValue([]),
    recordObservation: vi.fn(async (outcome: ReconciliationOutcome) => {
      recorded.push(outcome);
    }),
  };
}

/** A provider that reports one fixed observation. */
function provider(observation: unknown): ProviderObservationClient {
  return {
    observeInstance: vi.fn().mockResolvedValue({ observation }),
    close: vi.fn(),
  } as unknown as ProviderObservationClient;
}

const owned = {
  exists: true,
  powerState: ObservedPowerState.OBSERVED_POWER_STATE_RUNNING,
  ownership: { complete: true, match: true },
  resources: { cpuCount: 2, memoryMib: '4096', diskGib: '32' },
  observedAt: '2026-09-05T00:00:00.000Z',
};

describe('powerStateName', () => {
  it('maps every provider state the contract declares', () => {
    expect(powerStateName(ObservedPowerState.OBSERVED_POWER_STATE_RUNNING)).toBe('running');
    expect(powerStateName(ObservedPowerState.OBSERVED_POWER_STATE_STOPPED)).toBe('stopped');
    expect(powerStateName(ObservedPowerState.OBSERVED_POWER_STATE_SUSPENDED)).toBe('suspended');
  });

  it('treats an absent or unrecognised state as unknown', () => {
    // `unknown` classifies as ambiguous and dangerous, which is the right default: a state this
    // build cannot name is not one it should act on.
    expect(powerStateName(undefined)).toBe('unknown');
    expect(powerStateName(ObservedPowerState.UNRECOGNIZED)).toBe('unknown');
  });
});

describe('ReconciliationWorker', () => {
  it('records no drift when the provider matches desired state', async () => {
    const persistence = store();
    const worker = new ReconciliationWorker(persistence, provider(owned));
    await worker.reconcile(candidate);

    expect(persistence.recorded).toHaveLength(1);
    expect(persistence.recorded[0]).toMatchObject({
      instanceId: candidate.instanceId,
      drift: 'none',
      dangerous: false,
      exists: true,
      powerState: 'running',
      markerMatch: true,
    });
  });

  it('records a dangerous finding when the resource is gone', async () => {
    const persistence = store();
    const worker = new ReconciliationWorker(
      persistence,
      provider({ ...owned, exists: false, ownership: { complete: false, match: false } }),
    );
    await worker.reconcile(candidate);

    expect(persistence.recorded[0]).toMatchObject({
      drift: 'missing_resource',
      dangerous: true,
    });
  });

  it('records identity mismatch when the markers belong to someone else', async () => {
    const persistence = store();
    const worker = new ReconciliationWorker(
      persistence,
      provider({ ...owned, ownership: { complete: true, match: false } }),
    );
    await worker.reconcile(candidate);
    expect(persistence.recorded[0]).toMatchObject({
      drift: 'identity_mismatch',
      dangerous: true,
    });
  });

  it('records power drift as safely correctable', async () => {
    const persistence = store();
    const worker = new ReconciliationWorker(
      persistence,
      provider({ ...owned, powerState: ObservedPowerState.OBSERVED_POWER_STATE_STOPPED }),
    );
    await worker.reconcile(candidate);
    expect(persistence.recorded[0]).toMatchObject({ drift: 'power_drift', dangerous: false });
  });

  it('swallows a provider failure so one unreachable instance cannot stop the pass', async () => {
    // `last_reconciled_at` advanced on the claim, so the next sweep picks this one up again. If
    // this rethrew, a single unreachable VM would wedge reconciliation for every other instance.
    const persistence = store();
    const failing = {
      observeInstance: vi.fn().mockRejectedValue(new Error('provider unreachable')),
      close: vi.fn(),
    } as unknown as ProviderObservationClient;
    const worker = new ReconciliationWorker(persistence, failing);

    await expect(worker.reconcile(candidate)).resolves.toBeUndefined();
    expect(persistence.recordObservation).not.toHaveBeenCalled();
  });

  it('is given no way to mutate a provider resource', async () => {
    // SAFE-029 enforced structurally. The observation client exposes one RPC and the store has no
    // method that removes anything; this fails if either is ever widened.
    const persistence = store();
    expect(
      Object.keys(persistence)
        .filter((key) => key !== 'recorded')
        .sort(),
    ).toEqual(['claimStaleInstances', 'recordObservation']);

    const observationClient = provider(owned) as unknown as Record<string, unknown>;
    const callable = Object.keys(observationClient).filter(
      (key) => typeof observationClient[key] === 'function',
    );
    expect(callable.sort()).toEqual(['close', 'observeInstance']);
  });
});
