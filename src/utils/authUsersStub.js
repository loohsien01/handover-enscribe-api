/**
 * RDS cutover: minimal `auth.users` registry row after Supabase Auth sign-up (Option A in RDS_POSTGRES_MIGRATION.md).
 * Gated — no-op until Postgres URL targets RDS (`*.rds.amazonaws.com`).
 */
import { isRdsPostgresTarget } from './postgresConnection.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';

const INSERT_SQL = `
  INSERT INTO auth.users (id, email)
  VALUES ($1::uuid, $2)
  ON CONFLICT (id) DO NOTHING
`;

/**
 * @param {string} userId
 * @param {string} email
 * @param {{ isRdsTarget?: () => boolean; query?: typeof querySupabasePostgres }} [deps]
 * @returns {Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>}
 */
export async function ensureAuthUsersStubAfterSignup(userId, email, deps = {}) {
  if (!userId || !email) {
    return { ok: true, skipped: true, reason: 'missing_fields' };
  }

  const isRdsTarget = deps.isRdsTarget ?? isRdsPostgresTarget;
  if (!isRdsTarget()) {
    return { ok: true, skipped: true, reason: 'not_rds_target' };
  }

  const query = deps.query ?? querySupabasePostgres;

  try {
    await query(INSERT_SQL, [userId, email]);
    return { ok: true, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ensureAuthUsersStubAfterSignup] Failed to insert auth.users stub:', message);
    return { ok: false, error: message };
  }
}
