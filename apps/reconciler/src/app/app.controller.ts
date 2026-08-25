import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  readonly service: 'reconciler';
  readonly status: 'ok';
}

/** Process health only; provider and database readiness are added with their adapters. */
@Controller('health')
export class AppController {
  @Get('live')
  live(): HealthResponse {
    return { service: 'reconciler', status: 'ok' };
  }

  @Get('ready')
  ready(): HealthResponse {
    return { service: 'reconciler', status: 'ok' };
  }
}
