/**
 * Nova summarize queue — E2E (real API + Redis + Bedrock + worker subprocess).
 *
 * **Not** in `npm test` / `runAll.js` — suffix `.e2e.test.js` marks opt-in suites.
 *
 * Prerequisites:
 * 1. `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` in `.env.local` (ignored when server `NODE_ENV=production`).
 * 2. Restart Fastify.
 * 3. Redis, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_ACCOUNT_*`.
 *
 * Run: `npm run test:nova-summarize-queue-e2e`
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(REPO_ROOT, '.env.local') });

import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { test } from 'node:test';
import { createClient } from 'redis';
import { makeRequest } from './testUtils.js';
import {
  getApiBaseUrl,
  getTestAccount,
  hasTestAccounts,
  getRedisUrlForTests,
  checkRedisReachableForTests,
} from './testConfig.js';
import { NOVA_SUMMARIZE_QUEUE_KEY } from '../src/utils/novaSummarizeQueue.js';
import { resolveNovaBedrockModelId } from '../src/utils/bedrockClaudeModels.js';
import { getNovaChatCompletionRequestBody } from '../src/utils/claudeRequestBody.js';
import {
  normalizeNovaSessionShape,
  novaPriorDialogMessagesForBedrock,
} from '../src/utils/novaRedisSession.js';

const RESULTS_FILE = 'nova-summarize-queue-e2e.json';
const COMPLETION_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.NOVA_E2E_COMPLETION_TIMEOUT_MS || '120000', 10);
  return Number.isFinite(n) && n >= 10_000 ? n : 120_000;
})();
const POLL_MS = 500;
const WORKER_WAIT_MS = 90_000;
const MODEL = (process.env.NOVA_E2E_MODEL || 'haiku').toLowerCase();

/**
 * @param {string} base
 * @param {Record<string, string>} authHeaders
 * @param {string} chatId
 * @param {string} jobId
 * @param {number} timeoutMs
 */
async function pollNovaCompletionJobUntilTerminal(base, authHeaders, chatId, jobId, timeoutMs) {
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
  throw new Error('poll timeout waiting for Nova completion job');
}

/** @returns {string | false} */
function e2eSkipReason() {
  if (process.env.NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE !== '1') {
    return 'Set NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1 in .env.local and restart Fastify (non-production NODE_ENV).';
  }
  if (!hasTestAccounts()) {
    return 'TEST_ACCOUNT_EMAIL / TEST_ACCOUNT_PASSWORD not set.';
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return 'SUPABASE_SERVICE_ROLE_KEY required for the worker process.';
  }
  return false;
}

/**
 * @param {string} base
 * @param {Record<string, string>} authHeaders
 * @param {string} chatId
 * @param {import('redis').RedisClientType} redis
 * @param {number} deadline
 */
