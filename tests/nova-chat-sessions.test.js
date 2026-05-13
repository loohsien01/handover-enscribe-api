/**
 * Test Suite: Nova AI — Redis chat sessions API
 * Requires: Fastify server, Redis, REDIS_URL in .env.local (same as server); optional REDIS_AUTH_TOKEN
 * Requires: TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local
 * Requires: Supabase migrations including chat_sessions / chat_messages / chat_token_usage
 *   (`sql/migrations/20260507_nova_chat_sessions.sql`) and organizations billing tables.
 *
 * Does not call Bedrock or `POST .../completions`. Saved JSON has no assistant/LLM turns — only
 * PATCH append (e.g. `nova-test-message`). Completions + optional Bedrock E2E:
 * `tests/nova-chat-sessions-completions.test.js` (`npm run test:nova-chat-sessions-completions`);
 * set `skipE2ETest = false` there to run Test 8.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { TestRunner } from './testUtils.js';
import {
  getTestAccount,
  hasTestAccounts,
  getApiBaseUrl,
  checkRedisReachableForTests,
} from './testConfig.js';

const runner = new TestRunner('Nova Chat Sessions API Tests');

let accessToken = null;
/** @type {string | null} */
let cachedChatId = null;

/** Valid UUID for routes where only auth outcome matters */
const PLACEHOLDER_CHAT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * @param {unknown} data
 * @returns {{ passed: boolean, message: string }}
 */
function expectChatSessionShape(data) {
  if (!data || typeof data !== 'object') {
    return { passed: false, message: 'Response body is not an object' };
  }
  const s = /** @type {{ messages?: unknown, summary?: unknown, last_active?: unknown, token_estimate?: unknown, chat_id?: unknown }} */ (data);
  if (typeof s.chat_id !== 'string') {
    return { passed: false, message: 'session.chat_id missing or not a string' };
  }
  if (!Array.isArray(s.messages)) {
    return { passed: false, message: 'session.messages is not an array' };
  }
  if (typeof s.summary !== 'string') {
    return { passed: false, message: 'session.summary is not a string' };
  }
  if (typeof s.last_active !== 'number') {
    return { passed: false, message: 'session.last_active is not a number' };
  }
  if (typeof s.token_estimate !== 'number') {
    return { passed: false, message: 'session.token_estimate is not a number' };
  }
  return { passed: true, message: '' };
}

/**
 * Run all Nova chat session tests
 */
