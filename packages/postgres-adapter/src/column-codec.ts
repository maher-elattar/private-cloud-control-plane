/**
 * Shared decoding helpers for PostgreSQL column values.
 *
 * These exist because the three stores in this package all read the same two awkward column
 * shapes, and each previously carried its own private copy of the logic.
 *
 * @see docs/architecture/comment-standard.md
 */

/**
 * Decodes a JSON or JSONB column into its TypeScript shape.
 *
 * WHY the runtime `typeof` check: `pg` decodes `jsonb` columns into JavaScript objects for
 * us, but returns plain `json` columns as raw text. Kysely types both as the object shape, so
 * without this branch a `json` column would flow through as a string and only fail later, at
 * a confusing distance from its cause. Both column types appear in `db/migrations`.
 *
 * The cast is unavoidable — the database cannot prove the document matches `T`. The contract
 * is enforced upstream: every document written to a `jsonb` column is first built as the
 * matching contract type.
 */
export function parseJsonColumn<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/**
 * Normalises a `timestamptz` column to an ISO 8601 string for the API contract.
 *
 * Accepts both `Date` and `string` because Kysely's `ColumnType` for timestamps permits
 * either depending on how the row was produced.
 */
export function toIsoTimestamp(value: Date | string): string {
  return new Date(value).toISOString();
}
