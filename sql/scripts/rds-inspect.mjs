#!/usr/bin/env node
/**
 * Read-only RDS / Postgres inspection — run on EC2 Instance Connect (VPC can reach RDS).
 * For TablePlus on your Mac, use `npm run db:tunnel` instead.
 *
 * Uses DATABASE_URL (or SUPABASE_DB_DIRECT_URL) from .env.local — same resolution as
 * `apply-psql-migration.mjs` and the API pool.
 *
 * Usage (from repo root, e.g. /opt/enscribe-api on EC2):
 *   npm run db:inspect
 *   npm run db:inspect -- summary
 *   npm run db:inspect -- counts
 *   npm run db:inspect -- connection
 *   npm run db:inspect -- tables
 *   npm run db:inspect -- recent-encounters
 *   npm run db:inspect -- recent-users
 *   npm run db:inspect -- cutover-check
 *   npm run db:inspect -- sql/scripts/rds-inspect/table-counts.sql
 *
 * All queries run inside `BEGIN READ ONLY` when possible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getResolvedPostgresHost, isRdsPostgresTarget } from '../../src/utils/postgresConnection.js';
import {
  closeSupabasePostgresPool,
  getSupabasePostgresPool,
} from '../../src/utils/supabasePostgresPool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = path.join(__dirname, 'rds-inspect');

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

/** @type {Record<string, string | string[]>} */
const PRESETS = {
  connection: 'connection.sql',
  tables: 'list-tables.sql',
  counts: 'table-counts.sql',
  'recent-encounters': 'recent-encounters.sql',
  'recent-users': 'recent-users.sql',
  'cutover-check': 'cutover-check.sql',
  summary: ['connection.sql', 'cutover-check.sql', 'recent-encounters.sql', 'recent-users.sql'],
};

function printUsage() {
  console.log(`Read-only Postgres inspection

Usage:
  npm run db:inspect [-- <preset>|<path-to.sql>]

Presets:
  summary             connection + cutover-check + recent rows (default)
  connection          database, user, version, resolved host hint
  tables              tables in public, archive, auth
  counts              estimated row counts (pg_stat_user_tables)
  cutover-check       key table row counts (Part 10 gate)
  recent-encounters   latest patientEncounters
  recent-users        latest auth.users

Custom SQL file (read-only transaction):
  npm run db:inspect -- sql/scripts/rds-inspect/table-counts.sql

Env: DATABASE_URL or SUPABASE_DB_DIRECT_URL in .env.local (see supabasePostgresUrl.js).
Run on EC2 Instance Connect when RDS is VPC-private.`);
}

/**
 * @param {import('pg').QueryResult} result
 */
function printResult(result) {
  if (!result.rows?.length) {
    console.log('(no rows)\n');
    return;
  }
  console.table(result.rows);
  console.log(`(${result.rowCount} row${result.rowCount === 1 ? '' : 's'})\n`);
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} sql
 */
async function runReadOnly(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(sql);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @param {string} filePath
 */
function readSqlFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`SQL file not found: ${abs}`);
  }
  const sql = fs.readFileSync(abs, 'utf8').trim();
  if (!sql) {
    throw new Error(`SQL file is empty: ${abs}`);
  }
  return { abs, sql };
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} label
 * @param {string} sql
 */
async function runLabeled(pool, label, sql) {
  console.log(`── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  const result = await runReadOnly(pool, sql);
  printResult(result);
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} fileName
 */
async function runPresetFile(pool, fileName) {
  const { abs, sql } = readSqlFile(path.join(PRESET_DIR, fileName));
  await runLabeled(pool, path.basename(abs), sql);
}

async function main() {
  const arg = process.argv[2];

  if (arg === '--help' || arg === '-h') {
    printUsage();
    process.exit(0);
  }

  let pool;
  try {
    pool = getSupabasePostgresPool();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    console.error('\nSet DATABASE_URL (RDS) or SUPABASE_DB_DIRECT_URL in .env.local.');
    process.exit(1);
  }

  const host = getResolvedPostgresHost();
  const target = isRdsPostgresTarget() ? 'RDS' : host?.includes('supabase') ? 'Supabase' : 'Postgres';
  console.log(`Target: ${target}${host ? ` (${host})` : ''}`);
  if (!isRdsPostgresTarget()) {
    console.warn('Warning: resolved host is not *.rds.amazonaws.com — showing whichever DB the env points at.\n');
  } else {
    console.log('');
  }

  try {
    if (!arg || arg === 'summary') {
      const files = PRESETS.summary;
      for (const file of files) {
        await runPresetFile(pool, file);
      }
      return;
    }

    if (arg.endsWith('.sql')) {
      const { abs, sql } = readSqlFile(arg);
      await runLabeled(pool, path.basename(abs), sql);
      return;
    }

    const preset = PRESETS[arg];
    if (!preset) {
      console.error(`Unknown preset: ${arg}\n`);
      printUsage();
      process.exit(1);
    }

    if (Array.isArray(preset)) {
      for (const file of preset) {
        await runPresetFile(pool, file);
      }
      return;
    }

    await runPresetFile(pool, preset);
  } finally {
    await closeSupabasePostgresPool().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
