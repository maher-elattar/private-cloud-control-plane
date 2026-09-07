import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { CreateInstanceProviderPort } from '@private-cloud/provider-sdk';
import { CREATE_INSTANCE_PROVIDER } from './tokens.js';

interface HealthResponse {
  readonly service: 'proxmox-provider';
  readonly status: 'ok';
}

/**
 * Liveness and readiness for the provider adapter process.
 *
 * Readiness asks the adapter to describe its own capabilities. That is a local call, and it is
 * meant to be: the adapter is the *only* component in this system that can mutate real hardware,
 * so its readiness probe must not make an outbound call to a hypervisor. A probe that ran every
 * few seconds against a live Proxmox endpoint would be an unauthenticated availability signal for
 * that endpoint and a standing load on it.
 *
 * What the check does prove is that the configured adapter was constructed and is answering,
 * which is the failure this endpoint exists to catch: a process that started with a broken
 * provider configuration and would otherwise accept gRPC calls it cannot serve.
 */
/** Marks capability reads that originate from the probe rather than from a workflow stage. */
const READINESS_REQUEST_ID = 'readiness-probe';

@Controller('health')
export class AppController {
  public constructor(
    @Inject(CREATE_INSTANCE_PROVIDER) private readonly provider: CreateInstanceProviderPort,
  ) {}

  @Get('live')
  live(): HealthResponse {
    return { service: 'proxmox-provider', status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    const response = await this.provider
      .getCapabilities({ requestId: READINESS_REQUEST_ID })
      .catch(() => undefined);
    if (!response?.capabilities) {
      throw new ServiceUnavailableException({
        service: 'proxmox-provider',
        status: 'provider_unavailable',
      });
    }
    return { service: 'proxmox-provider', status: 'ok' };
  }
}
