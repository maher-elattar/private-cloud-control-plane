/**
 * Background poller that drives the provisioning saga.
 *
 * This is the entire orchestrator process, in effect: a timer that repeatedly asks
 * {@link CreateInstanceWorkflow} to perform one transition. All provisioning logic lives in
 * `packages/application`; this class exists only to schedule it and manage process lifecycle.
 *
 * WHY one transition per tick rather than a loop inside a claim: each transition commits its
 * own checkpoint and then releases the instance lease. Draining a whole workflow in one pass
 * would hold the lease across several provider calls, so a crash partway would leave the
 * instance locked until the lease expired, with the committed stage lagging behind what the
 * provider had already been asked to do.
 *
 * @see docs/architecture/glossary.md#persisted-saga-workflow-state-machine
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CreateInstanceWorkflow, type WorkflowStore } from '@private-cloud/application';
import { OpenTelemetryApplicationTelemetry } from '@private-cloud/observability';
import type { CreateInstanceProviderPort } from '@private-cloud/provider-sdk';
import { PROVIDER_CLIENT, WORKFLOW_STORE } from './tokens';

/**
 * Pause when no workflow is ready to advance.
 *
 * Short because it is the latency floor for provisioning: every stage waits at most this long
 * before the next one starts.
 */
const IDLE_POLL_DELAY_MS = 250;

/** Pause after an unexpected failure, so a persistent fault does not spin the loop. */
const ERROR_BACKOFF_MS = 1_000;

/** Executes leased workflow transitions on a timer. */
@Injectable()
export class ProvisioningWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProvisioningWorker.name);
  private readonly workflow: CreateInstanceWorkflow;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  /**
   * @param store Workflow persistence port, injected as `PostgresWorkflowStore`.
   * @param provider gRPC client to the provider service.
   */
  public constructor(
    @Inject(WORKFLOW_STORE) store: WorkflowStore,
    @Inject(PROVIDER_CLIENT) provider: CreateInstanceProviderPort,
  ) {
    this.workflow = new CreateInstanceWorkflow(
      store,
      provider,
      // WHY the PID fallback: the worker ID is claimed on instance leases, so two processes
      // sharing one would each accept the other's lease as their own and could act on the
      // same instance concurrently. `WORKER_ID` should be set from the pod name in a
      // multi-replica deployment; the PID only makes single-host local runs distinct.
      process.env.WORKER_ID?.trim() || `orchestrator-${process.pid}`,
      new OpenTelemetryApplicationTelemetry(),
    );
  }

  /** Starts polling once the process is ready. */
  public onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /**
   * Stops the loop and cancels any pending tick.
   *
   * A transition already in flight is left to finish. It holds a lease and a fencing token,
   * so its checkpoint either commits or is safely rejected — an interrupted shutdown cannot
   * corrupt workflow state.
   */
  public onApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Queues the next tick unless shutdown has begun. */
  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  /**
   * Performs one transition, then reschedules.
   *
   * Reaching the `catch` means something outside the workflow's own error handling failed —
   * a lost database connection, or a stale fencing token because this worker's lease was
   * taken. Both are safe to retry: no stage advanced, so the next claim resumes from the last
   * committed checkpoint.
   */
  private async tick(): Promise<void> {
    try {
      const handled = await this.workflow.runOne();
      this.schedule(handled ? 0 : IDLE_POLL_DELAY_MS);
    } catch (error: unknown) {
      this.logger.error(
        'Workflow polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
      this.schedule(ERROR_BACKOFF_MS);
    }
  }
}
