import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const migration = await readFile(resolve('db/migrations/0001_phase3.sql'), 'utf8');
  await pool.query(migration);
  console.log('Applied db/migrations/0001_phase3.sql');
} finally {
  await pool.end();
}
