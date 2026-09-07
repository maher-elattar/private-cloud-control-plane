import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { isDatabaseReachable, type PostgresClient } from '@private-cloud/postgres-adapter';
import { POSTGRES_DATABASE } from './tokens.js';

interface HealthResponse {
  readonly service: 'control-api';
  readonly status: 'ok';
}

/**
 * Liveness and readiness for the API process.
 *
 * The two probes answer deliberately different questions, and conflating them is the classic way
 * to turn a dependency outage into a cluster-wide restart storm:
 *
 * - **Liveness** asks whether this process is still capable of running. It never consults a
 *   dependency. A database outage is not something a restart can fix, and a liveness probe that
 *   fails on it would kill every replica at once, at exactly the moment the failed dependency is
 *   recovering and needs its connections back.
 * - **Readiness** asks whether this process can serve a request right now. It fails when the
 *   database is unreachable, which removes the pod from the Service and stops the Gateway sending
 *   it traffic it would only reject.
 *
 * Readiness is also what a blue-green promotion counts. A green ReplicaSet whose pods report ready
 * before they can serve is a promotion gate that measures nothing, so the check has to be real.
 *
 * Kafka is not probed here because it cannot be unready at this point: `ProjectionConsumer` starts
 * its consumers in `onApplicationBootstrap`, and NestJS does not begin listening until that
 * resolves. An answer from this endpoint is itself evidence the consumers connected.
 */
@Controller('health')
export class AppController {
  public constructor(@Inject(POSTGRES_DATABASE) private readonly database: PostgresClient) {}

  @Get('live')
  live(): HealthResponse {
    return { service: 'control-api', status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    if (!(await isDatabaseReachable(this.database))) {
      // Bounded and redacted: the probe response says what is unavailable, never why in terms a
      // caller outside the cluster could mine for topology.
      throw new ServiceUnavailableException({
        service: 'control-api',
        status: 'database_unreachable',
      });
    }
    return { service: 'control-api', status: 'ok' };
  }
}
