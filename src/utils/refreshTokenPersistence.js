/**
 * Refresh token rows in public."refreshTokens" — service-role DB access via pg pool.
 */
import { pgQueryOne } from './pgQueryHelpers.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';

const refreshTokensTable = '"refreshTokens"';

/**
 * @param {{
 *   id: string,
 *   user_id: string,
 *   token_hash: string,
 *   token_enc: string,
 *   issued_at: string,
 *   last_activity_at: string,
 *   expires_at: string,
 *   revoked?: boolean,
 * }} row
 */
export async function insertRefreshTokenRow(row) {
  await querySupabasePostgres(
    `INSERT INTO public.${refreshTokensTable} (
       id, user_id, token_hash, token_enc, issued_at, last_activity_at, expires_at, revoked
     ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8)`,
    [
      row.id,
      row.user_id,
      row.token_hash,
      row.token_enc,
      row.issued_at,
      row.last_activity_at,
      row.expires_at,
      row.revoked ?? false,
    ]
  );
}

/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function findRefreshTokenById(id) {
  return pgQueryOne(
    `SELECT *
       FROM public.${refreshTokensTable}
      WHERE id = $1
      LIMIT 1`,
    [id]
  );
}

/**
 * @param {string} id
 * @param {{ revoked?: boolean, last_activity_at?: string }} [patch]
 */
export async function updateRefreshTokenById(id, patch = {}) {
  const sets = [];
  const params = [id];
  let idx = 2;

  if (patch.revoked !== undefined) {
    sets.push(`revoked = $${idx++}`);
    params.push(patch.revoked);
  }
  if (patch.last_activity_at !== undefined) {
    sets.push(`last_activity_at = $${idx++}::timestamptz`);
    params.push(patch.last_activity_at);
  }

  if (sets.length === 0) return;

  await querySupabasePostgres(
    `UPDATE public.${refreshTokensTable}
        SET ${sets.join(', ')}
      WHERE id = $1`,
    params
  );
}

/** @param {string} id */
export async function revokeRefreshTokenById(id) {
  await updateRefreshTokenById(id, { revoked: true });
}
