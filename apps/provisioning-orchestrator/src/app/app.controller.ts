import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { isDatabaseReachable, type PostgresClient } from '@private-cloud/postgres-adapter';
import { POSTGRES_DATABASE } from './tokens.js';

interface HealthResponse {
  readonly service: 'provisioning-orchestrator';
  readonly status: 'ok';
}

/**
 * Liveness and readiness for the orchestrator process.
 *
 * Same split as the API: liveness never consults a dependency, readiness does. The orchestrator
 * serves no external traffic, but readiness still decides whether a green ReplicaSet counts as
 * available during a blue-green promotion, so an orchestrator that cannot reach the database must
 * not report itself ready to take over from one that can.
 *
 * Kafka is not probed for the reason given on the API's controller: `CommandConsumer` connects in
 * `onApplicationBootstrap`, before NestJS starts listening.
 */
@Controller('health')
export class AppController {
  public constructor(@Inject(POSTGRES_DATABASE) private readonly database: PostgresClient) {}

  @Get('live')
  live(): HealthResponse {
    return { service: 'provisioning-orchestrator', status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    if (!(await isDatabaseReachable(this.database))) {
      throw new ServiceUnavailableException({
        service: 'provisioning-orchestrator',
        status: 'database_unreachable',
      });
    }
    return { service: 'provisioning-orchestrator', status: 'ok' };
  }
}