async function pollUntilSummarized(base, authHeaders, chatId, redis, deadline) {
  let last = {};
  while (Date.now() < deadline) {
    const getRes = await makeRequest('GET', `${base}/api/nova/chat-sessions/${chatId}`, {
      headers: authHeaders,
      expectedStatus: 200,
    });
    assert.equal(getRes.passed, true);
    last = getRes.body || {};
    const s = last.session;
    await redis.lLen(NOVA_SUMMARIZE_QUEUE_KEY);
    if (
      s &&
      typeof s.summary === 'string' &&
      s.summary.trim().length >= 15 &&
      s.summarize_pending === false
    ) {
      return s;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

test(
  'queue + worker: two completion rounds; checkpoint clears dialog tail for next Bedrock request',
  { skip: e2eSkipReason() },
  async (t) => {
    const redisUrl = getRedisUrlForTests();
    if (!redisUrl) {
      t.skip('REDIS_URL not set');
      return;
    }
    const redisPing = await checkRedisReachableForTests();
    if (!redisPing.ok) {
      t.skip(redisPing.message);
      return;
    }

    const base = getApiBaseUrl();
    const account = getTestAccount('primary');
    assert.ok(account?.email && account?.password);

    const signIn = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign-in',
        email: account.email,
        password: account.password,
      }),
    });
    assert.equal(signIn.ok, true, `sign-in failed ${signIn.status}`);
    const authJson = await signIn.json();
    const accessToken = authJson?.token?.access_token;
    assert.ok(typeof accessToken === 'string' && accessToken.length > 0, 'no access_token');

    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    const workerScript = path.join(REPO_ROOT, 'src/workers/novaSummarizeWorker.js');
    const worker = spawn(process.execPath, [workerScript], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderrChunks = [];
    worker.stderr?.on('data', (c) => stderrChunks.push(c));

    const started = Date.now();
    const redis = createClient({ url: redisUrl });
    redis.on('error', () => {});

    try {
      await new Promise((r) => setTimeout(r, 2000));
      await redis.connect();

      const createRes = await makeRequest('POST', `${base}/api/nova/chat-sessions`, {
        headers: authHeaders,
        expectedStatus: 201,
      });
      assert.equal(createRes.passed, true, JSON.stringify(createRes.body));
      const chatId = createRes.body?.chatId;
      assert.ok(chatId);

      const completion1Post = await makeRequest(
        'POST',
        `${base}/api/nova/chat-sessions/${chatId}/completions`,
        {
          headers: authHeaders,
          body: {
            model: MODEL,
            message: 'For testing only: one sentence on why azithromycin is not a penicillin.',
            client_message_id: randomUUID(),
          },
          expectedStatus: 202,
          timeoutMs: 30_000,
        }
      );
      assert.equal(completion1Post.passed, true, JSON.stringify(completion1Post.body));
      const job1 = completion1Post.body?.id;
      assert.ok(typeof job1 === 'string' && job1.length > 0, 'job id from 202');
      const completion1 = await pollNovaCompletionJobUntilTerminal(
        base,
        authHeaders,
        chatId,
        job1,
        COMPLETION_TIMEOUT_MS
      );
      assert.equal(completion1.body?.status, 'complete', JSON.stringify(completion1.body));
      assert.ok(completion1.body?.session?.summarize_pending === true, 'expected enqueue (test force)');

      const deadline1 = Date.now() + WORKER_WAIT_MS;
      const s1 = await pollUntilSummarized(base, authHeaders, chatId, redis, deadline1);
      assert.ok(s1, 'timeout waiting for worker after completion 1');
      normalizeNovaSessionShape(s1);
      assert.equal(
        s1.summary_covered_message_count,
        s1.messages.length,
        'checkpoint should cover all messages after summarize'
      );
      assert.equal(novaPriorDialogMessagesForBedrock(s1).length, 0, 'no dialog tail — only summary + next user');

      const modelId = resolveNovaBedrockModelId(MODEL);
      assert.ok(modelId);
      const probeBody = getNovaChatCompletionRequestBody({
        modelId,
        summary: s1.summary,
        priorMessages: novaPriorDialogMessagesForBedrock(s1),
        userMessage: 'Second turn: reply with one word: BANANA',
      });
      assert.equal(
        probeBody.messages.length,
        1,
        'next Bedrock turn should not repeat folded user/assistant pairs as chat messages'
      );

      const completion2Post = await makeRequest(
        'POST',
        `${base}/api/nova/chat-sessions/${chatId}/completions`,
        {
          headers: authHeaders,
          body: {
            model: MODEL,
            message: 'Second turn: reply with one word: BANANA',
            client_message_id: randomUUID(),
          },
          expectedStatus: 202,
          timeoutMs: 30_000,
        }
      );
      assert.equal(completion2Post.passed, true, JSON.stringify(completion2Post.body));
      const job2 = completion2Post.body?.id;
      assert.ok(typeof job2 === 'string');
      const completion2 = await pollNovaCompletionJobUntilTerminal(
        base,
        authHeaders,
        chatId,
        job2,
        COMPLETION_TIMEOUT_MS
      );
      assert.equal(completion2.body?.status, 'complete');
      assert.ok(completion2.body?.session?.messages?.length === 4);
      assert.ok(completion2.body?.session?.summarize_pending === true);

      const deadline2 = Date.now() + WORKER_WAIT_MS;
      const s2 = await pollUntilSummarized(base, authHeaders, chatId, redis, deadline2);
      assert.ok(s2, 'timeout waiting for worker after completion 2');
      normalizeNovaSessionShape(s2);
      assert.equal(s2.messages.length, 4);
      assert.equal(s2.summary_covered_message_count, 4);
      assert.equal(novaPriorDialogMessagesForBedrock(s2).length, 0);

      const queuePeek = await redis.lLen(NOVA_SUMMARIZE_QUEUE_KEY);
      const payload = {
        suite: 'nova-summarize-queue-e2e',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - started,
        passed: true,
        chat_id: chatId,
        api_base_url: base,
        model: MODEL,
        redis_queue_length_after: queuePeek,
        round1_summary_excerpt: s1.summary.slice(0, 400),
        round2_summary_excerpt: s2.summary.slice(0, 400),
      };
      const dir = path.join(REPO_ROOT, 'test-results');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, RESULTS_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`Wrote test-results/${RESULTS_FILE}`);
    } catch (err) {
      const errText = Buffer.concat(stderrChunks).toString('utf8').slice(-4000);
      console.error('Worker stderr (tail):', errText);
      throw err;
    } finally {
      try {
        await redis.quit();
      } catch {
        // ignore
      }
      worker.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
);
