/**
 * Opaque keyset cursors for the read projections and catalog tables.
 *
 * PATTERN — Keyset (seek) pagination. Every paginated read orders by a sort key plus its
 * primary key, and the cursor carries the last row of the previous page rather than a row
 * offset. `OFFSET` would re-scan the skipped rows on every request and, worse, silently skip
 * or repeat rows whenever a projection is updated between two pages — which for these tables
 * is the normal case, not an edge case.
 *
 * The encoding is deliberately opaque: the OpenAPI `Cursor` parameter documents that callers
 * must not parse it, so the wire form stays free to change.
 *
 * @see docs/contracts/rest-api.md
 */
import { DomainError } from '@private-cloud/domain';

/** Current cursor payload version. A future shape change increments this and rejects the old one. */
const CURSOR_VERSION = 1;

/** Contract bound from the OpenAPI `Cursor` parameter. */
const MAXIMUM_CURSOR_LENGTH = 512;

/** Bound on each decoded component, so a crafted cursor cannot force a large comparison. */
const MAXIMUM_COMPONENT_LENGTH = 128;

/**
 * Position of the last row on a page.
 *
 * `sortKey` is whatever the query orders by first — an ISO timestamp for the
 * most-recently-updated projections, or the identifier itself for the identifier-ordered
 * catalog tables. `id` is the primary key, present only as a tiebreaker: without it two rows
 * sharing a timestamp make the order non-deterministic and pagination can loop.
 */
export interface PageCursor {
  /** Leading sort value of the last row returned. */
  readonly sortKey: string;
  /** Primary key of that same row, breaking ties on `sortKey`. */
  readonly id: string;
}

/**
 * Encodes a page position into the opaque cursor returned as `page.nextCursor`.
 *
 * @param position Sort key and primary key of the last row on the page just returned.
 * @returns A base64url token the caller passes back verbatim.
 */
export function encodePageCursor(position: PageCursor): string {
  const payload = JSON.stringify({ v: CURSOR_VERSION, s: position.sortKey, i: position.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes a caller-supplied cursor.
 *
 * WHY: a malformed cursor is rejected rather than ignored. Silently restarting from the first
 * page would let a client that corrupts its cursor loop over page one forever while believing
 * it is making progress — a far harder failure to diagnose than a 400.
 *
 * @param cursor The opaque token from a previous `page.nextCursor`.
 * @returns The decoded page position.
 * @throws DomainError `VALIDATION_FAILED` if the cursor is not a token this service issued.
 */
export function decodePageCursor(cursor: string): PageCursor {
  if (cursor.length === 0 || cursor.length > MAXIMUM_CURSOR_LENGTH) throw invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const candidate = parsed as Record<string, unknown>;
  if (candidate['v'] !== CURSOR_VERSION) throw invalidCursor();
  const sortKey = candidate['s'];
  const id = candidate['i'];
  if (!isComponent(sortKey) || !isComponent(id)) throw invalidCursor();
  return { sortKey, id };
}

/**
 * Trims an over-fetched result set to the page size and derives the following cursor.
 *
 * Callers query `limit + 1` rows. A full extra row proves at least one more row exists, which
 * is the only way to know whether to emit a cursor without a second count query — and it means
 * the last page never carries a dangling cursor that returns nothing.
 *
 * @param rows Up to `limit + 1` rows in query order.
 * @param limit The page size requested by the caller.
 * @param position Extracts the sort key and primary key from a row.
 * @returns The rows to return and the cursor for the next page, or `null` on the last page.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  position: (row: T) => PageCursor,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last === undefined ? null : encodePageCursor(position(last)),
  };
}

/** Bounded, non-empty string check applied to both decoded components. */
function isComponent(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAXIMUM_COMPONENT_LENGTH;
}

/** Single rejection so no branch leaks which part of the cursor failed. */
function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', 'The pagination cursor is not valid.');
}
