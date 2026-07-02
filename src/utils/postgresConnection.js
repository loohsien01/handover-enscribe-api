/**
 * Shared Postgres connection helpers: host detection, RDS vs Supabase TLS policy.
 * Used by `supabasePostgresPool.js` and gated RDS-only paths (e.g. signup `auth.users` stub).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSupabasePostgresUrl } from './supabasePostgresUrl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Bundled Amazon RDS global CA (see docs/RDS_POSTGRES_MIGRATION.md Part 3). */
const DEFAULT_RDS_CA_BUNDLE_PATH = path.join(__dirname, '../../certs/rds-global-bundle.crt');

/** @type {string | null} */
let cachedRdsCaBundle = null;

/**
 * @param {string} connectionString
 * @returns {string}
 */
export function extractPgHost(connectionString) {
  const m = /^postgresql:\/\/[^@]+@([^/:?]+)/i.exec(connectionString.trim());
  return m?.[1] ?? '';
}

/**
 * @param {string} host
 */
export function isSupabasePostgresHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h.endsWith('.supabase.co') || h.includes('pooler.supabase.com');
}

/**
 * @param {string} host
 */
export function isRdsPostgresHost(host) {
  if (!host) return false;
  return host.toLowerCase().endsWith('.rds.amazonaws.com');
}

/**
 * @param {string} host
 */
export function isLocalPostgresTunnelHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost';
}

/**
 * True when `DATABASE_URL` points at RDS (canonical prod URI, not the tunnel override).
 */
export function isCanonicalDatabaseUrlRds() {
  const canonical = process.env.DATABASE_URL?.trim();
  if (!canonical) return false;
  return isRdsPostgresHost(extractPgHost(canonical));
}

/**
 * Dev laptop: `DATABASE_URL_LOCAL` → `127.0.0.1:15432` while `npm run db:tunnel` forwards to RDS.
 * @param {string} [resolvedHost]
 */
export function isLocalRdsTunnelTarget(resolvedHost) {
  if (process.env.NODE_ENV === 'production') return false;
  if (!process.env.DATABASE_URL_LOCAL?.trim()) return false;
  if (!isCanonicalDatabaseUrlRds()) return false;
  return isLocalPostgresTunnelHost(resolvedHost ?? '');
}

/**
 * Host from the resolved Postgres URL env chain (`getSupabasePostgresUrl`).
 * @returns {string | null}
 */
export function getResolvedPostgresHost() {
  const url = getSupabasePostgresUrl();
  if (!url) return null;
  const host = extractPgHost(url);
  return host || null;
}

/** True when the active Postgres URL targets Amazon RDS (not Supabase). */
export function isRdsPostgresTarget() {
  const host = getResolvedPostgresHost() ?? '';
  if (isRdsPostgresHost(host)) return true;
  return isLocalRdsTunnelTarget(host);
}

/**
 * Query `sslmode` / `sslrootcert` from the URI can force certificate verification and override
 * `ssl.rejectUnauthorized: false` in some `pg` + Node combinations. Strip them when relaxing TLS.
 * @param {string} connectionString
 */
export function stripSslQueryParams(connectionString) {
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
 * @returns {string}
 */
function loadRdsCaBundle() {
  if (cachedRdsCaBundle) return cachedRdsCaBundle;
  const caPath =
    (typeof process.env.RDS_CA_BUNDLE_PATH === 'string' && process.env.RDS_CA_BUNDLE_PATH.trim()) ||
    (typeof process.env.DATABASE_SSL_CA_PATH === 'string' && process.env.DATABASE_SSL_CA_PATH.trim()) ||
    DEFAULT_RDS_CA_BUNDLE_PATH;
  cachedRdsCaBundle = fs.readFileSync(caPath, 'utf8');
  return cachedRdsCaBundle;
}

/** @param {string | null | undefined} caPath */
export function resetRdsCaBundleCacheForTests(caPath = null) {
  cachedRdsCaBundle = caPath;
}

/**
 * RDS hostname from canonical `DATABASE_URL` (for TLS SNI through SSH tunnel).
 * @returns {string | null}
 */
function getCanonicalRdsHostname() {
  const canonical = process.env.DATABASE_URL?.trim();
  if (!canonical) return null;
  const host = extractPgHost(canonical);
  return isRdsPostgresHost(host) ? host : null;
}

/**
 * TLS policy for Node `pg`:
 * - RDS (`*.rds.amazonaws.com`): strict verify + bundled RDS CA (override with `SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=false`).
 * - Local SSH tunnel (`DATABASE_URL_LOCAL` → localhost): same CA + **servername** = RDS host (cert altname).
 * - Supabase: relaxed verify by default (pooler cert chain).
 * - Explicit env overrides apply where documented below.
 *
 * @param {string} connectionString
 * @returns {{ ssl: { rejectUnauthorized: boolean; ca?: string; servername?: string } | undefined; connectionString: string }}
 */
export function resolveSslAndConnectionString(connectionString) {
  const raw = process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
  const host = extractPgHost(connectionString);

  if (raw === 'false' || raw === '0') {
    return { ssl: { rejectUnauthorized: false }, connectionString: stripSslQueryParams(connectionString) };
  }

  if (isRdsPostgresHost(host) || isLocalRdsTunnelTarget(host)) {
    /** @type {{ rejectUnauthorized: boolean; ca: string; servername?: string }} */
    const ssl = {
      rejectUnauthorized: true,
      ca: loadRdsCaBundle(),
    };
    if (isLocalRdsTunnelTarget(host)) {
      const rdsHostname = getCanonicalRdsHostname();
      if (rdsHostname) {
        ssl.servername = rdsHostname;
      }
    }
    return {
      ssl,
      connectionString: stripSslQueryParams(connectionString),
    };
  }

  if (raw === 'true' || raw === '1') {
    return { ssl: { rejectUnauthorized: true }, connectionString };
  }

  if (isSupabasePostgresHost(host)) {
    return { ssl: { rejectUnauthorized: false }, connectionString: stripSslQueryParams(connectionString) };
  }

  return { ssl: undefined, connectionString };
}
