#!/usr/bin/env node
/**
 * Apply a SQL file with psql using a DB URL from .env.local.
 *
 * URL resolution (see src/utils/supabasePostgresUrl.js):
 * - SUPABASE_DB_DIRECT_URL, DATABASE_URL, or SUPABASE_DB_URL (full postgresql://…), or
 * - SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD (+ optional port/user/db/sslmode).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getSupabasePostgresUrl } from '../../src/utils/supabasePostgresUrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node sql/scripts/apply-psql-migration.mjs <path-to.sql>');
  process.exit(1);
}

const dbUrl = getSupabasePostgresUrl();

if (!dbUrl) {
  console.error(
    'Missing database URL. Set one of:\n' +
      '  SUPABASE_DB_DIRECT_URL / DATABASE_URL / SUPABASE_DB_URL (postgresql://…), or\n' +
      '  SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD and optional SUPABASE_DB_PORT (default 5432),\n' +
      '  SUPABASE_DB_USER (default postgres), SUPABASE_DB_NAME (default postgres), SUPABASE_DB_SSLMODE (default require).'
  );
  process.exit(1);
}

const abs = path.resolve(process.cwd(), sqlFile);
const r = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', abs], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
