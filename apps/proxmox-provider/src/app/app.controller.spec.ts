/**
 * Readiness behaviour for the provider adapter process.
 *
 * These cases exist because of a real defect: the probe chained `.catch()` onto
 * `getCapabilities(...)`, and `ProxmoxProvider.getCapabilities` was not `async`, so its profile
 * assertion threw synchronously and escaped the handler entirely. The endpoint returned 500
 * rather than 503, the container never became ready, and `provisioning-orchestrator` — which
 * waits on that health — never started. Nothing caught it because the default adapter is the
 * fake, whose `getCapabilities` is `async` and asserts nothing.
 *
 * The synchronous-throw case is therefore the load-bearing test here, not an edge case.
 *
 * @see docs/verification/testsrv-survey.md
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { CreateInstanceProviderPort } from '@private-cloud/provider-sdk';
import { describe, expect, it } from 'vitest';
import { AppController } from './app.controller';

/** A capability response shaped like the real one, with only the field the probe reads. */
const capabilities = { capabilities: { createInstance: true }, observedAt: '2026-01-01T00:00:00Z' };

/** Builds a controller over a provider double, with an optional configured profile. */
function controller(
  provider: Partial<CreateInstanceProviderPort>,
  profileId?: string,
): AppController {
  return new AppController(provider as CreateInstanceProviderPort, profileId);
}

describe('readiness', () => {
  it('reports ok when the adapter answers with capabilities', async () => {
    const ready = await controller({
      getCapabilities: async () => capabilities,
    } as Partial<CreateInstanceProviderPort>).ready();

    expect(ready).toEqual({ service: 'proxmox-provider', status: 'ok' });
  });

  it('answers 503 rather than 500 when the adapter throws synchronously', async () => {
    // Exactly the shape of the defect: not `async`, and it throws before returning a promise.
    const provider = {
      getCapabilities: () => {
        throw new Error('Provider profile is not allowlisted.');
      },
    } as unknown as Partial<CreateInstanceProviderPort>;

    await expect(controller(provider).ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('answers 503 when the adapter rejects', async () => {
    const provider = {
      getCapabilities: async () => {
        throw new Error('unavailable');
      },
    } as Partial<CreateInstanceProviderPort>;

    await expect(controller(provider).ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('answers 503 when the adapter answers without capabilities', async () => {
    const provider = {
      getCapabilities: async () => ({ observedAt: '2026-01-01T00:00:00Z' }),
    } as unknown as Partial<CreateInstanceProviderPort>;

    await expect(controller(provider).ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('names the configured provider profile, which getCapabilities requires', async () => {
    const seen: unknown[] = [];
    const provider = {
      getCapabilities: async (request: unknown) => {
        seen.push(request);
        return capabilities;
      },
    } as unknown as Partial<CreateInstanceProviderPort>;

    await controller(provider, 'proxmox-testsrv').ready();

    expect(seen).toEqual([{ requestId: 'readiness-probe', providerProfileId: 'proxmox-testsrv' }]);
  });

  it('omits the profile entirely under the fake adapter', async () => {
    const seen: unknown[] = [];
    const provider = {
      getCapabilities: async (request: unknown) => {
        seen.push(request);
        return capabilities;
      },
    } as unknown as Partial<CreateInstanceProviderPort>;

    await controller(provider).ready();

    // Not `providerProfileId: undefined` — the key is absent, so a strict adapter cannot read it
    // as a caller asking about a profile named `undefined`.
    expect(seen).toEqual([{ requestId: 'readiness-probe' }]);
  });
});

describe('liveness', () => {
  it('is static and does not consult the adapter', () => {
    const provider = {
      getCapabilities: () => {
        throw new Error('must not be called');
      },
    } as unknown as Partial<CreateInstanceProviderPort>;

    expect(controller(provider).live()).toEqual({ service: 'proxmox-provider', status: 'ok' });
  });
});
