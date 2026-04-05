import { getSupabaseClient } from '../../utils/supabase.js';
import { supabaseAdmin } from '../../utils/supabaseAdmin.js';

const userProfileTable = 'userProfiles';

/**
 * Verify auth.users row exists (handles rare races after JWT issue).
 * @param {string} userId
 * @returns {{ ok: true } | { ok: false, replyPayload: { error: string, code: string } }}
 */
async function ensureAuthUserExists(userId) {
  try {
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
 * Map common Postgres / Supabase errors to status + JSON body
 * @returns {{ status: number, payload: object }}
 */
function profileDbErrorToHttp(error) {
  if (!error?.code) {
    return { status: 500, payload: { error: 'Database operation failed' } };
  }
  if (error.code === '23505') {
    return {
      status: 409,
      payload: {
        error: 'This username is already taken',
        code: 'USERNAME_TAKEN',
      },
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
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {{ username: string, specialty: string }} fields
 * @returns {Promise<{ ok: true, data: object, created: boolean } | { ok: false, status: number, payload: object }>}
 */
export async function upsertUserProfileForUser(supabase, userId, fields) {
  const { username, specialty } = fields;

  const { data: existing, error: fetchError } = await supabase
    .from(userProfileTable)
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchError) {
    console.error('[userProfile] upsert fetch existing:', fetchError);
    return {
      ok: false,
      status: 500,
      payload: { error: 'Failed to save profile' },
    };
  }

  if (existing) {
    const { data, error } = await supabase
      .from(userProfileTable)
      .update({ username, specialty })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      const { status, payload } = profileDbErrorToHttp(error);
      return { ok: false, status, payload };
    }
    return { ok: true, data, created: false };
  }

  const { data, error } = await supabase
    .from(userProfileTable)
    .insert([{ user_id: userId, username, specialty }])
    .select()
    .single();

  if (error) {
    const { status, payload } = profileDbErrorToHttp(error);
    return { ok: false, status, payload };
  }
  return { ok: true, data, created: true };
}

/**
 * GET /api/user-profile
 */
export async function getUserProfile(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const userId = request.user.id;

    const { data, error } = await supabase
      .from(userProfileTable)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[userProfile] GET select error:', error);
      return reply.status(500).send({ error: 'Failed to fetch profile' });
    }

    if (!data) {
      return reply.status(404).send({ error: 'Profile not found' });
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('[userProfile] GET:', err);
    return reply.status(500).send({ error: 'Internal server error' });
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

    const supabase = getSupabaseClient(request.headers.authorization);

    const result = await upsertUserProfileForUser(supabase, userId, {
      username,
      specialty,
    });
    if (!result.ok) {
      return reply.status(result.status).send(result.payload);
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

    const supabase = getSupabaseClient(request.headers.authorization);

    const { data: existing, error: fetchError } = await supabase
      .from(userProfileTable)
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchError) {
      console.error('[userProfile] PATCH fetch:', fetchError);
      return reply.status(500).send({ error: 'Failed to update profile' });
    }

    if (!existing) {
      return reply.status(404).send({ error: 'Profile not found' });
    }

    const patch = {};
    if (body.username !== undefined) patch.username = body.username;
    if (body.specialty !== undefined) patch.specialty = body.specialty;

    const { data, error } = await supabase
      .from(userProfileTable)
      .update(patch)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      return mapProfileDbError(error, reply);
    }
    return reply.status(200).send(data);
  } catch (err) {
    console.error('[userProfile] PATCH:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
