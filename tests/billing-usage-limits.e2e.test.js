/**
 * Billing usage limits — E2E (Tier C).
 *
 * **Not** in `npm test` / `runAll.js`. Seeds `usage_counters` via Postgres (service pool),
 * then asserts **402** `USAGE_LIMIT_EXCEEDED` on the API.
 *
 * Prerequisites:
 * - Fastify running (`npm run dev:fastify`)
 * - Migration `sql/migrations/20260528120000_usage_metering.sql` applied
 * - `.env.local`:
 *     TEST_BILLING_USAGE_LIMIT_EMAIL
 *     TEST_BILLING_USAGE_LIMIT_PASSWORD
 *     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (seed/reset counters via admin)
 *     SUPABASE_DB_DIRECT_URL (preflight `plan_limits` check only)
 * - Account must be **free** (no active Pro; no active `internal_access`)
 * - Nova test: `REDIS_URL` + Redis running
 *
 * Run: `npm run test:billing-usage-limits`
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { makeRequest } from './testUtils.js';
import {
  getApiBaseUrl,
  getBillingUsageLimitTestAccount,
  hasBillingUsageLimitTestAccount,
  checkRedisReachableForTests,
} from './testConfig.js';
import { supabaseAdmin } from '../src/utils/supabaseAdmin.js';
import {
  closeSupabasePostgresPool,
  querySupabasePostgres,
} from '../src/utils/supabasePostgresPool.js';
import {
  USAGE_LIMIT_EXCEEDED_CODE,
  USAGE_METRICS,
  getCalendarMonthPeriod,
} from '../src/utils/billingUsage.js';

/** @param {string} label */
function logStep(label) {
  console.log(`[billing-usage-limits.e2e] ${label}`);
}

const FREE_NOTES_SAVED_LIMIT = 10;
const FREE_NOVA_RESPONSE_LIMIT = 50;

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

/** @returns {Promise<string | false>} skip reason or false if ok to run */
async function e2eSkipReason() {
  if (!hasBillingUsageLimitTestAccount()) {
    return 'Set TEST_BILLING_USAGE_LIMIT_EMAIL and TEST_BILLING_USAGE_LIMIT_PASSWORD in .env.local';
  }
  try {
    const health = await fetch(`${getApiBaseUrl()}/health`);
    if (!health.ok) {
      return `Server not healthy at ${getApiBaseUrl()} (start npm run dev:fastify)`;
    }
  } catch {
    return `Server not reachable at ${getApiBaseUrl()}`;
  }
  try {
    const { rows } = await querySupabasePostgres(
      `SELECT 1 FROM public.plan_limits WHERE plan_key = 'free' AND metric = 'notes_saved' LIMIT 1`
    );
    if (!rows?.length) {
      return 'plan_limits not found — apply sql/migrations/20260528120000_usage_metering.sql';
    }
  } catch (err) {
    const msg = err && typeof err.message === 'string' ? err.message : String(err);
    return `Postgres unavailable for usage metering (${msg})`;
  }
  return false;
}

/**
 * @param {string} organizationId
 * @param {string} metric
 * @param {number} quantity
 */
async function seedUsageCounter(organizationId, metric, quantity) {
  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod();
  const admin = supabaseAdmin();
  const { error } = await admin.from('usage_counters').upsert(
    {
      organization_id: organizationId,
      metric,
      period_start: periodStartIso,
      period_end: periodEndIso,
      quantity,
    },
    { onConflict: 'organization_id,metric,period_start' }
  );
  if (error) {
    throw new Error(`seedUsageCounter failed: ${error.message}`);
  }
}

/**
 * @param {string} organizationId
 * @param {string} metric
 * @returns {Promise<{ quantity: number, hadRow: boolean }>}
 */
async function readUsageCounterSnapshot(organizationId, metric) {
  const { periodStartIso } = getCalendarMonthPeriod();
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('usage_counters')
    .select('quantity')
    .eq('organization_id', organizationId)
    .eq('metric', metric)
    .eq('period_start', periodStartIso)
    .maybeSingle();
  if (error) {
    throw new Error(`readUsageCounterSnapshot failed: ${error.message}`);
  }
  if (!data) {
    return { quantity: 0, hadRow: false };
  }
  return { quantity: Number(data.quantity ?? 0), hadRow: true };
}

