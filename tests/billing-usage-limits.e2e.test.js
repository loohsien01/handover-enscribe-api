/**
 * Billing usage limits — E2E (Tier C).
 *
 * **Not** in `npm test` / `runAll.js`. Seeds `usage_counters` via the same Postgres pool
 * the API uses (`querySupabasePostgres` / `DATABASE_URL_LOCAL` or `DATABASE_URL`),
 * then asserts **402** `USAGE_LIMIT_EXCEEDED` on the API.
 *
 * Prerequisites:
 * - Fastify running (`npm run dev:fastify`) with the **same** Postgres URL as this test
 * - Migration `sql/migrations/20260528120000_usage_metering.sql` applied on that DB
 * - Migration `sql/migrations/20260707120000_pre_visit_summary_usage_metrics.sql` for pre-visit tests
 * - `.env.local`:
 *     TEST_BILLING_USAGE_LIMIT_EMAIL
 *     TEST_BILLING_USAGE_LIMIT_PASSWORD
 *     DATABASE_URL_LOCAL (dev tunnel) or DATABASE_URL — **not** legacy Supabase REST alone
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
import {
  closeSupabasePostgresPool,
  querySupabasePostgres,
} from '../src/utils/supabasePostgresPool.js';
import {
  USAGE_LIMIT_EXCEEDED_CODE,
  USAGE_METRICS,
  getCalendarMonthPeriod,
  getPlanLimit,
} from '../src/utils/billingUsage.js';

/** @param {string} label */
function logStep(label) {
  console.log(`[billing-usage-limits.e2e] ${label}`);
}

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
    const { rows: pvsRows } = await querySupabasePostgres(
      `SELECT 1 FROM public.plan_limits WHERE plan_key = 'free' AND metric = 'pre_visit_summary' LIMIT 1`
    );
    if (!pvsRows?.length) {
      return 'pre-visit summary plan_limits not found — apply sql/migrations/20260707120000_pre_visit_summary_usage_metrics.sql';
    }
  } catch (err) {
    const msg = err && typeof err.message === 'string' ? err.message : String(err);
    return `Postgres unavailable for usage metering (${msg})`;
  }
  return false;
}

/**
 * Read free-tier cap from plan_limits (same source the API uses).
 * @param {import('../src/utils/billingUsage.js').UsageMetric} metric
 * @returns {Promise<number | null>}
 */
async function readFreePlanLimit(metric) {
  return getPlanLimit('free', metric);
}

/**
 * @param {string} organizationId
 * @param {string} metric
 * @param {number} quantity
 */
