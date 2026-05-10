/**
 * Nova — `POST /api/nova/chat-sessions/:chatId/completions`
 *
 * Standard: auth, Zod, 404 (no Bedrock). Optional Bedrock E2E: two completions + GET; asserts JSON
 * shape and `usage` from the API (not assistant prose matching magic strings — models may refuse).
 *
 * `skipE2ETest` (below): `true` = default, API tests only. Set `false` to append Test 8 (Bedrock).
 * Env: `API_BASE_URL`, `REDIS_URL`, `TEST_ACCOUNT_*`. E2E: `NOVA_E2E_MODEL`, `NOVA_E2E_COMPLETION_TIMEOUT_MS`.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner, makeRequest } from './testUtils.js';
import {
  getTestAccount,
  hasTestAccounts,
  getApiBaseUrl,
  checkRedisReachableForTests,
} from './testConfig.js';

// ---------------------------------------------------------------------------
// `true` = skip Bedrock E2E (default). Set `false` to run Test 8 (uses tokens).
// ---------------------------------------------------------------------------
const skipE2ETest = true;

const E2E_MODEL = (process.env.NOVA_E2E_MODEL || 'haiku').toLowerCase();
const COMPLETION_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.NOVA_E2E_COMPLETION_TIMEOUT_MS || '120000', 10);
  return Number.isFinite(n) && n >= 10_000 ? n : 120_000;
})();

const PLACEHOLDER_CHAT_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_CHAT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/**
 * Bedrock/InvokeModel normally returns usage; API forwards it on 200 responses.
 * @param {unknown} body - completions JSON body
 * @param {string} turnLabel
 * @returns {{ ok: boolean, msg: string }}
 */
function expectCompletionUsage(body, turnLabel) {
  const u = body?.usage;
  if (u == null) {
    return {
      ok: false,
      msg: `${turnLabel}: missing usage (expected input_tokens, output_tokens from Bedrock via API)`,
    };
  }
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') {
    return { ok: false, msg: `${turnLabel}: usage must include numeric input_tokens and output_tokens` };
  }
  if (u.input_tokens < 0 || u.output_tokens < 0) {
    return { ok: false, msg: `${turnLabel}: token counts must be non-negative` };
  }
  const expectedTotal = u.input_tokens + u.output_tokens;
  if (typeof u.total_tokens === 'number' && u.total_tokens !== expectedTotal) {
    return {
      ok: false,
      msg: `${turnLabel}: usage.total_tokens (${u.total_tokens}) should equal in+out (${expectedTotal})`,
    };
  }
  return { ok: true, msg: '' };
}

/**
 * @param {import('./testUtils.js').TestRunner} runner
 */
