import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const seed = await readFile(resolve('db/seeds/0001_phase3_fake.sql'), 'utf8');
  await pool.query(seed);
  console.log('Applied db/seeds/0001_phase3_fake.sql');
} finally {
  await pool.end();
}
