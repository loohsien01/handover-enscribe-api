import {
  ensurePersonalOrganization,
  loadPersonalOrganizationForUser,
} from '../../services/personalOrganization.js';
import {
  computeEntitlements,
  loadInternalAccess,
} from '../../utils/billingEntitlements.js';
import { loadUsageForUserContext } from '../../utils/billingUsage.js';

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

  let org = null;
  try {
    org = await loadPersonalOrganizationForUser(userId);
    if (!org) {
      try {
        await ensurePersonalOrganization(userId, {
          name: request.user?.email || 'Personal',
        });
        org = await loadPersonalOrganizationForUser(userId);
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

  let usage = null;
  try {
    usage = await loadUsageForUserContext(userId, org, internalAccess);
  } catch (err) {
    request.log?.error({ err }, '[entitlements] loadUsageForUserContext');
  }

  return reply.status(200).send({
    entitlements: computeEntitlements({ userId, org, internalAccess }),
    usage,
  });
}
