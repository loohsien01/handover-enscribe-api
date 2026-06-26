/**
 * Nova pre-visit summary save — Bedrock E2E for POST …/completions-and-save-pre-visit-summary.
 *
 * **Not** in `npm test` / `runAll.js` — suffix `.e2e.test.js` marks opt-in suites.
 *
 * Full flow: create session → save-pre-visit-summary (one FE-assembled plain-text message) →
 * poll until complete → assert pre_visit_summary_id, embedded pre_visit_summary, pre_visit_summary_title_details
 * (async Haiku extraction), GET /api/pre-visit-summaries/:id, and GET …/pre-visit-summary.
 *
 * Prerequisites:
 * - Fastify running (`npm run dev:fastify`)
 * - `REDIS_URL`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD` in `.env.local`
 * - pre_visit_summaries (with chat_id) + nova_chat_completion_jobs.pre_visit_summary_id migrations applied
 * - Bedrock credentials / IAM on the API host
 *
 * Env: `NOVA_PRE_VISIT_SUMMARY_E2E_MODEL` (default sonnet), `NOVA_E2E_COMPLETION_TIMEOUT_MS` (default 120000),
 *   `NOVA_E2E_TITLE_POLL_TIMEOUT_MS` (default 30000).
 *
 * Run: `npm run test:nova-save-pre-visit-summary-e2e`
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
  getTestAccount,
  hasTestAccounts,
  checkRedisReachableForTests,
} from './testConfig.js';

const E2E_MODEL = (process.env.NOVA_PRE_VISIT_SUMMARY_E2E_MODEL || 'sonnet').toLowerCase();
const COMPLETION_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.NOVA_E2E_COMPLETION_TIMEOUT_MS || '120000', 10);
  return Number.isFinite(n) && n >= 10_000 ? n : 120_000;
})();
const TITLE_POLL_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.NOVA_E2E_TITLE_POLL_TIMEOUT_MS || '30000', 10);
  return Number.isFinite(n) && n >= 3_000 ? n : 30_000;
})();
const POLL_MS = 400;

const NOVA_DEFAULT_TITLE = 'New Chat';
const E2E_PATIENT_NAME = 'Test Doe';

/**
 * FE-assembled turn-1 user message: instructions + pasted prior chart text in one string.
 */
const PRE_VISIT_SUMMARY_USER_MESSAGE = `Create a concise pre-visit summary document for today's follow-up for patient ${E2E_PATIENT_NAME}.

Use short bullet points under: Key issues, Meds, Follow-up questions.
Tone: clinical, scannable. Do not invent data beyond the charts below.

--- Prior visit 1 (2026-05-10, note id 10001, patient: ${E2E_PATIENT_NAME}) ---
CC: Fatigue and occasional dizziness.
Assessment: Hypertension, suboptimal control. Type 2 diabetes, stable.
Plan: Continue lisinopril 10 mg daily. Recheck BMP in 3 months. Discuss home BP log.

--- Prior visit 2 (2026-06-02, note id 10042, patient: ${E2E_PATIENT_NAME}) ---
CC: Follow-up HTN; reports improved energy.
Vitals: BP 128/82 (home avg). A1c 7.1%.
Assessment: HTN improved. DM at goal.
Plan: Continue current meds. Encourage low-sodium diet and walking 30 min/day.`;

/** @param {string} label */
function logStep(label) {
  console.log(`[nova-save-pre-visit-summary.e2e] ${label}`);
}

/** @returns {Promise<string | false>} */
async function e2eSkipReason() {
  if (!hasTestAccounts()) {
    return 'Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local';
  }
  try {
    const health = await fetch(`${getApiBaseUrl()}/health`);
    if (!health.ok) {
      return `Server not healthy at ${getApiBaseUrl()} (start npm run dev:fastify)`;
    }
  } catch {
    return `Server not reachable at ${getApiBaseUrl()}`;
  }
  const redisCheck = await checkRedisReachableForTests();
  if (!redisCheck.ok) {
    return `Redis required: ${redisCheck.message}`;
  }
  if (!['haiku', 'sonnet', 'opus'].includes(E2E_MODEL)) {
    return `NOVA_PRE_VISIT_SUMMARY_E2E_MODEL must be haiku, sonnet, or opus (got: ${E2E_MODEL})`;
  }
  return false;
}

