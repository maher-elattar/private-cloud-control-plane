import { describe, expect, it } from 'vitest';
import { activeTraceCarrier, currentTraceFields, extractTransportContext } from './runtime.js';

describe('observability runtime without a registered SDK', () => {
  it('remains a no-op when no span is active', () => {
    expect(currentTraceFields()).toEqual({});
    expect(activeTraceCarrier()).toEqual({});
  });

  it('ignores malformed external W3C context instead of throwing', () => {
    expect(() => extractTransportContext({ traceparent: 'not-a-trace' })).not.toThrow();
  });
});
