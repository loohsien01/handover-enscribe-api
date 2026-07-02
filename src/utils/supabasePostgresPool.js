/**
 * Postgres access via `pg` (bypasses PostgREST). Connection string is the same as
 * `sql/scripts/apply-psql-migration.mjs` — typically `SUPABASE_DB_DIRECT_URL` with either the
 * Supabase **transaction pooler** URI (IPv4 / Shared Pooler) or direct `db.*` URI if your network supports it.
 * RDS (`*.rds.amazonaws.com`) uses strict TLS + bundled CA via `postgresConnection.js`.
 * See `supabasePostgresUrl.js`.
 */
import pg from 'pg';
import { getSupabasePostgresUrl } from './supabasePostgresUrl.js';
import { resolveSslAndConnectionString } from './postgresConnection.js';

const { Pool } = pg;

/**
 * Last-resort guard: pg-pool emits `error` on idle clients when the network or Supabase
 * pooler drops TCP (common on macOS as EADDRNOTAVAIL). Without any listener Node exits.
 * Orphan pools (e.g. after hot reload) can miss our handler — swallow only that case.
 */
const originalPoolEmit = Pool.prototype.emit;
Pool.prototype.emit = function poolEmitGuard(event, ...args) {
  if (event === 'error' && this.listenerCount('error') === 0) {
    logIdlePoolClientError(args[0], { orphanPool: true });
    return true;
  }
  return originalPoolEmit.apply(this, args);
};

/** @type {pg.Pool | null} */
let pool = null;

/** Throttle idle-client error logs (network blips / pooler closing sockets). */
let lastPoolErrorLog = 0;

const POOL_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * pg emits `error` on the Pool for idle clients when the server or network drops a connection.
 * Without a listener, Node treats that as an unhandled error and exits the process.
 * @param {pg.Pool} p
 */
/**
 * @param {unknown} err
 * @param {{ orphanPool?: boolean }} [meta]
 */
function logIdlePoolClientError(err, meta = {}) {
  const t = Date.now();
  if (t - lastPoolErrorLog < POOL_ERROR_LOG_INTERVAL_MS) return;
  lastPoolErrorLog = t;
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  const suffix = code ? ` (${code})` : '';
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = meta.orphanPool ? 'Orphan pool' : 'Idle pool';
  console.warn(
    `[supabase-postgres] ${prefix} client error — connection dropped; pool will replace it.${suffix} ${msg}` +
      ' Set SUPABASE_DB_VERBOSE=1 for more detail.'
  );
  if (process.env.SUPABASE_DB_VERBOSE === '1' && err instanceof Error && err.stack) {
    console.warn(err.stack);
  }
}

function attachPoolErrorHandler(p) {
  if (p.listenerCount('error') > 0) return;
  p.on('error', (err) => logIdlePoolClientError(err));
}

/** @returns {pg.Pool} */
export function getSupabasePostgresPool() {
  if (!pool) {
    const rawConnectionString = getSupabasePostgresUrl();
    if (!rawConnectionString) {
      throw new Error(
        'Postgres connection URL required. Set DATABASE_URL_LOCAL (local tunnel), DATABASE_URL, ' +
          'SUPABASE_DB_DIRECT_URL, SUPABASE_DB_URL, or SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD ' +
          '(see src/utils/supabasePostgresUrl.js).'
      );
    }
    const { ssl, connectionString } = resolveSslAndConnectionString(rawConnectionString);
    /** @type {ConstructorParameters<typeof Pool>[0]} */
    const poolConfig = {
      connectionString,
      max: 10,
      // Release idle clients before Supabase pooler / OS tear down stale TCP (EADDRNOTAVAIL on read).
      idleTimeoutMillis: 10_000,
      // Rotate connections periodically so long-lived TLS sessions do not go stale quietly.
      maxLifetimeSeconds: 300,
      connectionTimeoutMillis: 20_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    };
    if (ssl) {
      poolConfig.ssl = ssl;
    }
    pool = new Pool(poolConfig);
    attachPoolErrorHandler(pool);
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

/**
 * Create the pool (and error handler) at process startup so the first idle disconnect
 * cannot occur before `attachPoolErrorHandler` runs.
 * @returns {pg.Pool | null} null when no Postgres URL is configured
 */
export function warmupSupabasePostgresPool() {
  try {
    return getSupabasePostgresPool();
  } catch {
    return null;
  }
}