/**
 * @param {string} base
 * @param {Record<string, string>} authHeaders
 * @param {string} chatId
 * @param {string} jobId
 * @param {number} timeoutMs
 */
async function pollCompletionJobUntilTerminal(base, authHeaders, chatId, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await makeRequest(
      'GET',
      `${base}/api/nova/chat-sessions/${chatId}/completion-jobs/${jobId}`,
      { headers: authHeaders, expectedStatus: 200 }
    );
    assert.equal(res.passed, true, JSON.stringify(res.body));
    const st = res.body?.status;
    if (st === 'complete' || st === 'failed') {
      return res;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error('poll timeout waiting for completion job');
}

/**
 * After terminal job poll, re-poll until pre_visit_summary_title_details appears (fire-and-forget Haiku).
 *
 * @param {string} base
 * @param {Record<string, string>} authHeaders
 * @param {string} chatId
 * @param {string} jobId
 * @param {number} timeoutMs
 */
async function pollCompletionJobForPreVisitSummaryTitleDetails(base, authHeaders, chatId, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await makeRequest(
      'GET',
      `${base}/api/nova/chat-sessions/${chatId}/completion-jobs/${jobId}`,
      { headers: authHeaders, expectedStatus: 200 }
    );
    assert.equal(res.passed, true, JSON.stringify(res.body));
    const details = res.body?.pre_visit_summary_title_details;
    if (
      details != null &&
      typeof details.patient_display_name === 'string' &&
      details.patient_display_name.trim().length > 0 &&
      (details.visit_kind === 'F/U' || details.visit_kind === 'NP')
    ) {
      return { pollRes: res, titleDetails: details };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error('poll timeout waiting for pre_visit_summary_title_details on completion job');
}

/**
 * @param {unknown} details
 */
function assertPreVisitSummaryTitleDetails(details) {
  assert.ok(details != null && typeof details === 'object');
  assert.equal(typeof details.patient_display_name, 'string');
  assert.equal(details.patient_display_name, E2E_PATIENT_NAME);
  assert.ok(details.visit_kind === 'F/U' || details.visit_kind === 'NP');
}

test('1: completions-and-save-pre-visit-summary → complete + pre_visit_summary persisted', async (t) => {
  const skip = await e2eSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const base = getApiBaseUrl();
  const account = getTestAccount('primary');
  assert.ok(account?.email && account?.password);

  logStep('sign-in…');
  const signIn = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'sign-in',
      email: account.email,
      password: account.password,
    }),
  });
  assert.equal(signIn.ok, true);
  const authData = await signIn.json();
  const token = authData?.token?.access_token;
  assert.ok(typeof token === 'string');
  const authHeaders = { Authorization: `Bearer ${token}` };

  logStep('POST /nova/chat-sessions…');
  const createRes = await makeRequest('POST', `${base}/api/nova/chat-sessions`, {
    headers: authHeaders,
    expectedStatus: 201,
    timeoutMs: 30_000,
  });
  assert.equal(createRes.passed, true, JSON.stringify(createRes.body));
  const chatId = createRes.body?.chatId;
  assert.ok(typeof chatId === 'string');

  const userMessage = PRE_VISIT_SUMMARY_USER_MESSAGE;

  logStep(`POST /completions-and-save-pre-visit-summary (model=${E2E_MODEL})…`);
  const clientMessageId = randomUUID();
  const enqueue = await makeRequest(
    'POST',
    `${base}/api/nova/chat-sessions/${chatId}/completions-and-save-pre-visit-summary`,
    {
      headers: authHeaders,
      body: {
        model: E2E_MODEL,
        message: userMessage,
        client_message_id: clientMessageId,
      },
      expectedStatus: 202,
      timeoutMs: 30_000,
    }
  );
  assert.equal(enqueue.passed, true, JSON.stringify(enqueue.body));
  const jobId = enqueue.body?.id;
  assert.ok(typeof jobId === 'string');
  assert.equal(enqueue.body?.status, 'pending');
  assert.equal(enqueue.body?.chat_id, chatId);

  logStep(`poll job (up to ${COMPLETION_TIMEOUT_MS}ms)…`);
  const pollRes = await pollCompletionJobUntilTerminal(
    base,
    authHeaders,
    chatId,
    jobId,
    COMPLETION_TIMEOUT_MS
  );
  const final = pollRes.body;
  assert.equal(
    final?.status,
    'complete',
    `expected complete, got ${final?.status}: ${final?.code || ''} ${final?.error || ''}`
  );

  const assistantText = final?.assistant?.content;
  assert.equal(typeof assistantText, 'string');
  assert.ok(assistantText.trim().length >= 1);

  const usage = final?.usage;
  assert.ok(usage != null, 'missing usage on complete poll');
  assert.equal(typeof usage.input_tokens, 'number');
  assert.equal(typeof usage.output_tokens, 'number');

  const preVisitSummaryId = final?.pre_visit_summary_id;
  assert.ok(typeof preVisitSummaryId === 'string' && preVisitSummaryId.length > 0, 'missing pre_visit_summary_id');

  const embedded = final?.pre_visit_summary;
  assert.ok(embedded != null, 'missing embedded pre_visit_summary');
  assert.equal(embedded.id, preVisitSummaryId);
  assert.equal(embedded.chat_id, chatId);
  assert.equal(embedded.text, assistantText);

  assert.equal(
    final?.session?.title,
    NOVA_DEFAULT_TITLE,
    'save route does not write sidebar title; FE PATCHes after pre_visit_summary_title_details'
  );

  logStep(`poll pre_visit_summary_title_details (up to ${TITLE_POLL_TIMEOUT_MS}ms)…`);
  const { titleDetails } = await pollCompletionJobForPreVisitSummaryTitleDetails(
    base,
    authHeaders,
    chatId,
    jobId,
    TITLE_POLL_TIMEOUT_MS
  );
  assertPreVisitSummaryTitleDetails(titleDetails);
  logStep(
    `pre_visit_summary_title_details: ${titleDetails.patient_display_name}, ${titleDetails.visit_kind}`
  );

  logStep('GET /api/pre-visit-summaries/:id…');
  const getPrep = await makeRequest('GET', `${base}/api/pre-visit-summaries/${preVisitSummaryId}`, {
    headers: authHeaders,
    expectedStatus: 200,
  });
  assert.equal(getPrep.passed, true);
  assert.equal(getPrep.body?.id, preVisitSummaryId);
  assert.equal(getPrep.body?.chat_id, chatId);
  assert.equal(getPrep.body?.text, assistantText);

  logStep('GET …/completion-jobs/:jobId/pre-visit-summary…');
  const getJobPrep = await makeRequest(
    'GET',
    `${base}/api/nova/chat-sessions/${chatId}/completion-jobs/${jobId}/pre-visit-summary`,
    { headers: authHeaders, expectedStatus: 200 }
  );
  assert.equal(getJobPrep.passed, true);
  assert.equal(getJobPrep.body?.id, preVisitSummaryId);
  assert.equal(getJobPrep.body?.chat_id, chatId);
  assert.equal(getJobPrep.body?.text, assistantText);

  logStep('cleanup: DELETE /api/pre-visit-summaries/:id…');
  const del = await makeRequest('DELETE', `${base}/api/pre-visit-summaries/${preVisitSummaryId}`, {
    headers: authHeaders,
    expectedStatus: 200,
  });
  assert.equal(del.passed, true);

  logStep(
    `OK — pre_visit_summary_id=${preVisitSummaryId}, title_details=${titleDetails.patient_display_name}, ${titleDetails.visit_kind}, assistant chars=${assistantText.length}`
  );
});
