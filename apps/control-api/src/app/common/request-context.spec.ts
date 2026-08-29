import { describe, expect, it } from 'vitest';
import { correlationId, requestTraceparent, requestTracestate } from './request-context.js';

describe('request context', () => {
  it('accepts valid caller correlation and trace context', () => {
    expect(correlationId('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(requestTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03',
    );
  });

  it.each([
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
  ])('rejects an invalid traceparent: %s', (value) => {
    expect(() => requestTraceparent(value)).toThrow('Traceparent is invalid.');
  });

  it('accepts bounded tracestate only when traceparent was supplied', () => {
    expect(requestTracestate('vendor=value', 'valid-parent')).toBe('vendor=value');
    expect(() => requestTracestate('vendor=value', undefined)).toThrow(
      'Tracestate requires a traceparent header.',
    );
    expect(() => requestTracestate(`vendor=${'x'.repeat(513)}`, 'valid-parent')).toThrow(
      'Tracestate is invalid.',
    );
  });
});
