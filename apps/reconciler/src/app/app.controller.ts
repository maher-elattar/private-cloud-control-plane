import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { isDatabaseReachable, type PostgresClient } from '@private-cloud/postgres-adapter';
import { POSTGRES_DATABASE } from './tokens.js';

interface HealthResponse {
  readonly service: 'reconciler';
  readonly status: 'ok';
}

/**
 * Liveness and readiness for the reconciliation sweep.
 *
 * The provider is deliberately not probed. The reconciler's whole safety property is that it
 * observes and never corrects, and a sweep that skips an unreachable instance is behaving
 * correctly rather than failing; making the provider a readiness dependency would restart a pod
 * for doing the right thing.
 */
@Controller('health')
export class AppController {
  public constructor(@Inject(POSTGRES_DATABASE) private readonly database: PostgresClient) {}

  @Get('live')
  live(): HealthResponse {
    return { service: 'reconciler', status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    if (!(await isDatabaseReachable(this.database))) {
      throw new ServiceUnavailableException({
        service: 'reconciler',
        status: 'database_unreachable',
      });
    }
    return { service: 'reconciler', status: 'ok' };
  }
}
