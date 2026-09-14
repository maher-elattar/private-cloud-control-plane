import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { CreateInstanceProviderPort } from '@private-cloud/provider-sdk';
import { CREATE_INSTANCE_PROVIDER, PROVIDER_PROFILE_ID } from './tokens.js';

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
    // The allowlisted profile, because `getCapabilities` requires the caller to name it. Absent
    // under the fake adapter, which asserts nothing.
    @Inject(PROVIDER_PROFILE_ID) private readonly providerProfileId: string | undefined,
  ) {}

  @Get('live')
  live(): HealthResponse {
    return { service: 'proxmox-provider', status: 'ok' };
  }

  /**
   * Reports whether this process can serve provider calls.
   *
   * WHY the call is wrapped in `try`/`catch` rather than `.catch()` on the returned promise: an
   * adapter whose `getCapabilities` is not `async` throws *synchronously*, before any promise
   * exists, and a `.catch()` chained onto the call expression never sees it. That was the real
   * shape of this endpoint, and under `PROVIDER_ADAPTER=proxmox` it turned an intended 503 into
   * an unhandled 500 — leaving the container permanently unready and, because the orchestrator
   * waits on that health, leaving the orchestrator unable to start at all.
   *
   * `ProxmoxProvider.getCapabilities` is now `async`, so the rejection path would be taken
   * anyway. The `try` stays regardless: a health endpoint must not be able to return 500 because
   * a dependency misbehaved, and the next adapter should not have to be polite for this to hold.
   *
   * @returns An `ok` body when the adapter answered with capabilities.
   * @throws ServiceUnavailableException when the adapter did not answer, for any reason.
   */
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    let capabilities: unknown;
    try {
      const response = await this.provider.getCapabilities({
        requestId: READINESS_REQUEST_ID,
        ...(this.providerProfileId ? { providerProfileId: this.providerProfileId } : {}),
      });
      capabilities = response?.capabilities;
    } catch {
      capabilities = undefined;
    }

    if (!capabilities) {
      throw new ServiceUnavailableException({
        service: 'proxmox-provider',
        status: 'provider_unavailable',
      });
    }
    return { service: 'proxmox-provider', status: 'ok' };
  }
}
