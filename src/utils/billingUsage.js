import { supabaseAdmin } from './supabaseAdmin.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';
import { ensurePersonalOrganization } from '../services/personalOrganization.js';
import {
  loadInternalAccess,
  organizationHasProPlan,
} from './billingEntitlements.js';

/** @typedef {'notes_saved' | 'nova_response'} UsageMetric */

export const USAGE_METRICS = Object.freeze({
  NOTES_SAVED: 'notes_saved',
  NOVA_RESPONSE: 'nova_response',
});

export const USAGE_LIMIT_EXCEEDED_CODE = 'USAGE_LIMIT_EXCEEDED';

/**
 * Calendar month window in UTC.
 * @param {Date} [now]
 * @returns {{ periodStart: Date, periodEnd: Date, periodStartIso: string, periodEndIso: string }}
 */
export function getCalendarMonthPeriod(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const periodStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  return {
    periodStart,
    periodEnd,
    periodStartIso: periodStart.toISOString(),
    periodEndIso: periodEnd.toISOString(),
  };
}

/**
 * Pure limit check for unit tests.
 * @param {{ used: number, limit: number | null, bypass?: boolean }} input
 */
export function evaluateUsageAllowance({ used, limit, bypass = false }) {
  if (bypass) {
    return { allowed: true, used, limit: null };
  }
  if (limit == null) {
    return { allowed: true, used, limit: null };
  }
  if (used >= limit) {
    return { allowed: false, used, limit };
  }
  return { allowed: true, used, limit };
}

export class UsageLimitExceededError extends Error {
  /**
   * @param {{ metric: UsageMetric, used: number, limit: number, periodEnd: string }} details
   */
  constructor({ metric, used, limit, periodEnd }) {
    super('Usage limit exceeded for this billing period');
    this.name = 'UsageLimitExceededError';
    this.code = USAGE_LIMIT_EXCEEDED_CODE;
    this.statusCode = 402;
    this.metric = metric;
    this.used = used;
    this.limit = limit;
    this.periodEnd = periodEnd;
  }

  /** @returns {Record<string, unknown>} */
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      metric: this.metric,
      used: this.used,
      limit: this.limit,
      period_end: this.periodEnd,
    };
  }
}

/**
 * @param {{ plan_key?: string, subscription_status?: string } | null | undefined} org
 * @returns {'free' | 'pro'}
 */
export function effectivePlanKeyForLimits(org) {
  return organizationHasProPlan(org) ? 'pro' : 'free';
}

/**
 * @param {string} userId
 * @returns {Promise<{
 *   organizationId: string,
 *   org: { plan_key?: string, subscription_status?: string } | null,
 *   internalAccess: import('./billingEntitlements.js').InternalAccessRow | null,
 *   bypassUsageLimits: boolean,
 *   planKeyForLimits: 'free' | 'pro'
 * }>}
 */
