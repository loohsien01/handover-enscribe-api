import { querySupabasePostgres } from './supabasePostgresPool.js';

/**
 * Default UI experience for users without an active internal-access row.
 * Mirrors the `public.ui_experience_version` enum default.
 */
export const DEFAULT_UI_EXPERIENCE_VERSION = 'stable';

/**
 * @typedef {Object} EntitlementOrgInput
 * @property {string} [plan_key]
 * @property {string} [subscription_status]
 *
 * @typedef {Object} InternalAccessRow
 * @property {boolean} active
 * @property {string} ui_experience_version
 * @property {string|null} expires_at
 *
 * @typedef {Object} EntitlementsPayload
 * @property {string|null} user_id
 * @property {string} ui_experience_version
 * @property {boolean} has_internal_access
 * @property {string|null} internal_access_expires_at
 * @property {boolean} has_pro_plan
 * @property {string|null} plan_key
 * @property {string|null} subscription_status
 * @property {boolean} entitled
 * @property {'internal_access'|'subscription'|'none'} entitlement_source
 */

/**
 * Whether an org's subscription qualifies as a paid Pro plan.
 * @param {EntitlementOrgInput | null | undefined} org
 * @returns {boolean}
 */
export function organizationHasProPlan(org) {
  if (!org) return false;
  return org.plan_key === 'pro' && ['active', 'trialing'].includes(org.subscription_status || '');
}

/**
 * Load the caller's internal-access row and resolve whether it is currently active
 * (no expiry, or expiry in the future). Returns `null` when no row exists.
 *
 * Exposes only fields needed by the FE (active, ui_experience_version, expires_at).
 * Admin-only fields (`reason`, `created_by`, `exclude_from_cleanup`) are intentionally
 * never returned from this helper.
 *
 * @param {string|null|undefined} userId
 * @returns {Promise<InternalAccessRow | null>}
 */
export async function loadInternalAccess(userId) {
  if (!userId) return null;
  const { rows } = await querySupabasePostgres(
    `SELECT ui_experience_version,
            expires_at,
            (expires_at IS NULL OR expires_at > now()) AS active
       FROM public.internal_access
      WHERE user_id = $1
      LIMIT 1`,
    [userId]
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    active: row.active === true,
    ui_experience_version: row.ui_experience_version || DEFAULT_UI_EXPERIENCE_VERSION,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

/**
 * Combine subscription + internal-access into a single entitlements payload.
 * Pure (no I/O) so it can be unit-tested in isolation.
 *
 * @param {{ userId?: string|null, org?: EntitlementOrgInput|null, internalAccess?: InternalAccessRow|null }} input
 * @returns {EntitlementsPayload}
 */
export function computeEntitlements({ userId = null, org = null, internalAccess = null } = {}) {
  const hasProPlan = organizationHasProPlan(org);
  const hasInternalAccess = Boolean(internalAccess?.active);

  const uiExperienceVersion = hasInternalAccess
    ? internalAccess?.ui_experience_version || DEFAULT_UI_EXPERIENCE_VERSION
    : DEFAULT_UI_EXPERIENCE_VERSION;

  const entitled = hasInternalAccess || hasProPlan;
  let entitlement_source = 'none';
  if (hasInternalAccess) entitlement_source = 'internal_access';
  else if (hasProPlan) entitlement_source = 'subscription';

  return {
    user_id: userId || null,
    ui_experience_version: uiExperienceVersion,
    has_internal_access: hasInternalAccess,
    internal_access_expires_at: hasInternalAccess ? internalAccess?.expires_at ?? null : null,
    has_pro_plan: hasProPlan,
    plan_key: org?.plan_key ?? null,
    subscription_status: org?.subscription_status ?? null,
    entitled,
    entitlement_source,
  };
}
