import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  readonly service: 'proxmox-provider';
  readonly status: 'ok';
}

/** Process health only; provider endpoint readiness is added with the adapter. */
@Controller('health')
export class AppController {
  @Get('live')
  live(): HealthResponse {
    return { service: 'proxmox-provider', status: 'ok' };
  }

  @Get('ready')
  ready(): HealthResponse {
    return { service: 'proxmox-provider', status: 'ok' };
  }
}
