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

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required.');
  return value;
}

@Injectable()
class RuntimeLifecycle implements OnApplicationShutdown {
  public constructor(
    @Inject(POSTGRES_DATABASE) private readonly database: PostgresClient,
    @Inject(PROVIDER_CLIENT) private readonly provider: GrpcProviderClient,
  ) {}

  public async onApplicationShutdown(): Promise<void> {
    this.provider.close();
    await this.database.destroy();
  }
}

@Module({
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
          process.env.PROVIDER_GRPC_URL?.trim() || '127.0.0.1:50052',
          Number(process.env.PROVIDER_GRPC_DEADLINE_MS ?? 10_000),
        ),
    },
    ProvisioningWorker,
    RuntimeLifecycle,
  ],
})
export class AppModule {}
