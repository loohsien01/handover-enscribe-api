import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import { ensurePersonalOrganization } from '../../services/personalOrganization.js';
import {
  computeEntitlements,
  loadInternalAccess,
} from '../../utils/billingEntitlements.js';

/**
 * Read the caller's personal organization (or null when missing).
 * Service-role read, so RLS does not apply.
 */
async function loadPersonalOrgForEntitlements(admin, userId) {
  const { data, error } = await admin
    .from('organizations')
    .select('plan_key, subscription_status')
    .eq('personal_owner_user_id', userId)
    .eq('type', 'personal')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * GET /api/me/entitlements
 *
 * Returns a curated entitlements payload combining:
 *   - public.internal_access (active row, ui_experience_version)
 *   - organizations.subscription_status / plan_key (personal org)
 *
 * The FE consumes this for UX rendering (paywall vs. unlocked, stable vs. beta UI).
 * Privileged actions on the BE must independently re-check entitlements — never
 * trust a flag echoed back from the FE.
 */
export async function getMyEntitlements(request, reply) {
  const userId = request.user?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Unauthenticated' });
  }

  const admin = supabaseAdmin();
  let org = null;
  try {
    org = await loadPersonalOrgForEntitlements(admin, userId);
    if (!org) {
      try {
        await ensurePersonalOrganization(userId, {
          name: request.user?.email || 'Personal',
        });
        org = await loadPersonalOrgForEntitlements(admin, userId);
      } catch (err) {
        request.log?.error({ err }, '[entitlements] ensurePersonalOrganization');
      }
    }
  } catch (err) {
    request.log?.error({ err }, '[entitlements] load org');
    return reply.status(500).send({ error: 'Failed to load entitlements' });
  }

  let internalAccess = null;
  try {
    internalAccess = await loadInternalAccess(userId);
  } catch (err) {
    request.log?.error({ err }, '[entitlements] loadInternalAccess');
  }

  return reply.status(200).send({
    entitlements: computeEntitlements({ userId, org, internalAccess }),
  });
}