export async function resolveBillingContext(userId) {
  const { organizationId } = await ensurePersonalOrganization(userId);
  const admin = supabaseAdmin();
  const { data: org, error } = await admin
    .from('organizations')
    .select('plan_key, subscription_status')
    .eq('id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const internalAccess = await loadInternalAccess(userId);
  const bypassUsageLimits =
    organizationHasProPlan(org) || Boolean(internalAccess?.active);
  const planKeyForLimits = effectivePlanKeyForLimits(org);

  return {
    organizationId,
    org: org || null,
    internalAccess,
    bypassUsageLimits,
    planKeyForLimits,
  };
}

/**
 * @param {'free' | 'pro'} planKey
 * @param {UsageMetric} metric
 * @returns {Promise<number | null>}
 */
export async function getPlanLimit(planKey, metric) {
  const { rows } = await querySupabasePostgres(
    `SELECT limit_quantity
       FROM public.plan_limits
      WHERE plan_key = $1
        AND metric = $2
        AND period_type = 'calendar_month'
      LIMIT 1`,
    [planKey, metric]
  );
  const row = rows?.[0];
  if (!row) return null;
  if (row.limit_quantity == null) return null;
  return Number(row.limit_quantity);
}

/**
 * @param {string} organizationId
 * @param {UsageMetric} metric
 * @param {string} periodStartIso
 * @returns {Promise<number>}
 */
export async function getUsageQuantity(organizationId, metric, periodStartIso) {
  const { rows } = await querySupabasePostgres(
    `SELECT quantity
       FROM public.usage_counters
      WHERE organization_id = $1
        AND metric = $2
        AND period_start = $3::timestamptz
      LIMIT 1`,
    [organizationId, metric, periodStartIso]
  );
  const q = rows?.[0]?.quantity;
  return q != null ? Number(q) : 0;
}

/**
 * Monthly usage snapshot for API (all v1 metrics).
 * @param {{ organizationId: string, planKeyForLimits: 'free' | 'pro', bypassUsageLimits: boolean, now?: Date }} input
 */
export async function loadMonthlyUsageSnapshot({
  organizationId,
  planKeyForLimits,
  bypassUsageLimits,
  now = new Date(),
}) {
  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod(now);
  /** @type {Record<string, { used: number, limit: number | null }>} */
  const metrics = {};

  for (const metric of Object.values(USAGE_METRICS)) {
    const used = await getUsageQuantity(organizationId, metric, periodStartIso);
    const limit = bypassUsageLimits
      ? null
      : await getPlanLimit(planKeyForLimits, metric);
    metrics[metric] = { used, limit };
  }

  return {
    period_start: periodStartIso,
    period_end: periodEndIso,
    metrics,
  };
}

/**
 * @param {{
 *   organizationId: string,
 *   userId: string,
 *   metric: UsageMetric,
 *   bypassUsageLimits?: boolean,
 *   planKeyForLimits?: 'free' | 'pro',
 *   now?: Date
 * }} input
 */
export async function assertUsageAllowed(input) {
  const {
    organizationId,
    metric,
    bypassUsageLimits = false,
    planKeyForLimits = 'free',
    now = new Date(),
  } = input;

  const { periodEndIso, periodStartIso } = getCalendarMonthPeriod(now);

  if (bypassUsageLimits) {
    return { allowed: true, bypass: true, periodStartIso, periodEndIso };
  }

  const [used, limit] = await Promise.all([
    getUsageQuantity(organizationId, metric, periodStartIso),
    getPlanLimit(planKeyForLimits, metric),
  ]);

  const evaluation = evaluateUsageAllowance({ used, limit, bypass: false });
  if (!evaluation.allowed) {
    throw new UsageLimitExceededError({
      metric,
      used: evaluation.used,
      limit: /** @type {number} */ (evaluation.limit),
      periodEnd: periodEndIso,
    });
  }

  return { allowed: true, used, limit, periodStartIso, periodEndIso };
}

/**
 * Record one unit of usage after successful work (idempotent).
 * @param {{
 *   organizationId: string,
 *   userId: string,
 *   metric: UsageMetric,
 *   idempotencyKey: string,
 *   metadata?: Record<string, unknown>,
 *   bypassUsageLimits?: boolean,
 *   now?: Date
 * }} input
 * @returns {Promise<{ recorded: boolean }>}
 */
export async function recordUsageSuccess(input) {
  const {
    organizationId,
    userId,
    metric,
    idempotencyKey,
    metadata = {},
    bypassUsageLimits = false,
    now = new Date(),
  } = input;

  if (bypassUsageLimits) {
    return { recorded: false };
  }

  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod(now);

  const { rows: eventRows } = await querySupabasePostgres(
    `INSERT INTO public.usage_events (
       organization_id, user_id, metric, quantity, idempotency_key, metadata
     ) VALUES ($1, $2, $3, 1, $4, $5::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [organizationId, userId, metric, idempotencyKey, JSON.stringify(metadata)]
  );

  if (!eventRows?.length) {
    return { recorded: false };
  }

  await querySupabasePostgres(
    `INSERT INTO public.usage_counters (
       organization_id, metric, period_start, period_end, quantity
     ) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 1)
     ON CONFLICT (organization_id, metric, period_start)
     DO UPDATE SET
       quantity = usage_counters.quantity + 1,
       updated_at = now()`,
    [organizationId, metric, periodStartIso, periodEndIso]
  );

  return { recorded: true };
}

/**
 * Resolve billing context and assert quota in one call.
 * @param {string} userId
 * @param {UsageMetric} metric
 */
export async function assertUsageAllowedForUser(userId, metric) {
  const ctx = await resolveBillingContext(userId);
  await assertUsageAllowed({
    organizationId: ctx.organizationId,
    userId,
    metric,
    bypassUsageLimits: ctx.bypassUsageLimits,
    planKeyForLimits: ctx.planKeyForLimits,
  });
  return ctx;
}

/**
 * Usage block for GET /api/me/entitlements and GET /api/billing/status.
 * @param {string} userId
 * @param {{ plan_key?: string, subscription_status?: string } | null} org
 * @param {import('./billingEntitlements.js').InternalAccessRow | null} internalAccess
 */
export async function loadUsageForUserContext(userId, org, internalAccess) {
  const { organizationId } = await ensurePersonalOrganization(userId);
  const bypassUsageLimits =
    organizationHasProPlan(org) || Boolean(internalAccess?.active);
  const planKeyForLimits = effectivePlanKeyForLimits(org);
  return loadMonthlyUsageSnapshot({
    organizationId,
    planKeyForLimits,
    bypassUsageLimits,
  });
}