function pushManualResult(runner, { name, passed, status, body, customMessage, expectedStatus = null }) {
  runner.results.push({
    name,
    passed,
    endpoint: '(multi-step)',
    method: '—',
    status,
    expectedStatus,
    body: body ?? {},
    customMessage: customMessage || '',
    testNumber: null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * @param {import('./testUtils.js').TestRunner} runner
 * @param {Record<string, string>} authHeaders
 * @returns {Promise<void>}
 */
async function appendBedrockE2E(runner, authHeaders) {
  const base = runner.baseUrl;
  let failMessage = '';

  if (!['haiku', 'sonnet', 'opus'].includes(E2E_MODEL)) {
    console.error(`NOVA_E2E_MODEL must be haiku, sonnet, or opus (got: ${E2E_MODEL})\n`);
    throw new Error('Invalid NOVA_E2E_MODEL');
  }

  console.log('\n--- Bedrock E2E (Test 8) ---');
  console.log(`model: ${E2E_MODEL} | timeout: ${COMPLETION_TIMEOUT_MS}ms\n`);

  const createRes = await makeRequest('POST', `${base}/api/nova/chat-sessions`, {
    headers: authHeaders,
    expectedStatus: 201,
  });
  if (!createRes.passed || !createRes.body?.chatId) {
    failMessage = `Create session failed (status ${createRes.status})`;
    pushManualResult(runner, {
      name: 'Test 8: Bedrock E2E — session + 2× completions + GET',
      passed: false,
      status: createRes.status,
      body: createRes.body,
      customMessage: failMessage,
      expectedStatus: 201,
    });
    return;
  }
  const chatId = createRes.body.chatId;
  console.log(`✓ chatId ${chatId}`);

  // Avoid asking the model to echo arbitrary tokens — many models refuse (policy), which breaks E2E
  // even when the API and Bedrock are healthy. Use benign factual prompts; assert JSON shape + usage.
  console.log('  … Bedrock turn 1 (may take ~10–60s)');
  const c1 = await makeRequest('POST', `${base}/api/nova/chat-sessions/${chatId}/completions`, {
    headers: authHeaders,
    body: { model: E2E_MODEL, message: 'What is 2+2? Answer with a single digit only.' },
    expectedStatus: 200,
    timeoutMs: COMPLETION_TIMEOUT_MS,
  });
  const m1 = c1.body?.session?.messages;
  const a1 = c1.body?.assistant?.content;
  const u1 = expectCompletionUsage(c1.body, 'Turn 1');
  if (
    !c1.passed ||
    typeof a1 !== 'string' ||
    a1.trim().length < 1 ||
    !Array.isArray(m1) ||
    m1.length < 2 ||
    m1[0].role !== 'user' ||
    m1[1].role !== 'assistant' ||
    !u1.ok
  ) {
    failMessage = u1.ok
      ? 'Turn 1: expected 200, assistant string, session.messages [user, assistant]'
      : u1.msg;
    pushManualResult(runner, {
      name: 'Test 8: Bedrock E2E — session + 2× completions + GET',
      passed: false,
      status: c1.status,
      body: c1.body,
      customMessage: failMessage,
      expectedStatus: 200,
    });
    return;
  }
  console.log(`  → assistant (excerpt): ${String(a1).slice(0, 200)}${String(a1).length > 200 ? '…' : ''}`);
  console.log(
    `  → usage: in=${c1.body.usage.input_tokens} out=${c1.body.usage.output_tokens} total=${c1.body.usage.total_tokens} model=${c1.body.usage.model || '?'}`
  );

  console.log('\n  … Bedrock turn 2');
  const c2 = await makeRequest('POST', `${base}/api/nova/chat-sessions/${chatId}/completions`, {
    headers: authHeaders,
    body: {
      model: E2E_MODEL,
      message: 'What is 3+3? Answer with a single digit only.',
    },
    expectedStatus: 200,
    timeoutMs: COMPLETION_TIMEOUT_MS,
  });
  const m2 = c2.body?.session?.messages;
  const a2 = c2.body?.assistant?.content;
  const u2 = expectCompletionUsage(c2.body, 'Turn 2');
  if (
    !c2.passed ||
    typeof a2 !== 'string' ||
    a2.trim().length < 1 ||
    !Array.isArray(m2) ||
    m2.length < 4 ||
    m2[2].role !== 'user' ||
    m2[3].role !== 'assistant' ||
    !u2.ok
  ) {
    failMessage = u2.ok
      ? 'Turn 2: expected 200 and ≥4 messages (user/assistant/user/assistant)'
      : u2.msg;
    pushManualResult(runner, {
      name: 'Test 8: Bedrock E2E — session + 2× completions + GET',
      passed: false,
      status: c2.status,
      body: c2.body,
      customMessage: failMessage,
      expectedStatus: 200,
    });
    return;
  }
  console.log(`  → assistant (excerpt): ${String(a2).slice(0, 200)}${String(a2).length > 200 ? '…' : ''}`);
  console.log(
    `  → usage: in=${c2.body.usage.input_tokens} out=${c2.body.usage.output_tokens} total=${c2.body.usage.total_tokens} model=${c2.body.usage.model || '?'}`
  );

  console.log('\n  … GET session');
  const getRes = await makeRequest('GET', `${base}/api/nova/chat-sessions/${chatId}`, {
    headers: authHeaders,
    expectedStatus: 200,
  });
  const msgs = getRes.body?.session?.messages;
  let passed = true;
  if (!getRes.passed || !Array.isArray(msgs) || msgs.length < 4) {
    passed = false;
    failMessage = 'GET: expected 200 and ≥4 messages';
  } else {
    for (let i = 0; i < 4; i += 1) {
      const expect = i % 2 === 0 ? 'user' : 'assistant';
      if (msgs[i]?.role !== expect) {
        passed = false;
        failMessage = `GET: message[${i}] role want ${expect}, got ${msgs[i]?.role}`;
        break;
      }
    }
  }

  pushManualResult(runner, {
    name: 'Test 8: Bedrock E2E — session + 2× completions + GET',
    passed,
    status: getRes.status,
    body: { lastGET: getRes.body, turn2SessionMessageCount: m2?.length },
    customMessage: passed
      ? `OK — ${msgs.length} messages on GET; LLM replied both turns.`
      : failMessage,
    expectedStatus: 200,
  });

  if (passed) {
    console.log(`  → GET: ${msgs.length} message(s)\n`);
  }
}

export async function runNovaChatSessionsCompletionsTests() {
  const runner = new TestRunner('Nova Chat-Sessions Completions Tests');

  console.log('Starting Nova chat-sessions completions tests...');
  console.log(`Server: ${getApiBaseUrl()}`);
  console.log('POST /api/nova/chat-sessions/:chatId/completions — auth + validation + 404');
  if (skipE2ETest) {
    console.log('Bedrock E2E: skipped (skipE2ETest=true)\n');
  } else {
    console.log('Bedrock E2E: enabled (Test 8)\n');
  }

  const redisCheck = await checkRedisReachableForTests();
  if (!redisCheck.ok) {
    console.error('\n❌ Redis is not reachable or not configured.');
    console.error(`   ${redisCheck.message}`);
    console.error('   Same as nova-chat-sessions: set REDIS_URL in .env.local.\n');
    throw new Error(redisCheck.message);
  }
  console.log('✓ Redis reachable (PING)\n');

  let accessToken = null;

  if (hasTestAccounts()) {
    const testAccount = getTestAccount('primary');
    if (testAccount?.email && testAccount?.password) {
      const signInResponse = await fetch(`${runner.baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sign-in',
          email: testAccount.email,
          password: testAccount.password,
        }),
      });
      if (signInResponse.ok) {
        const authData = await signInResponse.json();
        accessToken = authData.token.access_token;
        console.log('✓ Obtained access token\n');
      }
    }
  }

  await runner.test('Test 1: POST completions without authentication', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    body: { model: 'haiku', message: 'x' },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  if (!accessToken) {
    console.warn('\n⚠️  Skipping Tests 2–7 (and E2E): no access token\n');
    runner.printResults();
    runner.saveResults('nova-chat-sessions-completions-tests.json');
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  await runner.test('Test 2: POST completions invalid chatId (400)', {
    method: 'POST',
    endpoint: '/api/nova/chat-sessions/not-a-uuid/completions',
    headers: authHeaders,
    body: { model: 'haiku', message: 'hello' },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('Test 3: POST completions invalid body — empty object (400)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: {},
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('Test 4: POST completions invalid model enum (400)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'gpt-4o', message: 'hello' },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('Test 5: POST completions empty message (400)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: '' },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('Test 6: POST completions strict body — extra key (400)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: 'hi', extra: true },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('Test 7: POST completions unknown session UUID (404)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${UNKNOWN_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: 'hello' },
    expectedStatus: 404,
    expectedFields: ['error', 'code'],
    customValidator: (data) => {
      if (data?.code !== 'NOVA_SESSION_NOT_FOUND') {
        return { passed: false, message: `Expected code NOVA_SESSION_NOT_FOUND, got ${data?.code}` };
      }
      return { passed: true, message: '' };
    },
  });

  if (!skipE2ETest) {
    await appendBedrockE2E(runner, authHeaders);
  }

  runner.printResults();
  const resultsFile = runner.saveResults('nova-chat-sessions-completions-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runNovaChatSessionsCompletionsTests();
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
