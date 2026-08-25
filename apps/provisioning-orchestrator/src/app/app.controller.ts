import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  readonly service: 'provisioning-orchestrator';
  readonly status: 'ok';
}

/** Process health only; Kafka and database readiness are added with their adapters. */
@Controller('health')
export class AppController {
  @Get('live')
  live(): HealthResponse {
    return { service: 'provisioning-orchestrator', status: 'ok' };
  }

  @Get('ready')
  ready(): HealthResponse {
    return { service: 'provisioning-orchestrator', status: 'ok' };
  }
}
