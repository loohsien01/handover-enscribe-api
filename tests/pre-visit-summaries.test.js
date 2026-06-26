/**
 * Visit preps API — CRUD + encryption round-trip + chat_id linkage
 *
 * Env: API_BASE_URL, TEST_ACCOUNT_*, REDIS_URL (for Nova chat session create).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts, getApiBaseUrl } from './testConfig.js';

const MOCK_TOKEN = 'invalid.token.here';
const UNKNOWN_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

export async function runVisitPrepsTests() {
  const runner = new TestRunner('Visit Preps API Tests');

  console.log('Starting Visit Preps API tests...');
  console.log(`Server: ${getApiBaseUrl()}\n`);

  const createdIds = [];
  let accessToken = null;
  let chatId = null;

  await runner.test('1 — GET without auth', {
    testNumber: 1,
    method: 'GET',
    endpoint: '/api/visit-preps',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  await runner.test('2 — GET with invalid token', {
    testNumber: 2,
    method: 'GET',
    endpoint: '/api/visit-preps',
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

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

  if (!accessToken) {
    console.warn('\n⚠️  Skipping 3–14: no access token\n');
    runner.printResults();
    runner.saveResults('visit-preps-tests.json');
    return runner.getSummary();
  }

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const sampleText =
    'Visit prep: review prior labs, discuss medication adherence, assess functional status.';

  await runner.test('3 — POST missing chat_id', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { text: sampleText },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('4 — POST invalid chat_id format', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { chat_id: 'not-a-uuid', text: sampleText },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('5 — POST invalid body (extra field)', {
    testNumber: 5,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { chat_id: UNKNOWN_ID, text: sampleText, extra: true },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('6 — POST unknown chat_id', {
    testNumber: 6,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { chat_id: UNKNOWN_ID, text: sampleText },
    expectedStatus: 404,
    expectedFields: ['error', 'code'],
    customValidator: (data) => {
      if (data?.code !== 'VISIT_PREP_CHAT_NOT_FOUND') {
        return { passed: false, message: `expected VISIT_PREP_CHAT_NOT_FOUND, got ${data?.code}` };
      }
      return { passed: true, message: '' };
    },
  });

  const createChatRes = await fetch(`${runner.baseUrl}/api/nova/chat-sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });

  if (createChatRes.status === 201) {
    const chatData = await createChatRes.json();
    chatId = chatData.chatId;
    console.log(`✓ Created Nova chat session ${chatId}\n`);
  } else {
    const errBody = await createChatRes.json().catch(() => ({}));
    console.warn(
      `\n⚠️  Skipping 7–14: POST /nova/chat-sessions returned ${createChatRes.status}: ${JSON.stringify(errBody)}\n`
    );
    runner.printResults();
    runner.saveResults('visit-preps-tests.json');
    return runner.getSummary();
  }

  await runner.test('7 — POST create visit prep', {
    testNumber: 7,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { chat_id: chatId, text: sampleText },
    expectedStatus: 201,
    expectedFields: ['id', 'user_id', 'chat_id', 'text', 'created_at', 'updated_at'],
    onSuccess: (data) => {
      createdIds.push(data.id);
    },
    customValidator: (data) => {
      if (data.text !== sampleText) {
        return { passed: false, message: 'text mismatch after create' };
      }
      if (data.chat_id !== chatId) {
        return { passed: false, message: 'chat_id mismatch after create' };
      }
      return { passed: true, message: '' };
    },
  });

  const createdId = createdIds[0];

  await runner.test('8 — GET single visit prep (encryption round-trip)', {
    testNumber: 8,
    method: 'GET',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['id', 'text', 'chat_id'],
    customValidator: (data) => {
      if (data.text !== sampleText) {
        return { passed: false, message: 'decrypted text mismatch on GET' };
      }
      if (data.chat_id !== chatId) {
        return { passed: false, message: 'chat_id mismatch on GET' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('9 — GET list includes created row', {
    testNumber: 9,
    method: 'GET',
    endpoint: '/api/visit-preps?limit=10',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      if (!Array.isArray(data)) {
        return { passed: false, message: 'expected array' };
      }
      const row = data.find((r) => r.id === createdId);
      if (!row) {
        return { passed: false, message: 'created row not in list' };
      }
      if (row.chat_id !== chatId) {
        return { passed: false, message: 'list row chat_id mismatch' };
      }
      return { passed: true, message: '' };
    },
  });

  const updatedText = 'Updated visit prep content with revised plan.';

  await runner.test('10 — PATCH visit prep', {
    testNumber: 10,
    method: 'PATCH',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    body: { text: updatedText },
    expectedStatus: 200,
    expectedFields: ['id', 'text', 'chat_id', 'updated_at'],
    customValidator: (data) => {
      if (data.text !== updatedText) {
        return { passed: false, message: 'PATCH text mismatch' };
      }
      if (data.chat_id !== chatId) {
        return { passed: false, message: 'PATCH must not change chat_id' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('11 — GET unknown visit prep', {
    testNumber: 11,
    method: 'GET',
    endpoint: `/api/visit-preps/${UNKNOWN_ID}`,
    headers: authHeaders,
    expectedStatus: 404,
    expectedFields: ['error'],
  });

  await runner.test('12 — GET invalid UUID', {
    testNumber: 12,
    method: 'GET',
    endpoint: '/api/visit-preps/not-a-uuid',
    headers: authHeaders,
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('13 — DELETE visit prep', {
    testNumber: 13,
    method: 'DELETE',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['success', 'id'],
  });

  await runner.test('14 — GET after delete returns 404', {
    testNumber: 14,
    method: 'GET',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    expectedStatus: 404,
    expectedFields: ['error'],
  });

  runner.printResults();
  const resultsFile = runner.saveResults('visit-preps-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runVisitPrepsTests();
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
