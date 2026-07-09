/**
 * Atomic sign-up Postgres bundle: auth.users stub (RDS) + userProfiles insert in one transaction.
 */
import { getSupabasePostgresPool, querySupabasePostgres } from './supabasePostgresPool.js';
import { isRdsPostgresTarget } from './postgresConnection.js';
import { profileDbErrorToHttp } from '../fastify/controllers/userProfileController.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const userProfileTable = '"userProfiles"';

const INSERT_AUTH_USERS_SQL = `
  INSERT INTO auth.users (id, email)
  VALUES ($1::uuid, $2)
  ON CONFLICT (id) DO NOTHING
`;

/**
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {string} email
 * @param {string} username
 * @param {string} specialty
 * @returns {Promise<{ ok: true, data: object, created: true } | { ok: false, status: number, payload: object }>}
 */
async function insertSignupBundleInTransaction(client, userId, email, username, specialty) {
  if (isRdsPostgresTarget()) {
    await client.query(INSERT_AUTH_USERS_SQL, [userId, email]);
  }

  const { rows } = await client.query(
    `INSERT INTO public.${userProfileTable} (user_id, username, specialty)
     VALUES ($1::uuid, $2, $3)
     RETURNING *`,
    [userId, username, specialty]
  );

  const data = rows[0];
  if (!data) {
    return {
      ok: false,
      status: 500,
      payload: { error: 'Failed to save profile' },
    };
  }

  return { ok: true, data, created: true };
}

/**
 * Insert auth.users stub (RDS) and userProfiles row atomically.
 * @param {{ userId: string, email: string, userProfile: { username: string, specialty: string } }} params
 */
export async function writeSignupPostgresBundle({ userId, email, userProfile }) {
  const pool = getSupabasePostgresPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await insertSignupBundleInTransaction(
      client,
      userId,
      email,
      userProfile.username,
      userProfile.specialty
    );
    if (!result.ok) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    const { status, payload } = profileDbErrorToHttp(error);
    return { ok: false, status, payload };
  } finally {
    client.release();
  }
}

/**
 * Best-effort cleanup after a failed sign-up (profile first, then auth.users stub).
 * @param {string} userId
 * @param {{ query?: typeof querySupabasePostgres; isRdsTarget?: () => boolean }} [deps]
 */
export async function rollbackSignupPostgresBundle(userId, deps = {}) {
  if (!userId) return { ok: true };

  const query = deps.query ?? querySupabasePostgres;
  const isRdsTarget = deps.isRdsTarget ?? isRdsPostgresTarget;

  try {
    await query(
      `DELETE FROM public.${userProfileTable} WHERE user_id = $1::uuid`,
      [userId]
    );
    if (isRdsTarget()) {
      await query('DELETE FROM auth.users WHERE id = $1::uuid', [userId]);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rollbackSignupPostgresBundle] Failed:', message);
    return { ok: false, error: message };
  }
}

/**
 * Link Cognito sub after DB-first sign-up (RDS only).
 * @param {string} userId
 * @param {string} email
 * @param {string} cognitoSub
 * @param {{ query?: typeof querySupabasePostgres; isRdsTarget?: () => boolean }} [deps]
 */
export async function updateAuthUsersCognitoSub(userId, email, cognitoSub, deps = {}) {
  const query = deps.query ?? querySupabasePostgres;
  const isRdsTarget = deps.isRdsTarget ?? isRdsPostgresTarget;

  if (!isRdsTarget() || !cognitoSub) {
    return { ok: true, skipped: true };
  }

  try {
    const { rowCount } = await query(
      `UPDATE auth.users
          SET cognito_sub = $3,
              email = $2
        WHERE id = $1::uuid`,
      [userId, email, cognitoSub]
    );
    if (!rowCount) {
      return {
        ok: false,
        error: 'auth.users row not found for cognito_sub update',
      };
    }
    return { ok: true, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[updateAuthUsersCognitoSub] Failed:', message);
    return { ok: false, error: message };
  }
}

/**
 * Compensating delete for Supabase Auth after Postgres bundle failure.
 * @param {string} userId
 */
export async function deleteSupabaseAuthUser(userId) {
  if (!userId) return { ok: true, skipped: true };

  try {
    const admin = supabaseAdmin();
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      console.error('[deleteSupabaseAuthUser] Failed:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[deleteSupabaseAuthUser] Error:', message);
    return { ok: false, error: message };
  }
}
