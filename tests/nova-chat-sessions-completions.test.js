/**
 * Nova — async `POST /api/nova/chat-sessions/:chatId/completions` + poll
 * `GET /api/nova/chat-sessions/:chatId/completion-jobs/:jobId`
 *
 * Auth, Zod, 404 only — no Bedrock. Included in `npm test` / `runAll.js`.
 *
 * Bedrock E2E (2× completions + AI title): `tests/nova-chat-sessions-completions.e2e.test.js`
 * (`npm run test:nova-chat-sessions-completions-e2e`).
 * Save pre-visit summary E2E: `tests/nova-chat-sessions-save-pre-visit-summary.e2e.test.js`
 * (`npm run test:nova-save-pre-visit-summary-e2e`).
 *
 * Env: `API_BASE_URL`, `REDIS_URL`, `TEST_ACCOUNT_*`.
 */
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner } from './testUtils.js';
import {
  getTestAccount,
  hasTestAccounts,
  getApiBaseUrl,
  checkRedisReachableForTests,
} from './testConfig.js';

const PLACEHOLDER_CHAT_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_CHAT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

export async function runNovaChatSessionsCompletionsTests() {
  const runner = new TestRunner('Nova Chat-Sessions Completions Tests');

  console.log('Starting Nova chat-sessions completions tests...');
  console.log(`Server: ${getApiBaseUrl()}`);
  console.log(
    'POST /api/nova/chat-sessions/:chatId/completions + GET …/completion-jobs/:jobId — auth + validation + 404'
  );
  console.log('Bedrock E2E: see npm run test:nova-chat-sessions-completions-e2e\n');

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
          turnstileToken: process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN,
        }),
      });
      if (signInResponse.ok) {
        const authData = await signInResponse.json();
        accessToken = authData.token.access_token;
        console.log('✓ Obtained access token\n');
      }
    }
  }

  await runner.test('1', {
    testNumber: 1,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    body: { model: 'haiku', message: 'x', client_message_id: randomUUID() },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  if (!accessToken) {
    console.warn('\n⚠️  Skipping 2–13: no access token\n');
    runner.printResults();
    runner.saveResults('nova-chat-sessions-completions-tests.json');
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  await runner.test('2', {
    testNumber: 2,
    method: 'POST',
    endpoint: '/api/nova/chat-sessions/not-a-uuid/completions',
    headers: authHeaders,
    body: { model: 'haiku', message: 'hello', client_message_id: randomUUID() },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('3', {
    testNumber: 3,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: {},
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('4', {
    testNumber: 4,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: 'hello' },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('5', {
    testNumber: 5,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: 'hello', client_message_id: 'not-a-uuid' },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('6', {
    testNumber: 6,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'gpt-4o', message: 'hello', client_message_id: randomUUID() },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('7', {
    testNumber: 7,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: '', client_message_id: randomUUID() },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('8', {
    testNumber: 8,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: 'hi', client_message_id: randomUUID(), extra: true },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('9', {
    testNumber: 9,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${UNKNOWN_CHAT_ID}/completions`,
    headers: authHeaders,
    body: { model: 'haiku', message: 'hello', client_message_id: randomUUID() },
    expectedStatus: 404,
    expectedFields: ['error', 'code'],
    customValidator: (data) => {
      if (data?.code !== 'NOVA_SESSION_NOT_FOUND') {
        return { passed: false, message: `Expected code NOVA_SESSION_NOT_FOUND, got ${data?.code}` };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('10 — save-pre-visit-summary without auth', {
    testNumber: 10,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions-and-save-pre-visit-summary`,
    body: { model: 'sonnet', message: 'prep', client_message_id: randomUUID() },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  await runner.test('11 — save-pre-visit-summary invalid chatId', {
    testNumber: 11,
    method: 'POST',
    endpoint: '/api/nova/chat-sessions/not-a-uuid/completions-and-save-pre-visit-summary',
    headers: authHeaders,
    body: { model: 'sonnet', message: 'prep', client_message_id: randomUUID() },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('12 — save-pre-visit-summary missing client_message_id', {
    testNumber: 12,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions-and-save-pre-visit-summary`,
    headers: authHeaders,
    body: { model: 'sonnet', message: 'prep' },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('13 — save-pre-visit-summary unknown session', {
    testNumber: 13,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${UNKNOWN_CHAT_ID}/completions-and-save-pre-visit-summary`,
    headers: authHeaders,
    body: {
      model: 'sonnet',
      message: 'prep instructions',
      client_message_id: randomUUID(),
    },
    expectedStatus: 404,
    expectedFields: ['error', 'code'],
    customValidator: (data) => {
      if (data?.code !== 'NOVA_SESSION_NOT_FOUND') {
        return { passed: false, message: `Expected NOVA_SESSION_NOT_FOUND, got ${data?.code}` };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('14 — save-pre-visit-summary accepts extract_title_details', {
    testNumber: 14,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${UNKNOWN_CHAT_ID}/completions-and-save-pre-visit-summary`,
    headers: authHeaders,
    body: {
      model: 'sonnet',
      message: 'prep',
      client_message_id: randomUUID(),
      extract_title_details: false,
    },
    expectedStatus: 404,
    expectedFields: ['error', 'code'],
  });

  await runner.test('15 — normal completions rejects extract_title_details', {
    testNumber: 15,
    method: 'POST',
    endpoint: `/api/nova/chat-sessions/${PLACEHOLDER_CHAT_ID}/completions`,
    headers: authHeaders,
    body: {
      model: 'haiku',
      message: 'hello',
      client_message_id: randomUUID(),
      extract_title_details: true,
    },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

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
