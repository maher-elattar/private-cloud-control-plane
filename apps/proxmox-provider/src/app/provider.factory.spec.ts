import { FailureCategory } from '@private-cloud/contracts';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from '@private-cloud/provider-adapters';
import { createProvider, fakeProviderConfiguration, providerProfileId } from './provider.factory';

describe('fakeProviderConfiguration', () => {
  it('defaults to deterministic successful behavior', () => {
    expect(fakeProviderConfiguration({})).toEqual({
      defaultLatencyMs: 0,
      defaultTaskPollsBeforeSuccess: 1,
    });
  });

  it('models a bounded retry followed by recovery', () => {
    expect(fakeProviderConfiguration({ FAKE_PROVIDER_SCENARIO: 'retry' }).script).toEqual({
      getTask: [{ mode: 'failure' }, { mode: 'success' }],
    });
  });

  it('models a permanent provider rejection', () => {
    expect(fakeProviderConfiguration({ FAKE_PROVIDER_SCENARIO: 'permanent' }).script).toEqual({
      submitCreateInstance: [
        {
          mode: 'failure',
          failureCode: 'FAKE_IMAGE_REJECTED',
          failureCategory: FailureCategory.FAILURE_CATEGORY_VALIDATION,
        },
      ],
    });
  });

  it('models an applied mutation whose response is lost', () => {
    expect(fakeProviderConfiguration({ FAKE_PROVIDER_SCENARIO: 'ambiguous' }).script).toEqual({
      submitCreateInstance: [{ mode: 'timeout', applyBeforeResponse: true }],
    });
  });

  it('rejects ungoverned scenario values', () => {
    expect(() => fakeProviderConfiguration({ FAKE_PROVIDER_SCENARIO: 'random-chaos' })).toThrow(
      'FAKE_PROVIDER_SCENARIO must be one of',
    );
  });
});

describe('adapter selection', () => {
  /** Restores the environment, so one case cannot leak configuration into the next. */
  function withEnvironment<T>(values: Record<string, string | undefined>, body: () => T): T {
    const previous = { ...process.env };
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return body();
    } finally {
      process.env = previous;
    }
  }

  it('defaults to the fake, so reaching real hardware is always deliberate', () => {
    withEnvironment({ PROVIDER_ADAPTER: undefined }, () => {
      expect(createProvider()).toBeInstanceOf(FakeProvider);
    });
  });

  it('rejects an adapter it does not know, naming the three it does', () => {
    withEnvironment({ PROVIDER_ADAPTER: 'aws' }, () => {
      expect(() => createProvider()).toThrow(/fake, proxmox, or terraform/);
    });
  });

  it('refuses to start the Terraform adapter with any setting missing', () => {
    // Every one of these is mandatory and has no default. A default binary path, module path or
    // state connection string would let a partially-configured process act on the wrong machine
    // or write to the wrong state — the same rule the direct adapter's settings follow.
    const complete: Record<string, string> = {
      PROVIDER_ADAPTER: 'terraform',
      TERRAFORM_BINARY: '/usr/bin/terraform',
      TERRAFORM_MODULE_PATH: '/modules/instance',
      TERRAFORM_PURGE_MODULE_PATH: '/modules/instance-purge',
      TERRAFORM_WORKING_ROOT: '/tmp/workspaces',
      TERRAFORM_STATE_CONN_STR: 'postgresql://runner@localhost/state',
      DATABASE_URL: 'postgresql://app@localhost/control',
      PROXMOX_PROVIDER_PROFILE_ID: 'proxmox-testsrv',
      PROXMOX_PROJECT_ID: '00000000-0000-4000-8000-0000000000a1',
      PROXMOX_NODE: 'proxtest',
      PROXMOX_TEMPLATE_VMID: '110',
      PROXMOX_IMAGE_ID: 'ubuntu-noble-2404',
      PROXMOX_STORAGE: 'local',
      PROXMOX_DISK_INTERFACE: 'scsi0',
      PROXMOX_BRIDGE: 'vmbr1',
      PROXMOX_NETWORK_MTU: '1400',
      PROXMOX_NETWORK_ID: 'testsrv-vmbr1',
      PROXMOX_IPV4_CIDR: '192.168.4.0/22',
      PROXMOX_IPV4_GATEWAY: '192.168.4.1',
      PROXMOX_DNS_DOMAIN: 'lab.invalid',
      PROXMOX_CLOUD_INIT_USER: 'ubuntu',
      PROXMOX_CLOUD_INIT_PASSWORD: 'example',
      PROXMOX_VMID_MINIMUM: '910000',
      PROXMOX_VMID_MAXIMUM: '910099',
    };

    for (const omitted of Object.keys(complete).filter((key) => key !== 'PROVIDER_ADAPTER')) {
      withEnvironment({ ...complete, [omitted]: undefined }, () => {
        expect(() => createProvider(), `omitting ${omitted} should refuse`).toThrow();
      });
    }
  });

  it('reports the configured profile for the Terraform adapter', () => {
    withEnvironment(
      { PROVIDER_ADAPTER: 'terraform', PROXMOX_PROVIDER_PROFILE_ID: 'proxmox-testsrv' },
      () => {
        // The readiness probe needs this, because getCapabilities asserts the caller named it.
        expect(providerProfileId()).toBe('proxmox-testsrv');
      },
    );
  });

  it('reports no profile under the fake', () => {
    withEnvironment({ PROVIDER_ADAPTER: undefined }, () => {
      expect(providerProfileId()).toBeUndefined();
    });
  });
});
