/**
 * Visit preps API — CRUD + encryption round-trip
 *
 * Env: API_BASE_URL, TEST_ACCOUNT_*.
 */
import { randomUUID } from 'crypto';
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
    console.warn('\n⚠️  Skipping 3–11: no access token\n');
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

  await runner.test('3 — POST invalid body (extra field)', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { text: sampleText, extra: true },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('4 — POST create visit prep', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/visit-preps',
    headers: authHeaders,
    body: { text: sampleText },
    expectedStatus: 201,
    expectedFields: ['id', 'user_id', 'text', 'created_at', 'updated_at'],
    onSuccess: (data) => {
      createdIds.push(data.id);
    },
    customValidator: (data) => {
      if (data.text !== sampleText) {
        return { passed: false, message: 'text mismatch after create' };
      }
      return { passed: true, message: '' };
    },
  });

  const createdId = createdIds[0];

  await runner.test('5 — GET single visit prep (encryption round-trip)', {
    testNumber: 5,
    method: 'GET',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['id', 'text'],
    customValidator: (data) => {
      if (data.text !== sampleText) {
        return { passed: false, message: 'decrypted text mismatch on GET' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('6 — GET list includes created row', {
    testNumber: 6,
    method: 'GET',
    endpoint: '/api/visit-preps?limit=10',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      if (!Array.isArray(data)) {
        return { passed: false, message: 'expected array' };
      }
      if (!data.some((row) => row.id === createdId)) {
        return { passed: false, message: 'created row not in list' };
      }
      return { passed: true, message: '' };
    },
  });

  const updatedText = 'Updated visit prep content with revised plan.';

  await runner.test('7 — PATCH visit prep', {
    testNumber: 7,
    method: 'PATCH',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    body: { text: updatedText },
    expectedStatus: 200,
    expectedFields: ['id', 'text', 'updated_at'],
    customValidator: (data) => {
      if (data.text !== updatedText) {
        return { passed: false, message: 'PATCH text mismatch' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('8 — GET unknown visit prep', {
    testNumber: 8,
    method: 'GET',
    endpoint: `/api/visit-preps/${UNKNOWN_ID}`,
    headers: authHeaders,
    expectedStatus: 404,
    expectedFields: ['error'],
  });

  await runner.test('9 — GET invalid UUID', {
    testNumber: 9,
    method: 'GET',
    endpoint: '/api/visit-preps/not-a-uuid',
    headers: authHeaders,
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('10 — DELETE visit prep', {
    testNumber: 10,
    method: 'DELETE',
    endpoint: `/api/visit-preps/${createdId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['success', 'id'],
  });

  await runner.test('11 — GET after delete returns 404', {
    testNumber: 11,
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
