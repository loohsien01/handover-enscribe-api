/**
 * Nova chat completions — Bedrock E2E (real API + Redis + Bedrock + AI session title).
 *
 * **Not** in `npm test` / `runAll.js` — suffix `.e2e.test.js` marks opt-in suites.
 *
 * Two completion turns + GET; asserts JSON shape and `usage` (not assistant prose).
 * After turn 1, polls until `session.title` updates from `"New Chat"`.
 *
 * Prerequisites:
 * - Fastify running (`npm run dev:fastify`)
 * - `REDIS_URL`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD` in `.env.local`
 * - Migrations: `20260507_nova_chat_sessions.sql`, `20260616_chat_sessions_title.sql`,
 *   `20260514_nova_chat_completion_jobs.sql` (+ enum migration if needed)
 * - Bedrock credentials / IAM on the API host
 *
 * Env: `NOVA_E2E_MODEL` (default haiku), `NOVA_E2E_COMPLETION_TIMEOUT_MS` (default 120000),
 *   `NOVA_E2E_TITLE_POLL_TIMEOUT_MS` (default 30000).
 *
 * Run: `npm run test:nova-chat-sessions-completions-e2e`
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

const E2E_MODEL = (process.env.NOVA_E2E_MODEL || 'haiku').toLowerCase();
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
const NOVA_TITLE_MAX_LENGTH = 40;

/** @param {string} label */
function logStep(label) {
  console.log(`[nova-chat-sessions-completions.e2e] ${label}`);
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
    return `NOVA_E2E_MODEL must be haiku, sonnet, or opus (got: ${E2E_MODEL})`;
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
 * @param {unknown} body
 * @param {string} turnLabel
 */
function assertCompletionUsage(body, turnLabel) {
  const u = body?.usage;
  assert.ok(u != null, `${turnLabel}: missing usage`);
  assert.equal(typeof u.input_tokens, 'number');
  assert.equal(typeof u.output_tokens, 'number');
  assert.ok(u.input_tokens >= 0 && u.output_tokens >= 0);
  if (typeof u.total_tokens === 'number') {
    assert.equal(u.total_tokens, u.input_tokens + u.output_tokens);
  }
}

/**
 * @param {unknown} title
 */
function assertGeneratedSessionTitle(title) {
  assert.equal(typeof title, 'string');
  assert.ok(title.trim().length > 0);
  assert.notEqual(title, NOVA_DEFAULT_TITLE);
  assert.ok(title.length <= NOVA_TITLE_MAX_LENGTH);
}

/**
 * @param {string} base
 * @param {Record<string, string>} authHeaders
 * @param {string} chatId
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function pollSessionTitleUntilGenerated(base, authHeaders, chatId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTitle = NOVA_DEFAULT_TITLE;
  while (Date.now() < deadline) {
    const res = await makeRequest('GET', `${base}/api/nova/chat-sessions/${chatId}`, {
      headers: authHeaders,
      expectedStatus: 200,
    });
    assert.equal(res.passed, true);
    lastTitle = res.body?.session?.title ?? NOVA_DEFAULT_TITLE;
    try {
      assertGeneratedSessionTitle(lastTitle);
      return lastTitle;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `Title still "${lastTitle}" after ${timeoutMs}ms (expected AI title after first completion)`
  );
}

test('1: session + 2× completions + AI title + GET', async (t) => {
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

  logStep(`POST /nova/chat-sessions (model=${E2E_MODEL}, completion timeout=${COMPLETION_TIMEOUT_MS}ms)…`);
  const createRes = await makeRequest('POST', `${base}/api/nova/chat-sessions`, {
    headers: authHeaders,
    expectedStatus: 201,
    timeoutMs: 30_000,
  });
  assert.equal(createRes.passed, true, JSON.stringify(createRes.body));
  const chatId = createRes.body?.chatId;
  assert.ok(typeof chatId === 'string');
  assert.equal(createRes.body?.session?.title, NOVA_DEFAULT_TITLE);

  logStep('turn 1: POST /completions…');
  const clientId1 = randomUUID();
  const c1 = await makeRequest('POST', `${base}/api/nova/chat-sessions/${chatId}/completions`, {
    headers: authHeaders,
    body: {
      model: E2E_MODEL,
      message: 'What is 2+2? Answer with a single digit only.',
      client_message_id: clientId1,
    },
    expectedStatus: 202,
    timeoutMs: 30_000,
  });
  assert.equal(c1.passed, true);
  const job1 = c1.body?.id;
  assert.ok(typeof job1 === 'string');

  logStep('turn 1: poll job…');
  const poll1 = await pollCompletionJobUntilTerminal(base, authHeaders, chatId, job1, COMPLETION_TIMEOUT_MS);
  const c1Final = poll1.body;
  assert.equal(c1Final?.status, 'complete');
  assertCompletionUsage(c1Final, 'turn 1');
  const a1 = c1Final?.assistant?.content;
  assert.equal(typeof a1, 'string');
  assert.ok(a1.trim().length >= 1);
  const m1 = c1Final?.session?.messages;
  assert.ok(Array.isArray(m1) && m1.length >= 2);
  assert.equal(m1[0].role, 'user');
  assert.equal(m1[1].role, 'assistant');

  logStep(`poll session.title (up to ${TITLE_POLL_TIMEOUT_MS}ms)…`);
  const titleAfterTurn1 = await pollSessionTitleUntilGenerated(
    base,
    authHeaders,
    chatId,
    TITLE_POLL_TIMEOUT_MS
  );
  logStep(`title after turn 1: "${titleAfterTurn1}"`);

  logStep('turn 2: POST /completions…');
  const clientId2 = randomUUID();
  const c2post = await makeRequest('POST', `${base}/api/nova/chat-sessions/${chatId}/completions`, {
    headers: authHeaders,
    body: {
      model: E2E_MODEL,
      message: 'What is 3+3? Answer with a single digit only.',
      client_message_id: clientId2,
    },
    expectedStatus: 202,
    timeoutMs: 30_000,
  });
  assert.equal(c2post.passed, true);
  const job2 = c2post.body?.id;
  assert.ok(typeof job2 === 'string');

  logStep('turn 2: poll job…');
  const poll2 = await pollCompletionJobUntilTerminal(base, authHeaders, chatId, job2, COMPLETION_TIMEOUT_MS);
  const c2 = poll2.body;
  assert.equal(c2?.status, 'complete');
  assertCompletionUsage(c2, 'turn 2');
  const a2 = c2?.assistant?.content;
  assert.equal(typeof a2, 'string');
  assert.ok(a2.trim().length >= 1);
  const m2 = c2?.session?.messages;
  assert.ok(Array.isArray(m2) && m2.length >= 4);
  assert.equal(m2[2].role, 'user');
  assert.equal(m2[3].role, 'assistant');

  logStep('GET session…');
  const getRes = await makeRequest('GET', `${base}/api/nova/chat-sessions/${chatId}`, {
    headers: authHeaders,
    expectedStatus: 200,
  });
  assert.equal(getRes.passed, true);
  const msgs = getRes.body?.session?.messages;
  assert.ok(Array.isArray(msgs) && msgs.length >= 4);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(msgs[i]?.role, i % 2 === 0 ? 'user' : 'assistant');
  }
  assert.equal(getRes.body?.session?.title, titleAfterTurn1);
  logStep(`OK — ${msgs.length} messages, title stable: "${titleAfterTurn1}"`);
});
