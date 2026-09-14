/**
 * Applies every catalog seed in `db/seeds`, in lexical order.
 *
 * WHY the whole directory rather than one named file: the seeds are additive and ordered, and
 * naming one of them here meant that adding a second — the live server's catalog rows — silently
 * did nothing until this file was also edited. A loader that reads the directory cannot drift out
 * of step with what the directory holds.
 *
 * Seeds are idempotent by construction: `0001` uses `ON CONFLICT DO NOTHING` because it describes
 * fixed test fixtures, and `0002` uses `ON CONFLICT DO UPDATE` because it describes a real server
 * whose measured address occupancy changes. Re-running this is therefore always safe.
 *
 * Each file is applied in its own transaction, which is the seed's own `BEGIN`/`COMMIT`. A later
 * seed failing does not roll back an earlier one, and the failure names the file, so a partially
 * seeded database can be recovered by fixing that file and re-running.
 *
 * Usage:
 *   DATABASE_URL=... node tools/db/seed.mjs
 *   DATABASE_URL=... node tools/db/seed.mjs --only=0001
 *
 * @see db/seeds
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectWhenReady } from './postgres-ready.mjs';

const SEED_DIRECTORY = resolve('db/seeds');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const only = process.argv
  .find((argument) => argument.startsWith('--only='))
  ?.slice('--only='.length);

const files = (await readdir(SEED_DIRECTORY))
  .filter((name) => name.endsWith('.sql'))
  .filter((name) => !only || name.startsWith(only))
  .sort();

if (files.length === 0) {
  throw new Error(only ? `No seed matches --only=${only}.` : 'No seeds found in db/seeds.');
}

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await connectWhenReady(pool);
try {
  for (const name of files) {
    const sql = await readFile(resolve(SEED_DIRECTORY, name), 'utf8');
    try {
      await client.query(sql);
    } catch (error) {
      // Name the file. A bare SQL error against an unnamed statement is unreadable when several
      // seeds are applied in one run.
      throw new Error(
        `db/seeds/${name} failed: ${error instanceof Error ? error.message : error}`,
        {
          cause: error,
        },
      );
    }
    console.log(`Applied db/seeds/${name}`);
  }
} finally {
  client.release();
  await pool.end();
}