/**
 * @param {string} organizationId
 * @param {string} metric
 * @param {{ quantity: number, hadRow: boolean }} snapshot
 */
async function restoreUsageCounter(organizationId, metric, snapshot) {
  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod();
  const admin = supabaseAdmin();

  if (!snapshot.hadRow && snapshot.quantity === 0) {
    const { error } = await admin
      .from('usage_counters')
      .delete()
      .eq('organization_id', organizationId)
      .eq('metric', metric)
      .eq('period_start', periodStartIso);
    if (error) {
      throw new Error(`restoreUsageCounter (delete) failed: ${error.message}`);
    }
    logStep(`${metric}: restored (removed test row; was absent before)`);
    return;
  }

  const { error } = await admin.from('usage_counters').upsert(
    {
      organization_id: organizationId,
      metric,
      period_start: periodStartIso,
      period_end: periodEndIso,
      quantity: snapshot.quantity,
    },
    { onConflict: 'organization_id,metric,period_start' }
  );
  if (error) {
    throw new Error(`restoreUsageCounter failed: ${error.message}`);
  }
  logStep(`${metric}: restored quantity=${snapshot.quantity}`);
}

/**
 * Redis PING with a hard wall-clock cap (client connectTimeout alone can still feel stuck).
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function redisReachableWithTimeout(ms = 5000) {
  const check = checkRedisReachableForTests();
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Redis check timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([check, timeout]);
  } catch (err) {
    const msg = err && typeof err.message === 'string' ? err.message : String(err);
    return { ok: false, message: msg };
  }
}

/**
 * @param {string} email
 * @param {string} password
 */
async function signIn(email, password) {
  const base = getApiBaseUrl();
  const res = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ action: 'sign-in', email, password }),
  });
  const body = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `sign-in failed: ${res.status} ${JSON.stringify(body)}`);
  const token = body?.token?.access_token;
  assert.ok(typeof token === 'string' && token.length > 0, 'missing access_token');
  return {
    token,
    authHeaders: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    /** Bodyless POST/GET — omit Content-Type so Fastify does not expect JSON body */
    authHeadersNoBody: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  };
}

/**
 * @param {Record<string, string>} authHeaders
 */
async function loadPersonalOrgContext(authHeaders) {
  const base = getApiBaseUrl();
  const res = await makeRequest('GET', `${base}/api/billing/status`, {
    headers: authHeaders,
    expectedStatus: 200,
  });
  assert.equal(res.passed, true, `billing/status failed: ${res.status}`);
  const orgId = res.body?.organization?.id;
  assert.ok(typeof orgId === 'string', 'missing organization.id');
  const ent = res.body?.entitlements;
  assert.ok(ent, 'missing entitlements');
  assert.equal(ent.has_pro_plan, false, 'account must not have has_pro_plan (use a free test user)');
  assert.equal(
    ent.has_internal_access,
    false,
    'account must not have internal_access (bypasses limits)'
  );
  return { organizationId: orgId, entitlements: ent };
}

/**
 * @param {unknown} body
 * @param {string} expectedMetric
 */
function assertUsageLimit402(body, expectedMetric) {
  assert.equal(body?.code, USAGE_LIMIT_EXCEEDED_CODE);
  assert.equal(body?.metric, expectedMetric);
  assert.equal(typeof body?.used, 'number');
  assert.equal(typeof body?.limit, 'number');
  assert.equal(typeof body?.period_end, 'string');
}

