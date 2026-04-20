/**
 * Direct Postgres access to the Supabase database (bypasses PostgREST). Uses the same URL
 * resolution as `sql/scripts/apply-psql-migration.mjs` — set `SUPABASE_DB_DIRECT_URL` (or
 * host/password vars in `supabasePostgresUrl.js`).
 */
import pg from 'pg';
import { getSupabasePostgresUrl } from './supabasePostgresUrl.js';

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

/** @returns {pg.Pool} */
export function getSupabasePostgresPool() {
  if (!pool) {
    const connectionString = getSupabasePostgresUrl();
    if (!connectionString) {
      throw new Error(
        'Direct Postgres URL required. Set SUPABASE_DB_DIRECT_URL, DATABASE_URL, ' +
          'SUPABASE_DB_URL, or SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD (see src/utils/supabasePostgresUrl.js).'
      );
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
    });
  }
  return pool;
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function querySupabasePostgres(text, params = []) {
  return getSupabasePostgresPool().query(text, params);
}
