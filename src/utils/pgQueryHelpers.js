/**
 * Small helpers for controller SQL via `querySupabasePostgres`.
 * The pool connects as a service DB user (bypasses RLS) — callers must filter by user_id.
 */
import { querySupabasePostgres } from './supabasePostgresPool.js';

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function pgQueryOne(text, params = []) {
  const { rows } = await querySupabasePostgres(text, params);
  return rows[0] ?? null;
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function pgQueryRows(text, params = []) {
  const { rows } = await querySupabasePostgres(text, params);
  return rows;
}

/**
 * Serialize a value for Postgres `jsonb` query parameters via node-pg.
 * Do not pass raw JS arrays/objects — pg treats them as PostgreSQL arrays, not JSON.
 * @param {unknown} value
 * @returns {string | null}
 */
export function toPgJsonbParam(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

/**
 * Coerce pg bigint/id columns (string | bigint | number) to a Number for Supabase `.eq()`.
 * @param {unknown} id
 * @returns {number}
 */
export function pgIdToNumber(id) {
  if (typeof id === 'bigint') return Number(id);
  if (typeof id === 'string') return parseInt(id, 10);
  return Number(id);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function pgErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPgUniqueViolation(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === '23505');
}
