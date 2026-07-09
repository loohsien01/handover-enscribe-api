import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import {
  ensurePersonalOrganization,
} from '../../services/personalOrganization.js';
import { pgQueryOne, pgErrorMessage } from '../../utils/pgQueryHelpers.js';
import { querySupabasePostgres } from '../../utils/supabasePostgresPool.js';
import { isCognitoAuth } from '../../utils/authProvider.js';

const userProfileTable = '"userProfiles"';

export const USERNAME_TAKEN_PAYLOAD = {
  error: 'This username is already taken',
  code: 'USERNAME_TAKEN',
};

/**
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export async function isUsernameTaken(username) {
  const row = await pgQueryOne(
    `SELECT 1 AS taken FROM public.${userProfileTable} WHERE username = $1 LIMIT 1`,
    [username]
  );
  return Boolean(row);
}

/**
 * Verify auth.users row exists (handles rare races after JWT issue).
 * @param {string} userId
 * @returns {{ ok: true } | { ok: false, replyPayload: { error: string, code: string } }}
 */
export async function ensureAuthUserExists(userId) {
  try {
    if (isCognitoAuth()) {
      const row = await pgQueryOne(
        'SELECT 1 AS ok FROM auth.users WHERE id = $1::uuid LIMIT 1',
        [userId]
      );
      if (!row) {
        return {
          ok: false,
          replyPayload: {
            error: 'Account not found or no longer available',
            code: 'AUTH_USER_NOT_FOUND',
          },
        };
      }
      return { ok: true };
    }

    const admin = supabaseAdmin();
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      return {
        ok: false,
        replyPayload: {
          error: 'Account not found or no longer available',
          code: 'AUTH_USER_NOT_FOUND',
        },
      };
    }
    return { ok: true };
  } catch (err) {
    console.error('[userProfile] ensureAuthUserExists:', err);
    return {
      ok: false,
      replyPayload: {
        error: 'Unable to verify account',
        code: 'AUTH_USER_CHECK_FAILED',
      },
    };
  }
}

/**
 * Map common Postgres errors to status + JSON body
 * @returns {{ status: number, payload: object }}
 */
export function profileDbErrorToHttp(error) {
  if (!error?.code) {
    return { status: 500, payload: { error: 'Database operation failed' } };
  }
  if (error.code === '23505') {
    return {
      status: 409,
      payload: { ...USERNAME_TAKEN_PAYLOAD },
    };
  }
  if (error.code === '23503') {
    return {
      status: 422,
      payload: {
        error: 'Account could not be linked; try again or contact support',
        code: 'FOREIGN_KEY_VIOLATION',
      },
    };
  }
  console.error('[userProfile] Unhandled DB error:', error);
  return { status: 500, payload: { error: 'Database operation failed' } };
}

function mapProfileDbError(error, reply) {
  const { status, payload } = profileDbErrorToHttp(error);
  return reply.status(status).send(payload);
}

/**
 * Insert or update the profile row for user_id (one row per user).
 * @param {string} userId
 * @param {{ username: string, specialty: string }} fields
 * @returns {Promise<{ ok: true, data: object, created: boolean } | { ok: false, status: number, payload: object }>}
 */
export async function upsertUserProfileForUser(userId, fields) {
  const { username, specialty } = fields;

  try {
    const existing = await pgQueryOne(
      `SELECT id FROM public.${userProfileTable} WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (existing) {
      const data = await pgQueryOne(
        `UPDATE public.${userProfileTable}
            SET username = $2, specialty = $3
          WHERE user_id = $1
          RETURNING *`,
        [userId, username, specialty]
      );
      if (!data) {
        return {
          ok: false,
          status: 500,
          payload: { error: 'Failed to save profile' },
        };
      }
      return { ok: true, data, created: false };
    }

    const data = await pgQueryOne(
      `INSERT INTO public.${userProfileTable} (user_id, username, specialty)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, username, specialty]
    );

    if (!data) {
      return {
        ok: false,
        status: 500,
        payload: { error: 'Failed to save profile' },
      };
    }
    return { ok: true, data, created: true };
  } catch (error) {
    const { status, payload } = profileDbErrorToHttp(error);
    return { ok: false, status, payload };
  }
}

/**
 * GET /api/user-profile
 */
export async function getUserProfile(request, reply) {
  try {
    const userId = request.user.id;

    const data = await pgQueryOne(
      `SELECT * FROM public.${userProfileTable} WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Profile not found' });
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('[userProfile] GET:', pgErrorMessage(err));
    return reply.status(500).send({ error: 'Failed to fetch profile' });
  }
}

/**
 * POST /api/user-profile
 * Creates a row or updates the existing row for this user (one profile per user_id).
 */
export async function createOrUpdateUserProfile(request, reply) {
  try {
    const userId = request.user.id;
    const { username, specialty } = request.body;

    const authCheck = await ensureAuthUserExists(userId);
    if (!authCheck.ok) {
      return reply.status(422).send(authCheck.replyPayload);
    }

    const result = await upsertUserProfileForUser(userId, {
      username,
      specialty,
    });
    if (!result.ok) {
      return reply.status(result.status).send(result.payload);
    }
    if (result.created) {
      try {
        await ensurePersonalOrganization(userId, { name: username });
      } catch (orgErr) {
        console.error('[userProfile] ensurePersonalOrganization:', orgErr);
      }
    }
    return reply.status(result.created ? 201 : 200).send(result.data);
  } catch (err) {
    console.error('[userProfile] POST:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/user-profile
 */
export async function patchUserProfile(request, reply) {
  try {
    const userId = request.user.id;
    const body = request.body;

    const authCheck = await ensureAuthUserExists(userId);
    if (!authCheck.ok) {
      return reply.status(422).send(authCheck.replyPayload);
    }

    const existing = await pgQueryOne(
      `SELECT id FROM public.${userProfileTable} WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (!existing) {
      return reply.status(404).send({ error: 'Profile not found' });
    }

    const patch = {};
    if (body.username !== undefined) patch.username = body.username;
    if (body.specialty !== undefined) patch.specialty = body.specialty;

    if (Object.keys(patch).length === 0) {
      const data = await pgQueryOne(
        `SELECT * FROM public.${userProfileTable} WHERE user_id = $1 LIMIT 1`,
        [userId]
      );
      return reply.status(200).send(data);
    }

    const sets = [];
    const params = [userId];
    let idx = 2;
    if (patch.username !== undefined) {
      sets.push(`username = $${idx++}`);
      params.push(patch.username);
    }
    if (patch.specialty !== undefined) {
      sets.push(`specialty = $${idx++}`);
      params.push(patch.specialty);
    }

    try {
      const data = await pgQueryOne(
        `UPDATE public.${userProfileTable}
            SET ${sets.join(', ')}
          WHERE user_id = $1
          RETURNING *`,
        params
      );
      return reply.status(200).send(data);
    } catch (error) {
      return mapProfileDbError(error, reply);
    }
  } catch (err) {
    console.error('[userProfile] PATCH:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
