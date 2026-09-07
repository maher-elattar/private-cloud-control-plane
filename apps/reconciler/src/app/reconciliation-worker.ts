/**
 * Periodic desired-versus-observed reconciliation.
 *
 * PATTERN — Scheduled sweep over a claim query. Each pass takes a bounded batch of the
 * least-recently-reconciled instances, observes each through the provider port, classifies the
 * difference, and records it.
 *
 * **It never corrects anything.** SAFE-029 forbids reconciliation from destroying, shrinking,
 * detaching, or overwriting a provider resource, and ADR 0008 explains why: a sweep runs without
 * a human present and without the request context that would justify a mutation, so the one thing
 * it can safely do with a surprise is describe it. The store it is given has no method that could
 * express a correction, so this is a property of the wiring rather than a rule to remember.
 *
 * @see docs/adr/0008-non-destructive-reconciliation.md
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ReconciliationCandidate, ReconciliationStore } from '@private-cloud/application';
import { classifyDrift } from '@private-cloud/domain';
import { structuredLog, withSpan } from '@private-cloud/observability';
import { ObservedPowerState } from '@private-cloud/contracts';
import type { ProviderObservationClient } from './observation.client';
import { PROVIDER_CLIENT, RECONCILIATION_STORE } from './tokens';

/**
 * How long an instance may go unobserved before a sweep claims it.
 *
 * Five minutes is a deliberate compromise: short enough that a VM someone deleted by hand is
 * noticed within one alerting interval, long enough that a few hundred instances do not turn into
 * a continuous provider load.
 */
const STALE_AFTER_MS = 5 * 60 * 1000;

/** Instances observed per pass, bounding both provider load and transaction size. */
const BATCH_SIZE = 25;

/** Pause between passes. */
const SWEEP_INTERVAL_MS = 30_000;

/** Pause after an unexpected failure, so a persistent fault does not spin the loop. */
const ERROR_BACKOFF_MS = 5_000;

/** Observes instances on a timer and records classified drift. */
@Injectable()
export class ReconciliationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  public constructor(
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    @Inject(PROVIDER_CLIENT) private readonly provider: ProviderObservationClient,
  ) {}

  /** Starts sweeping once the process is ready. */
  public onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Stops scheduling further passes. */
  public onApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Runs one pass and schedules the next. */
  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.sweep()
        .then(() => this.schedule(SWEEP_INTERVAL_MS))
        .catch((error: unknown) => {
          this.logger.error('Reconciliation sweep failed.', error);
          this.schedule(ERROR_BACKOFF_MS);
        });
    }, delayMs);
  }

  /** Observes one batch of stale instances. */
  private async sweep(): Promise<void> {
    const candidates = await this.store.claimStaleInstances(
      BATCH_SIZE,
      new Date(Date.now() - STALE_AFTER_MS),
    );
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      if (this.stopping) return;
      await this.reconcile(candidate);
    }
  }

  /**
   * Observes one instance and records what was found.
   *
   * Public so a test can drive a single instance without waiting on the sweep timer. The sweep is
   * a loop over this; there is nothing in it worth hiding.
   *
   * A provider failure is swallowed after logging rather than aborting the pass: one unreachable
   * instance must not stop every other instance from being reconciled, and the next sweep will
   * pick this one up again because its `last_reconciled_at` only advances on a claim.
   */
  public async reconcile(candidate: ReconciliationCandidate): Promise<void> {
    await withSpan(
      'controlplane.reconciliation.observe',
      {
        'cloud.project.id': candidate.projectId,
        'cloud.resource.id': candidate.instanceId,
      },
      async () => {
        try {
          const observation = (
            await this.provider.observeInstance({
              context: {
                requestId: `${candidate.instanceId}:reconcile`,
                operationId: candidate.createOperationId,
                correlationId: candidate.createOperationId,
                projectId: candidate.projectId,
                instanceId: candidate.instanceId,
                providerProfileId: candidate.providerProfileId,
                attempt: 1,
              },
              providerResourceId: candidate.providerResourceId,
              expectedOwnershipMarkers: {
                managedBy: 'private-cloud-control-plane',
                environment: 'lab',
                projectId: candidate.projectId,
                instanceId: candidate.instanceId,
                createOperationId: candidate.createOperationId,
              },
            })
          ).observation;

          const observed = {
            exists: Boolean(observation?.exists),
            powerState: powerStateName(observation?.powerState),
            markerMatch: Boolean(observation?.ownership?.match),
            ...(observation?.resources?.cpuCount === undefined
              ? {}
              : {
                  cpuCount: observation.resources.cpuCount,
                  memoryMiB: Number(observation.resources.memoryMib),
                  diskGiB: Number(observation.resources.diskGib),
                }),
          };
          const finding = classifyDrift(
            {
              lifecycleState: candidate.lifecycleState,
              powerState: candidate.desiredPowerState as 'running' | 'stopped' | 'unchanged',
              cpuCount: candidate.desiredCpuCount,
              memoryMiB: candidate.desiredMemoryMiB,
              diskGiB: candidate.desiredDiskGiB,
            },
            observed,
          );

          await this.store.recordObservation({
            instanceId: candidate.instanceId,
            projectId: candidate.projectId,
            drift: finding.classification,
            dangerous: finding.dangerous,
            exists: observed.exists,
            powerState: observed.powerState,
            markerMatch: observed.markerMatch,
            observedAt: new Date(),
          });

          if (finding.classification !== 'none') {
            structuredLog('warn', 'reconciliation_drift_detected', {
              instance_id: candidate.instanceId,
              classification: finding.classification,
              dangerous: finding.dangerous,
            });
          }
        } catch (error: unknown) {
          // One unreachable instance must not stop the pass. `last_reconciled_at` advanced on the
          // claim, so the next sweep after the stale window picks this one up again.
          this.logger.warn(
            `Reconciliation could not observe instance ${candidate.instanceId}.`,
            error,
          );
        }
      },
    );
  }
}

/**
 * Maps the provider enum onto the domain's observed vocabulary.
 *
 * Exported for tests: an unmapped enum member silently becoming `unknown` would make every
 * instance in that state look ambiguous, which is a dangerous classification.
 */
export function powerStateName(
  value: ObservedPowerState | undefined,
): 'running' | 'stopped' | 'suspended' | 'unknown' {
  switch (value) {
    case ObservedPowerState.OBSERVED_POWER_STATE_RUNNING:
      return 'running';
    case ObservedPowerState.OBSERVED_POWER_STATE_STOPPED:
      return 'stopped';
    case ObservedPowerState.OBSERVED_POWER_STATE_SUSPENDED:
      return 'suspended';
    default:
      return 'unknown';
  }
}
