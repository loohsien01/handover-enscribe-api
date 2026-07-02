import { pgQueryOne, isPgUniqueViolation } from '../utils/pgQueryHelpers.js';
import { querySupabasePostgres } from '../utils/supabasePostgresPool.js';

/**
 * Ensure the user has a personal organization and owner membership (idempotent).
 * Uses service-role pg pool — call only from trusted server paths.
 *
 * @param {string} userId - auth.users.id
 * @param {{ name?: string }} [opts]
 * @returns {Promise<{ organizationId: string, created: boolean }>}
 */
export async function ensurePersonalOrganization(userId, opts = {}) {
  const displayName = (opts.name && String(opts.name).trim()) || 'Personal';

  const existing = await pgQueryOne(
    `SELECT id
       FROM public.organizations
      WHERE personal_owner_user_id = $1
        AND type = 'personal'
      LIMIT 1`,
    [userId]
  );

  if (existing?.id) {
    return { organizationId: String(existing.id), created: false };
  }

  let orgId;
  try {
    const org = await pgQueryOne(
      `INSERT INTO public.organizations (name, type, personal_owner_user_id)
       VALUES ($1, 'personal', $2)
       RETURNING id`,
      [displayName, userId]
    );
    if (!org?.id) throw new Error('organizations insert returned no id');
    orgId = String(org.id);
  } catch (insErr) {
    if (isPgUniqueViolation(insErr)) {
      const again = await pgQueryOne(
        `SELECT id
           FROM public.organizations
          WHERE personal_owner_user_id = $1
            AND type = 'personal'
          LIMIT 1`,
        [userId]
      );
      if (again?.id) return { organizationId: String(again.id), created: false };
    }
    console.error('[personalOrganization] insert org:', insErr);
    throw insErr;
  }

  try {
    await querySupabasePostgres(
      `INSERT INTO public.organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [orgId, userId]
    );
  } catch (memErr) {
    if (isPgUniqueViolation(memErr)) {
      return { organizationId: orgId, created: false };
    }
    console.error('[personalOrganization] insert member:', memErr);
    throw memErr;
  }

  return { organizationId: orgId, created: true };
}

/**
 * @param {string} userId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function loadPersonalOrganizationForUser(userId) {
  return pgQueryOne(
    `SELECT *
       FROM public.organizations
      WHERE personal_owner_user_id = $1
        AND type = 'personal'
      LIMIT 1`,
    [userId]
  );
}

/**
 * @param {string} organizationId
 * @param {string} userId
 * @returns {Promise<{ role: string } | null>}
 */
export async function loadOrganizationMemberRole(organizationId, userId) {
  return pgQueryOne(
    `SELECT role
       FROM public.organization_members
      WHERE organization_id = $1
        AND user_id = $2
      LIMIT 1`,
    [organizationId, userId]
  );
}

/**
 * @param {string} userId
 * @returns {Promise<{ org: Record<string, unknown> | null, member: { role: string } | null, error?: unknown }>}
 */
export async function loadPersonalOrgAndMembership(userId) {
  try {
    const org = await loadPersonalOrganizationForUser(userId);
    if (!org) {
      return { org: null, member: null };
    }

    const member = await loadOrganizationMemberRole(String(org.id), userId);
    return { org, member };
  } catch (error) {
    console.error('[personalOrganization] loadPersonalOrgAndMembership:', error);
    return { error };
  }
}
