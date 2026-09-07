import { describe, expect, it } from 'vitest';
import { DomainError } from '@private-cloud/domain';
import { decodePageCursor, encodePageCursor, paginate } from './page-cursor.js';

const position = {
  sortKey: '2026-09-03T10:00:00.000Z',
  id: '20000000-0000-4000-8000-000000000001',
};

describe('page cursor', () => {
  it('round-trips a page position', () => {
    expect(decodePageCursor(encodePageCursor(position))).toEqual(position);
  });

  it('produces a token within the contract length bound', () => {
    // The OpenAPI `Cursor` parameter caps the value at 512 characters.
    expect(encodePageCursor(position).length).toBeLessThanOrEqual(512);
  });

  it('rejects a cursor this service did not issue', () => {
    for (const candidate of [
      '',
      'not-base64url!!',
      Buffer.from('{}', 'utf8').toString('base64url'),
      Buffer.from('[]', 'utf8').toString('base64url'),
      Buffer.from('null', 'utf8').toString('base64url'),
      // A future encoding version must be refused, not silently misread.
      Buffer.from(JSON.stringify({ v: 2, s: 'a', i: 'b' }), 'utf8').toString('base64url'),
      // Both components are required and must be non-empty strings.
      Buffer.from(JSON.stringify({ v: 1, s: 'a' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, s: '', i: 'b' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, s: 'a', i: 7 }), 'utf8').toString('base64url'),
      // A crafted oversized component must not reach a comparison.
      Buffer.from(JSON.stringify({ v: 1, s: 'a'.repeat(200), i: 'b' }), 'utf8').toString(
        'base64url',
      ),
      'x'.repeat(513),
    ]) {
      expect(() => decodePageCursor(candidate)).toThrowError(DomainError);
      expect(() => decodePageCursor(candidate)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });

  it('reports no next cursor when the page is not full', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const result = paginate(rows, 5, (row) => ({ sortKey: row.id, id: row.id }));
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('reports no next cursor when the page is exactly full', () => {
    // WHY this case matters: over-fetching `limit + 1` is what distinguishes a full last page
    // from a page with more behind it. Getting it wrong hands the caller a cursor that returns
    // an empty page, which most clients read as an error rather than as the end.
    const rows = [{ id: 'a' }, { id: 'b' }];
    const result = paginate(rows, 2, (row) => ({ sortKey: row.id, id: row.id }));
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('trims the over-fetched row and points the cursor at the last kept row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = paginate(rows, 2, (row) => ({ sortKey: row.id, id: row.id }));
    expect(result.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(result.nextCursor).not.toBeNull();
    expect(decodePageCursor(result.nextCursor ?? '')).toEqual({ sortKey: 'b', id: 'b' });
  });
});
