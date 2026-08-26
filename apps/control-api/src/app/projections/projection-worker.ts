import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ProjectionStore } from '@private-cloud/application';
import { PROJECTION_STORE } from '../tokens';

@Injectable()
export class ProjectionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProjectionWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  public constructor(@Inject(PROJECTION_STORE) private readonly store: ProjectionStore) {}

  public onApplicationBootstrap(): void {
    this.schedule(0);
  }

  public onApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const applied = await this.store.applyNextWorkflowEvent();
      this.schedule(applied ? 0 : 250);
    } catch (error: unknown) {
      this.logger.error(
        'Projection polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
      this.schedule(1_000);
    }
  }
}