async function seedUsageCounter(organizationId, metric, quantity) {
  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod();
  await querySupabasePostgres(
    `INSERT INTO public.usage_counters (
       organization_id, metric, period_start, period_end, quantity
     ) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5)
     ON CONFLICT (organization_id, metric, period_start)
     DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
    [organizationId, metric, periodStartIso, periodEndIso, quantity]
  );
}

/**
 * @param {string} organizationId
 * @param {string} metric
 * @returns {Promise<{ quantity: number, hadRow: boolean }>}
 */
async function readUsageCounterSnapshot(organizationId, metric) {
  const { periodStartIso } = getCalendarMonthPeriod();
  const { rows } = await querySupabasePostgres(
    `SELECT quantity
       FROM public.usage_counters
      WHERE organization_id = $1
        AND metric = $2
        AND period_start = $3::timestamptz
      LIMIT 1`,
    [organizationId, metric, periodStartIso]
  );
  const row = rows?.[0];
  if (!row) {
    return { quantity: 0, hadRow: false };
  }
  return { quantity: Number(row.quantity ?? 0), hadRow: true };
}

/**
 * @param {string} organizationId
 * @param {string} metric
 * @param {{ quantity: number, hadRow: boolean }} snapshot
 */
async function restoreUsageCounter(organizationId, metric, snapshot) {
  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod();

  if (!snapshot.hadRow && snapshot.quantity === 0) {
    await querySupabasePostgres(
      `DELETE FROM public.usage_counters
        WHERE organization_id = $1
          AND metric = $2
          AND period_start = $3::timestamptz`,
      [organizationId, metric, periodStartIso]
    );
    logStep(`${metric}: restored (removed test row; was absent before)`);
    return;
  }

  await querySupabasePostgres(
    `INSERT INTO public.usage_counters (
       organization_id, metric, period_start, period_end, quantity
     ) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5)
     ON CONFLICT (organization_id, metric, period_start)
     DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
    [organizationId, metric, periodStartIso, periodEndIso, snapshot.quantity]
  );
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
    body: JSON.stringify({ action: 'sign-in', email, password, turnstileToken: process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN }),
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

    const [
      notesSavedLimit,
      novaResponseLimit,
      preVisitSummaryLimit,
      preVisitChatTurnLimit,
    ] = await Promise.all([
      readFreePlanLimit(USAGE_METRICS.NOTES_SAVED),
      readFreePlanLimit(USAGE_METRICS.NOVA_RESPONSE),
      readFreePlanLimit(USAGE_METRICS.PRE_VISIT_SUMMARY),
      readFreePlanLimit(USAGE_METRICS.PRE_VISIT_SUMMARY_CHAT_TURN),
    ]);
    logStep(
      `free plan_limits: notes_saved=${notesSavedLimit}, nova_response=${novaResponseLimit}, ` +
        `pre_visit_summary=${preVisitSummaryLimit}, pre_visit_summary_chat_turn=${preVisitChatTurnLimit}`
    );

    // Notes first — no Redis; usually the fastest signal that 402 gating works.
    await t.test('notes_saved: at monthly cap → POST patient-encounters/complete returns 402', async (st) => {
      if (notesSavedLimit == null) {
        st.skip('free notes_saved limit is NULL (unlimited)');
        return;
      }

      const original = await readUsageCounterSnapshot(organizationId, USAGE_METRICS.NOTES_SAVED);
      logStep(
        `notes_saved: original counter=${original.quantity}${original.hadRow ? '' : ' (no row)'}`
      );

      logStep('notes_saved: seed counter to limit…');
      const base = getApiBaseUrl();
      await seedUsageCounter(organizationId, USAGE_METRICS.NOTES_SAVED, notesSavedLimit);

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
        assert.equal(completeRes.body?.used, notesSavedLimit);
        assert.equal(completeRes.body?.limit, notesSavedLimit);
        logStep('notes_saved: 402 OK');
      } finally {
        await restoreUsageCounter(organizationId, USAGE_METRICS.NOTES_SAVED, original);
      }
    });

    await t.test('nova_response: at monthly cap → POST completion returns 402', async (st) => {
      if (novaResponseLimit == null) {
        st.skip('free nova_response limit is NULL (unlimited)');
        return;
      }

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
      await seedUsageCounter(organizationId, USAGE_METRICS.NOVA_RESPONSE, novaResponseLimit);

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
        assert.equal(compRes.body?.used, novaResponseLimit);
        assert.equal(compRes.body?.limit, novaResponseLimit);
        logStep('nova_response: 402 OK');
      } finally {
        await restoreUsageCounter(organizationId, USAGE_METRICS.NOVA_RESPONSE, original);
      }
    });

    await t.test(
      'pre_visit_summary: at monthly cap → POST completions-and-save-pre-visit-summary returns 402',
      async (st) => {
        if (preVisitSummaryLimit == null) {
          st.skip('free pre_visit_summary limit is NULL (unlimited)');
          return;
        }

        logStep('pre_visit_summary: Redis check…');
        const redisCheck = await redisReachableWithTimeout(5000);
        if (!redisCheck.ok) {
          st.skip(`Redis required for Nova completions: ${redisCheck.message}`);
          return;
        }

        const base = getApiBaseUrl();
        const original = await readUsageCounterSnapshot(
          organizationId,
          USAGE_METRICS.PRE_VISIT_SUMMARY
        );
        logStep(
          `pre_visit_summary: original counter=${original.quantity}${original.hadRow ? '' : ' (no row)'}`
        );

        logStep('pre_visit_summary: seed counter to limit…');
        await seedUsageCounter(
          organizationId,
          USAGE_METRICS.PRE_VISIT_SUMMARY,
          preVisitSummaryLimit
        );

        try {
          logStep('pre_visit_summary: POST /nova/chat-sessions…');
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

          logStep('pre_visit_summary: POST /completions-and-save-pre-visit-summary (expect 402)…');
          const compRes = await makeRequest(
            'POST',
            `${base}/api/nova/chat-sessions/${chatId}/completions-and-save-pre-visit-summary`,
            {
              headers: authHeaders,
              body: {
                model: 'sonnet',
                message: 'Usage limit E2E pre-visit summary probe.',
                client_message_id: randomUUID(),
              },
              expectedStatus: 402,
              timeoutMs: 30_000,
            }
          );
          assert.equal(compRes.passed, true, `expected 402, got ${compRes.status}`);
          assertUsageLimit402(compRes.body, USAGE_METRICS.PRE_VISIT_SUMMARY);
          assert.equal(compRes.body?.used, preVisitSummaryLimit);
          assert.equal(compRes.body?.limit, preVisitSummaryLimit);
          logStep('pre_visit_summary: 402 OK');
        } finally {
          await restoreUsageCounter(organizationId, USAGE_METRICS.PRE_VISIT_SUMMARY, original);
        }
      }
    );

    await t.test(
      'pre_visit_summary_chat_turn: at monthly cap → follow-up POST completions returns 402',
      async (st) => {
        if (preVisitChatTurnLimit == null) {
          st.skip('free pre_visit_summary_chat_turn limit is NULL (unlimited)');
          return;
        }

        logStep('pre_visit_summary_chat_turn: Redis check…');
        const redisCheck = await redisReachableWithTimeout(5000);
        if (!redisCheck.ok) {
          st.skip(`Redis required for Nova completions: ${redisCheck.message}`);
          return;
        }

        const base = getApiBaseUrl();
        const original = await readUsageCounterSnapshot(
          organizationId,
          USAGE_METRICS.PRE_VISIT_SUMMARY_CHAT_TURN
        );
        logStep(
          `pre_visit_summary_chat_turn: original counter=${original.quantity}${original.hadRow ? '' : ' (no row)'}`
        );

        logStep('pre_visit_summary_chat_turn: seed counter to limit…');
        await seedUsageCounter(
          organizationId,
          USAGE_METRICS.PRE_VISIT_SUMMARY_CHAT_TURN,
          preVisitChatTurnLimit
        );

        try {
          logStep('pre_visit_summary_chat_turn: POST /nova/chat-sessions…');
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

          // Link a pre_visit_summaries row so this chat's follow-up turns are
          // metered as pre_visit_summary_chat_turn (not nova_response).
          logStep('pre_visit_summary_chat_turn: POST /pre-visit-summaries (link summary row)…');
          const pvsRes = await makeRequest('POST', `${base}/api/pre-visit-summaries`, {
            headers: authHeaders,
            body: {
              chat_id: chatId,
              text: 'E2E linked pre-visit summary.',
            },
            expectedStatus: 201,
            timeoutMs: 30_000,
          });
          assert.equal(
            pvsRes.passed,
            true,
            `POST /pre-visit-summaries expected 201, got ${pvsRes.status} ${JSON.stringify(pvsRes.body)}`
          );

          logStep('pre_visit_summary_chat_turn: POST /completions (expect 402)…');
          const compRes = await makeRequest(
            'POST',
            `${base}/api/nova/chat-sessions/${chatId}/completions`,
            {
              headers: authHeaders,
              body: {
                model: 'haiku',
                message: 'Usage limit E2E follow-up probe.',
                client_message_id: randomUUID(),
              },
              expectedStatus: 402,
              timeoutMs: 30_000,
            }
          );
          assert.equal(compRes.passed, true, `expected 402, got ${compRes.status}`);
          assertUsageLimit402(compRes.body, USAGE_METRICS.PRE_VISIT_SUMMARY_CHAT_TURN);
          assert.equal(compRes.body?.used, preVisitChatTurnLimit);
          assert.equal(compRes.body?.limit, preVisitChatTurnLimit);
          logStep('pre_visit_summary_chat_turn: 402 OK');
        } finally {
          await restoreUsageCounter(
            organizationId,
            USAGE_METRICS.PRE_VISIT_SUMMARY_CHAT_TURN,
            original
          );
        }
      }
    );
  } finally {
    await closeSupabasePostgresPool().catch(() => {});
  }
});
