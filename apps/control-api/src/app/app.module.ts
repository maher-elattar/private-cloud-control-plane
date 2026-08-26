import { Module, type OnApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { ControlPlaneApplication } from '@private-cloud/application';
import {
  createPostgresDatabase,
  PostgresControlPlaneStore,
  PostgresProjectionStore,
  type PostgresClient,
} from '@private-cloud/postgres-adapter';
import { AppController } from './app.controller';
import { OidcAuthGuard } from './auth/oidc-auth.guard';
import { OidcAuthService } from './auth/oidc-auth.service';
import { CatalogController } from './catalog/catalog.controller';
import { ControlPlaneGrpcController } from './grpc/control-plane-grpc.controller';
import { InstancesController } from './instances/instances.controller';
import { OperationsController } from './operations/operations.controller';
import { ProjectionWorker } from './projections/projection-worker';
import { CONTROL_PLANE_APPLICATION, POSTGRES_DATABASE, PROJECTION_STORE } from './tokens';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(POSTGRES_DATABASE) private readonly database: PostgresClient) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required.');
  return value;
}

@Module({
  controllers: [
    AppController,
    CatalogController,
    InstancesController,
    OperationsController,
    ControlPlaneGrpcController,
  ],
  providers: [
    OidcAuthService,
    OidcAuthGuard,
    { provide: POSTGRES_DATABASE, useFactory: () => createPostgresDatabase(requiredDatabaseUrl()) },
    {
      provide: CONTROL_PLANE_APPLICATION,
      inject: [POSTGRES_DATABASE],
      useFactory: (database: PostgresClient) =>
        new ControlPlaneApplication(new PostgresControlPlaneStore(database)),
    },
    {
      provide: PROJECTION_STORE,
      inject: [POSTGRES_DATABASE],
      useFactory: (database: PostgresClient) => new PostgresProjectionStore(database),
    },
    ProjectionWorker,
    DatabaseLifecycle,
  ],
})
export class AppModule {}
