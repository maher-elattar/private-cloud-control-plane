import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const migrationDirectory = resolve('db/migrations');
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (migrationNames.length === 0) throw new Error('No database migrations were found.');

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('private-cloud-control-plane:migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await client.query('SELECT name, checksum FROM public.schema_migrations');
  const appliedByName = new Map(applied.rows.map((row) => [row.name, row.checksum]));

  // Phase 3 originally had a single untracked migration. Adopt an existing Phase 3 database
  // instead of trying to recreate its tables, then manage every later migration normally.
  if (appliedByName.size === 0) {
    const existing = await client.query("SELECT to_regclass('control.projects') AS table_name");
    if (existing.rows[0]?.table_name) {
      const baselineName = migrationNames[0];
      if (baselineName !== '0001_phase3.sql') {
        throw new Error('An existing database can only be adopted from the Phase 3 baseline.');
      }
      const baseline = await readFile(resolve(migrationDirectory, baselineName), 'utf8');
      const checksum = createHash('sha256').update(baseline).digest('hex');
      await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [
        baselineName,
        checksum,
      ]);
      appliedByName.set(baselineName, checksum);
      console.log(`Adopted existing ${baselineName}`);
    }
  }

  for (const name of migrationNames) {
    const source = await readFile(resolve(migrationDirectory, name), 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const previousChecksum = appliedByName.get(name);
    if (previousChecksum) {
      if (previousChecksum !== checksum) {
        throw new Error(`Applied migration ${name} has changed.`);
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(source);
      await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
      await client.query('COMMIT');
      console.log(`Applied db/migrations/${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query(
    "SELECT pg_advisory_unlock(hashtext('private-cloud-control-plane:migrations'))",
  );
  client.release();
  await pool.end();
}
