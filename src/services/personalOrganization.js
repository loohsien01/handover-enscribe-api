import { supabaseAdmin } from '../utils/supabaseAdmin.js';

/**
 * Ensure the user has a personal organization and owner membership (idempotent).
 * Uses service role — call only from trusted server paths.
 *
 * @param {string} userId - auth.users.id
 * @param {{ name?: string }} [opts]
 * @returns {Promise<{ organizationId: string, created: boolean }>}
 */
export async function ensurePersonalOrganization(userId, opts = {}) {
  const admin = supabaseAdmin();
  const displayName = (opts.name && String(opts.name).trim()) || 'Personal';

  const { data: existing, error: findErr } = await admin
    .from('organizations')
    .select('id')
    .eq('personal_owner_user_id', userId)
    .eq('type', 'personal')
    .maybeSingle();

  if (findErr) {
    console.error('[personalOrganization] find existing:', findErr);
    throw findErr;
  }
  if (existing?.id) {
    return { organizationId: existing.id, created: false };
  }

  const { data: org, error: insErr } = await admin
    .from('organizations')
    .insert({
      name: displayName,
      type: 'personal',
      personal_owner_user_id: userId,
    })
    .select('id')
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      const { data: again, error: againErr } = await admin
        .from('organizations')
        .select('id')
        .eq('personal_owner_user_id', userId)
        .eq('type', 'personal')
        .maybeSingle();
      if (againErr) throw againErr;
      if (again?.id) return { organizationId: again.id, created: false };
    }
    console.error('[personalOrganization] insert org:', insErr);
    throw insErr;
  }

  const { error: memErr } = await admin.from('organization_members').insert({
    organization_id: org.id,
    user_id: userId,
    role: 'owner',
  });

  if (memErr) {
    if (memErr.code === '23505') {
      return { organizationId: org.id, created: false };
    }
    console.error('[personalOrganization] insert member:', memErr);
    throw memErr;
  }

  return { organizationId: org.id, created: true };
}