test('billing usage limits E2E', async (t) => {
  try {
    logStep('preflight…');
    const skip = await e2eSkipReason();
    if (skip) {
      t.skip(skip);
      return;
    }

    const account = getBillingUsageLimitTestAccount();
    assert.ok(account);
    logStep('sign-in…');
    const { authHeaders, authHeadersNoBody } = await signIn(account.email, account.password);
    logStep('GET /api/billing/status…');
    const { organizationId } = await loadPersonalOrgContext(authHeaders);
    logStep(`organizationId=${organizationId}`);

    // Notes first — no Redis; usually the fastest signal that 402 gating works.
    await t.test('notes_saved: at monthly cap → POST patient-encounters/complete returns 402', async (st) => {
      const original = await readUsageCounterSnapshot(organizationId, USAGE_METRICS.NOTES_SAVED);
      logStep(
        `notes_saved: original counter=${original.quantity}${original.hadRow ? '' : ' (no row)'}`
      );

      logStep('notes_saved: seed counter to limit…');
      const base = getApiBaseUrl();
      await seedUsageCounter(organizationId, USAGE_METRICS.NOTES_SAVED, FREE_NOTES_SAVED_LIMIT);

      try {
        logStep('notes_saved: POST /patient-encounters/complete (expect 402)…');
        const completeRes = await makeRequest('POST', `${base}/api/patient-encounters/complete`, {
          headers: authHeaders,
          body: {
            patientEncounter: { name: 'Usage limit E2E patient' },
            recording: {
              recording_file_path: '/test-recordings/usage-limit-e2e.wav',
            },
            note_text: 'E2E usage limit probe note.',
          },
          expectedStatus: 402,
          timeoutMs: 30_000,
        });
        assert.equal(completeRes.passed, true, `expected 402, got ${completeRes.status}`);
        assertUsageLimit402(completeRes.body, USAGE_METRICS.NOTES_SAVED);
        assert.equal(completeRes.body?.used, FREE_NOTES_SAVED_LIMIT);
        assert.equal(completeRes.body?.limit, FREE_NOTES_SAVED_LIMIT);
        logStep('notes_saved: 402 OK');
      } finally {
        await restoreUsageCounter(organizationId, USAGE_METRICS.NOTES_SAVED, original);
      }
    });

    await t.test('nova_response: at monthly cap → POST completion returns 402', async (st) => {
      logStep('nova_response: Redis check…');
      const redisCheck = await redisReachableWithTimeout(5000);
      if (!redisCheck.ok) {
        st.skip(`Redis required for Nova completions: ${redisCheck.message}`);
        return;
      }

      const base = getApiBaseUrl();
      const original = await readUsageCounterSnapshot(organizationId, USAGE_METRICS.NOVA_RESPONSE);
      logStep(
        `nova_response: original counter=${original.quantity}${original.hadRow ? '' : ' (no row)'}`
      );

      logStep('nova_response: seed counter to limit…');
      await seedUsageCounter(organizationId, USAGE_METRICS.NOVA_RESPONSE, FREE_NOVA_RESPONSE_LIMIT);

      try {
        logStep('nova_response: POST /nova/chat-sessions…');
        const createRes = await makeRequest('POST', `${base}/api/nova/chat-sessions`, {
          headers: authHeadersNoBody,
          expectedStatus: 201,
          timeoutMs: 30_000,
        });
        assert.equal(
          createRes.passed,
          true,
          `POST /nova/chat-sessions expected 201, got ${createRes.status} ${JSON.stringify(createRes.body)}`
        );
        const chatId = createRes.body?.chatId;
        assert.ok(typeof chatId === 'string');

        logStep('nova_response: POST /completions (expect 402)…');
        const compRes = await makeRequest(
          'POST',
          `${base}/api/nova/chat-sessions/${chatId}/completions`,
          {
            headers: authHeaders,
            body: {
              model: 'haiku',
              message: 'Usage limit E2E probe message.',
              client_message_id: randomUUID(),
            },
            expectedStatus: 402,
            timeoutMs: 30_000,
          }
        );
        assert.equal(compRes.passed, true, `expected 402, got ${compRes.status}`);
        assertUsageLimit402(compRes.body, USAGE_METRICS.NOVA_RESPONSE);
        assert.equal(compRes.body?.used, FREE_NOVA_RESPONSE_LIMIT);
        assert.equal(compRes.body?.limit, FREE_NOVA_RESPONSE_LIMIT);
        logStep('nova_response: 402 OK');
      } finally {
        await restoreUsageCounter(organizationId, USAGE_METRICS.NOVA_RESPONSE, original);
      }
    });
  } finally {
    await closeSupabasePostgresPool().catch(() => {});
  }
});
