import { describe, expect, it } from 'vitest';
import { grpcProject, grpcTimestamp } from './grpc-mappers.js';

describe('gRPC runtime mapping', () => {
  it('converts RFC 3339 timestamps to protobuf wire values', () => {
    expect(grpcTimestamp('2026-08-26T01:44:01.848Z')).toEqual({
      seconds: '1787708641',
      nanos: 848_000_000,
    });
  });

  it('converts every project timestamp at the transport boundary', () => {
    expect(
      grpcProject({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'lab-sandbox',
        enabled: true,
        createdAt: '2026-08-26T01:44:01.848Z',
        updatedAt: '2026-08-26T01:45:02.003Z',
      }),
    ).toMatchObject({
      createdAt: { seconds: '1787708641', nanos: 848_000_000 },
      updatedAt: { seconds: '1787708702', nanos: 3_000_000 },
    });
  });
});
