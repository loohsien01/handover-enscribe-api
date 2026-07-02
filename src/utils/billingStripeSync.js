import { querySupabasePostgres } from './supabasePostgresPool.js';
import { pgQueryOne } from './pgQueryHelpers.js';

/**
 * @param {import('stripe').Stripe.Subscription} subscription
 * @param {{ proPrice: string | undefined, priceId: string | undefined }} priceMatch
 */
function warnIfActiveSubscriptionIsNotPro(subscription, { proPrice, priceId }) {
  const warnStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid']);
  if (!warnStatuses.has(subscription.status)) return;
  if (!proPrice) {
    console.warn(
      `[billing] Subscription ${subscription.id} is ${subscription.status} but STRIPE_PRICE_PRO_MONTHLY is unset; plan_key coerced to free.`,
    );
    return;
  }
  if (!priceId) {
    console.warn(
      `[billing] Subscription ${subscription.id} has status ${subscription.status} but no price id on the first line item; plan_key coerced to free.`,
    );
    return;
  }
  if (priceId !== proPrice) {
    console.warn(
      `[billing] Subscription ${subscription.id} uses Stripe price ${priceId}, not STRIPE_PRICE_PRO_MONTHLY (${proPrice}); plan_key stays free until the subscription uses the configured Pro price.`,
    );
  }
}

/**
 * Map Stripe subscription + env price id to our plan_key.
 * Only the price id in STRIPE_PRICE_PRO_MONTHLY maps to `pro`; everything else is `free`.
 * @param {import('stripe').Stripe.Subscription} subscription
 * @returns {'free' | 'pro'}
 */
export function derivePlanKeyFromSubscription(subscription) {
  const proPrice = process.env.STRIPE_PRICE_PRO_MONTHLY;
  const item = subscription.items?.data?.[0];
  const priceObj = item?.price;
  const priceId = typeof priceObj === 'string' ? priceObj : priceObj?.id;
  const hasProPrice = Boolean(proPrice && priceId === proPrice);

  if (['canceled', 'incomplete_expired'].includes(subscription.status)) {
    return 'free';
  }
  if (hasProPrice) {
    return 'pro';
  }
  warnIfActiveSubscriptionIsNotPro(subscription, { proPrice, priceId });
  return 'free';
}

/**
 * @param {import('stripe').Stripe.Subscription} subscription
 * @param {string | undefined} organizationIdHint
 */
export async function syncOrganizationFromSubscription(subscription, organizationIdHint) {
  let orgId = organizationIdHint || subscription.metadata?.organization_id;
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  if (!orgId && customerId) {
    const row = await pgQueryOne(
      `SELECT id FROM public.organizations WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId]
    );
    orgId = row?.id ? String(row.id) : undefined;
  }
  if (!orgId && subscription.id) {
    const row = await pgQueryOne(
      `SELECT id FROM public.organizations WHERE stripe_subscription_id = $1 LIMIT 1`,
      [subscription.id]
    );
    orgId = row?.id ? String(row.id) : undefined;
  }
  if (!orgId) {
    return { ok: false, reason: 'organization_not_found' };
  }

  const planKey = derivePlanKeyFromSubscription(subscription);
  const periodEndUnix =
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end ||
    null;
  const periodEnd = periodEndUnix
    ? new Date(periodEndUnix * 1000).toISOString()
    : null;

  await querySupabasePostgres(
    `UPDATE public.organizations
        SET stripe_subscription_id = $2,
            stripe_customer_id = COALESCE($3, stripe_customer_id),
            subscription_status = $4,
            plan_key = $5,
            current_period_end = $6::timestamptz,
            cancel_at_period_end = $7
      WHERE id = $1`,
    [
      orgId,
      subscription.id,
      customerId ?? null,
      subscription.status,
      planKey,
      periodEnd,
      subscription.cancel_at_period_end ?? false,
    ]
  );

  return { ok: true, organizationId: orgId };
}
