/**
 * Composition root for the provisioning orchestrator.
 *
 * Binds the `WorkflowStore` port to PostgreSQL and the provider port to a gRPC client, then
 * starts the single background worker that drives provisioning.
 *
 * WHY the orchestrator talks to the provider over gRPC rather than importing the adapter
 * directly: provider credentials and network reach are privileged. Isolating them in
 * `proxmox-provider` means this process — which holds database credentials — never holds
 * Proxmox credentials as well.
 *
 * @see docs/security/trust-boundaries.md
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import {
  createPostgresDatabase,
  PostgresWorkflowStore,
  type PostgresClient,
} from '@private-cloud/postgres-adapter';
import { AppController } from './app.controller';
import { GrpcProviderClient } from './grpc-provider.client';
import { ProvisioningWorker } from './provisioning-worker';
import { POSTGRES_DATABASE, PROVIDER_CLIENT, WORKFLOW_STORE } from './tokens';

/** Reads the database URL, failing fast at startup rather than defaulting to anything. */
function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required.');
  return value;
}

/**
 * Closes the gRPC channel and the connection pool on shutdown.
 *
 * Order matters: the provider client is closed first so no new provider call can start, then
 * the pool drains whatever checkpoint was already in flight.
 */
@Injectable()
class RuntimeLifecycle implements OnApplicationShutdown {
  /**
   * @param database Shared connection pool.
   * @param provider gRPC channel to the provider service.
   */
  public constructor(
    @Inject(POSTGRES_DATABASE) private readonly database: PostgresClient,
    @Inject(PROVIDER_CLIENT) private readonly provider: GrpcProviderClient,
  ) {}

  /** Stops new provider calls, then drains the pool. */
  public async onApplicationShutdown(): Promise<void> {
    this.provider.close();
    await this.database.destroy();
  }
}

/** Default provider service address for a local single-host run. */
const DEFAULT_PROVIDER_GRPC_URL = '127.0.0.1:50052';

/**
 * Default deadline for a single provider call.
 *
 * Every provider call is bounded: a call that hangs would hold the instance lease until it
 * expired, blocking that instance. Ten seconds comfortably covers a Proxmox API response,
 * since long work is returned as a task reference and polled rather than waited on.
 */
const DEFAULT_PROVIDER_GRPC_DEADLINE_MS = 10_000;

/**
 * Wires workflow persistence, the provider client, and the background worker.
 *
 * Note there is no `ControlPlaneApplication` here. This process never serves tenant requests —
 * it only advances workflows that the control API has already accepted.
 */
@Module({
  // Health and readiness only; this service exposes no tenant-facing API.
  controllers: [AppController],
  providers: [
    { provide: POSTGRES_DATABASE, useFactory: () => createPostgresDatabase(requiredDatabaseUrl()) },
    {
      provide: WORKFLOW_STORE,
      inject: [POSTGRES_DATABASE],
      useFactory: (database: PostgresClient) => new PostgresWorkflowStore(database),
    },
    {
      provide: PROVIDER_CLIENT,
      useFactory: () =>
        new GrpcProviderClient(
          process.env.PROVIDER_GRPC_URL?.trim() || DEFAULT_PROVIDER_GRPC_URL,
          Number(process.env.PROVIDER_GRPC_DEADLINE_MS ?? DEFAULT_PROVIDER_GRPC_DEADLINE_MS),
        ),
    },
    ProvisioningWorker,
    RuntimeLifecycle,
  ],
})
export class AppModule {}
