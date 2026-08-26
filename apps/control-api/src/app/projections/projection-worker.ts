/**
 * Background poller that drives the read projection.
 *
 * PATTERN — Read projection (CQRS), consumer side. Hosted inside the control API for Phase 3
 * because it is the service that owns the read model. In Phase 4 the *source* of events
 * becomes Kafka instead of a database table, and this class is replaced by a consumer; the
 * projection logic in `PostgresProjectionStore` is unaffected.
 *
 * WHY a self-rescheduling `setTimeout` rather than `setInterval`: the next tick is scheduled
 * only after the current one finishes, so a slow apply can never overlap itself and produce
 * two workers competing for the same event.
 *
 * @see docs/architecture/glossary.md#read-projection-cqrs
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ProjectionStore } from '@private-cloud/application';
import { PROJECTION_STORE } from '../tokens';

/**
 * Pause when the event queue is empty.
 *
 * Short because it bounds how stale a client's readback can be: a create that has just
 * progressed becomes visible within roughly this long.
 */
const IDLE_POLL_DELAY_MS = 250;

/**
 * Pause after a failure.
 *
 * Longer than the idle delay so a persistent fault — a dropped database connection — does not
 * spin the loop and flood the logs while it recovers.
 */
const ERROR_BACKOFF_MS = 1_000;

/** Applies workflow events to the read model on a timer. */
@Injectable()
export class ProjectionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProjectionWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  /** @param store Projection port, injected as `PostgresProjectionStore`. */
  public constructor(@Inject(PROJECTION_STORE) private readonly store: ProjectionStore) {}

  /** Starts polling once the application is ready to serve. */
  public onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Stops the loop and cancels any pending tick. */
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
   * Applies at most one event, then reschedules based on what happened.
   *
   * Rescheduling with zero delay after a successful apply drains a backlog as fast as the
   * database allows, while still yielding to the event loop between events.
   *
   * A failure is logged and retried rather than rethrown: the event stays unconsumed, so
   * nothing is lost, and the next tick will attempt it again.
   */
  private async tick(): Promise<void> {
    try {
      const applied = await this.store.applyNextWorkflowEvent();
      this.schedule(applied ? 0 : IDLE_POLL_DELAY_MS);
    } catch (error: unknown) {
      this.logger.error(
        'Projection polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
      this.schedule(ERROR_BACKOFF_MS);
    }
  }
}
