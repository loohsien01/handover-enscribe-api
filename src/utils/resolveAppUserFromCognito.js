import { pgQueryOne } from './pgQueryHelpers.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';

const SELECT_BY_SUB_SQL = `
  SELECT id::text AS id, email
  FROM auth.users
  WHERE cognito_sub = $1
  LIMIT 1
`;

const SELECT_BY_EMAIL_SQL = `
  SELECT id::text AS id, email, cognito_sub
  FROM auth.users
  WHERE lower(email) = lower($1)
  LIMIT 1
`;

const LINK_COGNITO_SUB_SQL = `
  UPDATE auth.users
  SET cognito_sub = $1
  WHERE id = $2::uuid
    AND cognito_sub IS NULL
`;

/**
 * Map Cognito JWT `sub` to canonical `auth.users.id`.
 * Falls back to email match during migration and links `cognito_sub` when missing.
 *
 * @param {string} cognitoSub
 * @param {string} [emailHint]
 * @param {{ queryOne?: typeof pgQueryOne; query?: typeof querySupabasePostgres }} [deps]
 * @returns {Promise<{ id: string, email: string } | null>}
 */
export async function resolveAppUserFromCognito(cognitoSub, emailHint, deps = {}) {
  if (!cognitoSub) return null;

  const queryOne = deps.queryOne ?? pgQueryOne;
  const query = deps.query ?? querySupabasePostgres;

  const bySub = await queryOne(SELECT_BY_SUB_SQL, [cognitoSub]);
  if (bySub?.id) {
    return { id: String(bySub.id), email: String(bySub.email) };
  }

  const email = emailHint?.trim();
  if (!email) return null;

  const byEmail = await queryOne(SELECT_BY_EMAIL_SQL, [email]);
  if (!byEmail?.id) return null;

  if (!byEmail.cognito_sub) {
    try {
      await query(LINK_COGNITO_SUB_SQL, [cognitoSub, byEmail.id]);
    } catch (err) {
      console.error('[resolveAppUserFromCognito] Failed to link cognito_sub:', err);
    }
  }

  return { id: String(byEmail.id), email: String(byEmail.email) };
}
