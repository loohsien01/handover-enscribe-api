/**
 * @param {{ plan_key?: string, subscription_status?: string } | null | undefined} org
 * @returns {boolean}
 */
export function organizationHasProPlan(org) {
  if (!org) return false;
  return org.plan_key === 'pro' && ['active', 'trialing'].includes(org.subscription_status || '');
}
