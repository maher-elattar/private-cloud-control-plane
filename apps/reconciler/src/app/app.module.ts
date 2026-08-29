import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { shutdownTelemetry } from '@private-cloud/observability';
import { AppController } from './app.controller';

/** Flushes reconciler spans and metrics before process exit. */
@Injectable()
class TelemetryLifecycle implements OnApplicationShutdown {
  public async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

@Module({
  controllers: [AppController],
  providers: [TelemetryLifecycle],
})
export class AppModule {}
