/**
 * Postgres access via `pg` (bypasses PostgREST). Connection string is the same as
 * `sql/scripts/apply-psql-migration.mjs` — typically `SUPABASE_DB_DIRECT_URL` with either the
 * Supabase **transaction pooler** URI (IPv4 / Shared Pooler) or direct `db.*` URI if your network supports it.
 * See `supabasePostgresUrl.js`.
 */
import pg from 'pg';
import { getSupabasePostgresUrl } from './supabasePostgresUrl.js';

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

/**
 * @param {string} connectionString
 * @returns {string}
 */
function extractPgHost(connectionString) {
  const m = /^postgresql:\/\/[^@]+@([^/:?]+)/i.exec(connectionString.trim());
  return m?.[1] ?? '';
}

/**
 * @param {string} host
 */
function isSupabasePostgresHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h.endsWith('.supabase.co') || h.includes('pooler.supabase.com');
}

/**
 * Query `sslmode` / `sslrootcert` from the URI can force certificate verification and override
 * `ssl.rejectUnauthorized: false` in some `pg` + Node combinations. Strip them when relaxing TLS.
 * @param {string} connectionString
 */
function stripSslQueryParams(connectionString) {
  try {
    const normalized = connectionString.trim().replace(/^postgresql:/i, 'postgres:');
    const u = new URL(normalized);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('sslrootcert');
    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out.replace(/^postgres:/i, 'postgresql:');
  } catch {
    return connectionString
      .replace(/([?&])sslmode=[^&]*/gi, '$1')
      .replace(/([?&])sslrootcert=[^&]*/gi, '$1')
      .replace(/\?&+/g, '?')
      .replace(/&+/g, '&')
      .replace(/\?$/g, '');
  }
}

/**
 * Node `pg` + Supabase often hits "self-signed certificate in certificate chain" unless TLS
 * verification is relaxed for their endpoints.
 *
 * - `SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=true` — verify server cert (strict).
 * - `SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=false` — do not verify.
 * - unset + host looks like Supabase (`*.supabase.co` or `*.pooler.supabase.com`) — do not verify (default).
 * - unset otherwise — omit `ssl` on the Pool (URI / `sslmode` only).
 *
 * @param {string} connectionString
 * @returns {{ ssl: { rejectUnauthorized: boolean } | undefined; connectionString: string }}
 */
function resolveSslAndConnectionString(connectionString) {
  const raw = process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
  if (raw === 'true' || raw === '1') {
    return { ssl: { rejectUnauthorized: true }, connectionString };
  }
  if (raw === 'false' || raw === '0') {
    return { ssl: { rejectUnauthorized: false }, connectionString: stripSslQueryParams(connectionString) };
  }
  const host = extractPgHost(connectionString);
  if (isSupabasePostgresHost(host)) {
    return { ssl: { rejectUnauthorized: false }, connectionString: stripSslQueryParams(connectionString) };
  }
  return { ssl: undefined, connectionString };
}

/** @returns {pg.Pool} */
export function getSupabasePostgresPool() {
  if (!pool) {
    const rawConnectionString = getSupabasePostgresUrl();
    if (!rawConnectionString) {
      throw new Error(
        'Postgres connection URL required. Set SUPABASE_DB_DIRECT_URL, DATABASE_URL, ' +
          'SUPABASE_DB_URL, or SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD (see src/utils/supabasePostgresUrl.js).'
      );
    }
    const { ssl, connectionString } = resolveSslAndConnectionString(rawConnectionString);
    /** @type {ConstructorParameters<typeof Pool>[0]} */
    const poolConfig = {
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
    };
    if (ssl) {
      poolConfig.ssl = ssl;
    }
    pool = new Pool(poolConfig);
  }
  return pool;
}

/**
 * End the pool so the next `querySupabasePostgres` / `getSupabasePostgresPool` builds a new one
 * (e.g. after changing `SUPABASE_DB_DIRECT_URL` without restarting the process).
 * @returns {Promise<void>}
 */
export async function closeSupabasePostgresPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function querySupabasePostgres(text, params = []) {
  return getSupabasePostgresPool().query(text, params);
}
