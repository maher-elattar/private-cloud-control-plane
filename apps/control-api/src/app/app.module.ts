/**
 * Composition root for the control API.
 *
 * This is where the ports declared in `packages/application` are bound to their PostgreSQL
 * adapters. Everything the service can do is assembled here and nowhere else.
 *
 * WHY the `useFactory` providers instead of plain `@Injectable()` classes: the application and
 * adapter layers deliberately import nothing from NestJS, so NestJS cannot construct them by
 * type. Building them explicitly against `Symbol` tokens is what keeps that independence —
 * which in turn is what lets `packages/application` be unit-tested with no container and
 * reused by the planned AWS Lambda path. The extra indirection is the price of that, and is
 * intentional rather than an oversight.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */
import {
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ControlPlaneApplication } from '@private-cloud/application';
import {
  createPostgresDatabase,
  PostgresControlPlaneStore,
  PostgresProjectionStore,
  readOutboxBacklog,
  type PostgresClient,
} from '@private-cloud/postgres-adapter';
import {
  OpenTelemetryApplicationTelemetry,
  shutdownTelemetry,
  structuredLog,
  updateOutboxBacklog,
} from '@private-cloud/observability';
import { AppController } from './app.controller';
import { DeadLettersController } from './administration/dead-letters.controller';
import { OidcAuthGuard } from './auth/oidc-auth.guard';
import { OidcAuthService } from './auth/oidc-auth.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogGrpcController } from './grpc/catalog-grpc.controller';
import { InstanceGrpcController } from './grpc/instance-grpc.controller';
import { OperationGrpcController } from './grpc/operation-grpc.controller';
import { InstancesController } from './instances/instances.controller';
import { OperationsController } from './operations/operations.controller';
import { ProjectionConsumer } from './projections/projection-consumer';
import { CONTROL_PLANE_APPLICATION, POSTGRES_DATABASE, PROJECTION_STORE } from './tokens';

/**
 * Closes the connection pool on shutdown.
 *
 * Exists as a provider purely so NestJS will call it: the Kysely client is created by a
 * factory and has no lifecycle hooks of its own. Without this, in-flight queries would be cut
 * off mid-transaction on redeploy instead of draining.
 */
@Injectable()
class DatabaseLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopping = false;
  /** @param database The shared connection pool. */
  public constructor(@Inject(POSTGRES_DATABASE) private readonly database: PostgresClient) {}

  public onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Drains and closes the pool. */
  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
    await this.database.destroy();
    await shutdownTelemetry();
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.current = this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    try {
      const backlog = await readOutboxBacklog(this.database, 'control');
      updateOutboxBacklog('control', backlog.count, backlog.oldestAgeSeconds);
    } catch {
      structuredLog('warn', 'outbox_metrics_read_failed', { outbox_owner: 'control' });
    } finally {
      this.schedule(2_000);
    }
  }
}

/**
 * Reads the database URL, failing fast at startup if it is absent.
 *
 * Deliberately thrown at construction rather than defaulted: a control plane silently pointed
 * at the wrong database is far worse than one that refuses to start.
 */
function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required.');
  return value;
}

/**
 * Wires the REST controllers, the three public gRPC services, and the projection worker.
 *
 * Both transports resolve the *same* `ControlPlaneApplication` instance, which is what
 * guarantees REST and gRPC callers get identical authorization, validation, and idempotency
 * behaviour rather than two implementations that drift apart.
 */
@Module({
  controllers: [
    AppController,
    DeadLettersController,
    // REST surface.
    CatalogController,
    InstancesController,
    OperationsController,
    // Public gRPC surface, one controller per gRPC service.
    CatalogGrpcController,
    InstanceGrpcController,
    OperationGrpcController,
  ],
  providers: [
    OidcAuthService,
    OidcAuthGuard,
    // One pool shared by the application store and the projection worker.
    { provide: POSTGRES_DATABASE, useFactory: () => createPostgresDatabase(requiredDatabaseUrl()) },
    {
      provide: CONTROL_PLANE_APPLICATION,
      inject: [POSTGRES_DATABASE],
      useFactory: (database: PostgresClient) => {
        const telemetry = new OpenTelemetryApplicationTelemetry();
        return new ControlPlaneApplication(
          new PostgresControlPlaneStore(database, telemetry),
          telemetry,
        );
      },
    },
    {
      provide: PROJECTION_STORE,
      inject: [POSTGRES_DATABASE],
      useFactory: (database: PostgresClient) => new PostgresProjectionStore(database),
    },
    ProjectionConsumer,
    DatabaseLifecycle,
  ],
})
export class AppModule {}
