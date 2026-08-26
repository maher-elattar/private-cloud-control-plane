import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CreateInstanceWorkflow, type WorkflowStore } from '@private-cloud/application';
import type { CreateInstanceProviderPort } from '@private-cloud/provider-sdk';
import { PROVIDER_CLIENT, WORKFLOW_STORE } from './tokens';

@Injectable()
export class ProvisioningWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProvisioningWorker.name);
  private readonly workflow: CreateInstanceWorkflow;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  public constructor(
    @Inject(WORKFLOW_STORE) store: WorkflowStore,
    @Inject(PROVIDER_CLIENT) provider: CreateInstanceProviderPort,
  ) {
    this.workflow = new CreateInstanceWorkflow(
      store,
      provider,
      process.env.WORKER_ID?.trim() || `orchestrator-${process.pid}`,
    );
  }

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
      const handled = await this.workflow.runOne();
      this.schedule(handled ? 0 : 250);
    } catch (error: unknown) {
      this.logger.error(
        'Workflow polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
      this.schedule(1_000);
    }
  }
}