export async function runNovaChatSessionsTests() {
  console.log('Starting Nova Chat Sessions API tests...');
  console.log(`Server: ${getApiBaseUrl()}`);
  console.log('Note: These tests require JWT auth, Redis, and REDIS_URL\n');

  const redisCheck = await checkRedisReachableForTests();
  if (!redisCheck.ok) {
    console.error('\n❌ Redis is not reachable or not configured.');
    console.error(`   ${redisCheck.message}`);
    console.error('   Set REDIS_URL in .env.local (e.g. redis://127.0.0.1:6379) — same value as for npm run dev:fastify.');
    console.error('   Start Redis locally (e.g. redis-server in a terminal, or Docker).');
    console.error('   Then re-run: npm run test:nova-chat-sessions\n');
    throw new Error(redisCheck.message);
  }
  console.log('✓ Redis reachable (PING)\n');

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
        console.log('✓ Obtained valid access token from test account\n');
      } else {
        console.log('⚠️  Could not obtain access token from test account');
        console.log('   Verify TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
      }
    }
  } else {
    console.log('⚠️  Test credentials not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
  }

  await runner.test('Test 1: POST /api/nova/chat-sessions without authentication', {
    method: 'POST',
    endpoint: '/api/nova/chat-sessions',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  await runner.test('Test 1b: GET /api/nova/chat-sessions without authentication', {
    method: 'GET',
    endpoint: '/api/nova/chat-sessions',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  if (!accessToken) {
    console.warn('\n⚠️  Skipping Tests 2–12: No valid access token available');
    console.log('To run the full suite: set TEST_ACCOUNT_* in .env.local and ensure the server is running.\n');
    runner.printResults();
    const resultsFile = runner.saveResults('nova-chat-sessions-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  await runner.test('Test 2a: GET /api/nova/chat-sessions invalid limit (400)', {
    method: 'GET',
    endpoint: '/api/nova/chat-sessions?limit=101',
    headers: authHeaders,
    expectedStatus: 400,
  });

  await runner.test('Test 2: POST /api/nova/chat-sessions creates session', {
    method: 'POST',
    endpoint: '/api/nova/chat-sessions',
    headers: authHeaders,
    expectedStatus: 201,
    expectedFields: ['chatId', 'session'],
    customValidator: (data) => {
      if (!data?.chatId || typeof data.chatId !== 'string') {
        return { passed: false, message: 'Missing chatId' };
      }
      const inner = expectChatSessionShape(data.session);
      if (!inner.passed) return inner;
      if (data.session.chat_id !== data.chatId) {
        return { passed: false, message: 'session.chat_id must match chatId' };
      }
      return { passed: true, message: '' };
    },
    onSuccess: (data) => {
      cachedChatId = data.chatId;
    },
  });

  await runner.test('Test 2b: GET /api/nova/chat-sessions lists created session', {
    method: 'GET',
    endpoint: '/api/nova/chat-sessions?limit=10&offset=0',
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['sessions', 'total', 'limit', 'offset'],
    customValidator: (data) => {
      if (!Array.isArray(data.sessions)) {
        return { passed: false, message: 'sessions is not an array' };
      }
      if (typeof data.total !== 'number') {
        return { passed: false, message: 'total is not a number' };
      }
      if (data.limit !== 10 || data.offset !== 0) {
        return { passed: false, message: 'limit/offset echo mismatch' };
      }
      const row = data.sessions.find((s) => s.chatId === cachedChatId);
      if (!row) {
        return { passed: false, message: 'created chatId not present in sessions list' };
      }
      if (typeof row.organizationId !== 'string') {
        return { passed: false, message: 'list row missing organizationId' };
      }
      if (typeof row.token_estimate !== 'number' || typeof row.total_tokens !== 'number') {
        return { passed: false, message: 'list row token fields' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('Test 3: GET /api/nova/chat-sessions/:chatId without authentication', {
    method: 'GET',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}`,
    expectedStatus: 401,
  });

  if (!cachedChatId) {
    console.warn('\n⚠️  Skipping Tests 4–12: session creation (Test 2) did not return chatId');
    runner.printResults();
    const resultsFile = runner.saveResults('nova-chat-sessions-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  await runner.test('Test 4: GET /api/nova/chat-sessions/:chatId invalid id (400)', {
    method: 'GET',
    endpoint: '/api/nova/chat-sessions/not-a-uuid',
    headers: authHeaders,
    expectedStatus: 400,
  });

  await runner.test('Test 5: GET /api/nova/chat-sessions/:chatId unknown valid UUID (404)', {
    method: 'GET',
    endpoint: '/api/nova/chat-sessions/f47ac10b-58cc-4372-a567-0e02b2c3d479',
    headers: authHeaders,
    expectedStatus: 404,
    expectedFields: ['error', 'code'],
  });

  await runner.test('Test 6: GET /api/nova/chat-sessions/:chatId returns stored session', {
    method: 'GET',
    endpoint: `/api/nova/chat-sessions/${cachedChatId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['session'],
    customValidator: (data) => {
      const inner = expectChatSessionShape(data.session);
      if (!inner.passed) return inner;
      if (data.session.chat_id !== cachedChatId) {
        return { passed: false, message: 'session.chat_id mismatch' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('Test 7: PATCH appendMessages', {
    method: 'PATCH',
    endpoint: `/api/nova/chat-sessions/${cachedChatId}`,
    headers: authHeaders,
    body: {
      appendMessages: [{ role: 'user', content: 'nova-test-message' }],
    },
    expectedStatus: 200,
    expectedFields: ['session'],
    customValidator: (data) => {
      const inner = expectChatSessionShape(data.session);
      if (!inner.passed) return inner;
      if (data.session.messages.length !== 1) {
        return { passed: false, message: `Expected 1 message, got ${data.session.messages.length}` };
      }
      const m = data.session.messages[0];
      if (m.role !== 'user' || m.content !== 'nova-test-message') {
        return { passed: false, message: 'Appended message content mismatch' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('Test 8: PATCH rejects messages and appendMessages together', {
    method: 'PATCH',
    endpoint: `/api/nova/chat-sessions/${cachedChatId}`,
    headers: authHeaders,
    body: {
      messages: [],
      appendMessages: [{ role: 'assistant', content: 'x' }],
    },
    expectedStatus: 400,
  });

  await runner.test('Test 9: POST token-usage without authentication', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/token-usage`,
    headers: { 'Content-Type': 'application/json' },
    body: { input_tokens: 1, output_tokens: 1 },
    expectedStatus: 401,
  });

  await runner.test('Test 10: POST token-usage invalid body (400)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${cachedChatId}/token-usage`,
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: { input_tokens: -1, output_tokens: 0 },
    expectedStatus: 400,
  });

  await runner.test('Test 11: POST token-usage records usage (201)', {
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${cachedChatId}/token-usage`,
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: { input_tokens: 10, output_tokens: 5, model: 'test-model' },
    expectedStatus: 201,
    expectedFields: ['ok', 'total_tokens'],
    customValidator: (data) => {
      if (data?.ok !== true || data?.total_tokens !== 15) {
        return { passed: false, message: 'Expected ok true and total_tokens 15' };
      }
      return { passed: true, message: '' };
    },
  });

  runner.printResults();
  const resultsFile = runner.saveResults('nova-chat-sessions-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  console.log('✅ Nova Chat Sessions API test suite completed\n');

  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runNovaChatSessionsTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
