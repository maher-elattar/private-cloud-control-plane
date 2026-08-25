import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  readonly service: 'control-api';
  readonly status: 'ok';
}

/** Process health only; dependency readiness is added with the owning adapters. */
@Controller('health')
export class AppController {
  @Get('live')
  live(): HealthResponse {
    return { service: 'control-api', status: 'ok' };
  }

  @Get('ready')
  ready(): HealthResponse {
    return { service: 'control-api', status: 'ok' };
  }
}
