import { FailureCategory } from '@private-cloud/contracts';
import { describe, expect, it } from 'vitest';
import { fakeProviderConfiguration } from './provider.factory';

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
