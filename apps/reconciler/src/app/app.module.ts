/**
 * Reconciler process wiring.
 *
 * Constructs the sweep worker and the two ports it needs. The store it receives has no method
 * capable of destroying anything, which is how SAFE-029's non-destructive rule is enforced here:
 * not by discipline in the worker, but by what the worker is given.
 *
 * @see docs/adr/0008-non-destructive-reconciliation.md
 */
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import {
  createPostgresDatabase,
  PostgresReconciliationStore,
} from '@private-cloud/postgres-adapter';
import type { PostgresClient } from '@private-cloud/postgres-adapter';
import { shutdownTelemetry } from '@private-cloud/observability';
import { ProviderObservationClient } from './observation.client';
import { AppController } from './app.controller';
import { ReconciliationWorker } from './reconciliation-worker';
import { POSTGRES_DATABASE, PROVIDER_CLIENT, RECONCILIATION_STORE } from './tokens';

/** Flushes reconciler spans and metrics before process exit. */
@Injectable()
class TelemetryLifecycle implements OnApplicationShutdown {
  public async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

/**
 * Required rather than defaulted, so a reconciler pointed at no database fails to start rather
 * than sweeping nothing and reporting health.
 */
function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required.');
  return value;
}

@Module({
  controllers: [AppController],
  providers: [
    TelemetryLifecycle,
    { provide: POSTGRES_DATABASE, useFactory: () => createPostgresDatabase(requiredDatabaseUrl()) },
    {
      provide: RECONCILIATION_STORE,
      inject: [POSTGRES_DATABASE],
      useFactory: (database: PostgresClient) => new PostgresReconciliationStore(database),
    },
    {
      provide: PROVIDER_CLIENT,
      useFactory: () =>
        new ProviderObservationClient(process.env.PROVIDER_ADDRESS?.trim() || '127.0.0.1:50052'),
    },
    ReconciliationWorker,
  ],
})
export class AppModule {}
