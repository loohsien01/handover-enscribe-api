/**
 * Pre-Visit Summary Templates API — CRUD + encryption round-trip + is_default
 *
 * Env: API_BASE_URL, TEST_ACCOUNT_* (primary account JWT).
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

export async function runPreVisitSummaryTemplatesTests() {
  const runner = new TestRunner('Pre-Visit Summary Templates API Tests');

  console.log('Starting Pre-Visit Summary Templates API tests...');
  console.log(`Server: ${getApiBaseUrl()}\n`);

  const createdIds = [];
  let accessToken = null;

  await runner.test('1 — GET without auth', {
    testNumber: 1,
    method: 'GET',
    endpoint: '/api/pre-visit-summary-templates',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  await runner.test('2 — GET with invalid token', {
    testNumber: 2,
    method: 'GET',
    endpoint: '/api/pre-visit-summary-templates',
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

  if (!accessToken) {
    console.warn('\n⚠️  Skipping 3–14: no access token\n');
    runner.printResults();
    runner.saveResults('pre-visit-summary-templates-tests.json');
    return runner.getSummary();
  }

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const sampleText =
    'Use concise clinical language. Sections: Active problems, Medications, Plan for today.';

  await runner.test('3 — POST missing name', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/pre-visit-summary-templates',
    headers: authHeaders,
    body: { text: sampleText },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  await runner.test('4 — POST invalid body (extra field)', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/pre-visit-summary-templates',
    headers: authHeaders,
    body: { name: 'Test Template', text: sampleText, extra: true },
    expectedStatus: 400,
    expectedFields: ['error'],
  });

  const templateName = `PVS Template ${Date.now()}`;

  await runner.test('5 — POST create template (is_default true)', {
    testNumber: 5,
    method: 'POST',
    endpoint: '/api/pre-visit-summary-templates',
    headers: authHeaders,
    body: { name: templateName, text: sampleText, is_default: true },
    expectedStatus: 201,
    expectedFields: ['id', 'name', 'user_id', 'text', 'is_default', 'created_at', 'updated_at'],
    onSuccess: (data) => {
      createdIds.push(data.id);
    },
    customValidator: (data) => {
      if (data.text !== sampleText) {
        return { passed: false, message: 'text mismatch after create' };
      }
      if (data.is_default !== true) {
        return { passed: false, message: 'expected is_default true' };
      }
      if (data.name !== templateName) {
        return { passed: false, message: 'name mismatch after create' };
      }
      return { passed: true, message: '' };
    },
  });

  const createdId = createdIds[0];

  await runner.test('6 — GET single template (encryption round-trip)', {
    testNumber: 6,
    method: 'GET',
    endpoint: `/api/pre-visit-summary-templates/${createdId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['id', 'text', 'name', 'is_default'],
    customValidator: (data) => {
      if (data.text !== sampleText) {
        return { passed: false, message: 'decrypted text mismatch on GET' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('7 — GET list metadata-only (no text field)', {
    testNumber: 7,
    method: 'GET',
    endpoint: '/api/pre-visit-summary-templates?limit=10',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      if (!Array.isArray(data)) {
        return { passed: false, message: 'expected array' };
      }
      const row = data.find((item) => item.id === createdId);
      if (!row) {
        return { passed: false, message: 'created template not in list' };
      }
      if (row.text !== undefined) {
        return { passed: false, message: 'list should omit text when decrypt_text not set' };
      }
      if (row.name !== templateName) {
        return { passed: false, message: 'name mismatch in list' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('8 — GET list decrypt_text=true includes text', {
    testNumber: 8,
    method: 'GET',
    endpoint: '/api/pre-visit-summary-templates?limit=10&decrypt_text=true',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      if (!Array.isArray(data)) {
        return { passed: false, message: 'expected array' };
      }
      const row = data.find((item) => item.id === createdId);
      if (!row) {
        return { passed: false, message: 'created template not in decrypt list' };
      }
      if (row.text !== sampleText) {
        return { passed: false, message: 'decrypted text mismatch in list' };
      }
      return { passed: true, message: '' };
    },
  });

  const updatedText = `${sampleText}\n\nAdd vitals summary when available.`;

  await runner.test('9 — PATCH update text', {
    testNumber: 9,
    method: 'PATCH',
    endpoint: `/api/pre-visit-summary-templates/${createdId}`,
    headers: authHeaders,
    body: { text: updatedText },
    expectedStatus: 200,
    expectedFields: ['id', 'text', 'updated_at'],
    customValidator: (data) => {
      if (data.text !== updatedText) {
        return { passed: false, message: 'text mismatch after PATCH' };
      }
      return { passed: true, message: '' };
    },
  });

  const duplicateName = templateName;

  await runner.test('10 — POST duplicate name returns 409', {
    testNumber: 10,
    method: 'POST',
    endpoint: '/api/pre-visit-summary-templates',
    headers: authHeaders,
    body: { name: duplicateName, text: 'other' },
    expectedStatus: 409,
    expectedFields: ['error'],
  });

  await runner.test('11 — GET unknown id returns 404', {
    testNumber: 11,
    method: 'GET',
    endpoint: `/api/pre-visit-summary-templates/${UNKNOWN_ID}`,
    headers: authHeaders,
    expectedStatus: 404,
    expectedFields: ['error'],
  });

  await runner.test('12 — PATCH unknown id returns 404', {
    testNumber: 12,
    method: 'PATCH',
    endpoint: `/api/pre-visit-summary-templates/${UNKNOWN_ID}`,
    headers: authHeaders,
    body: { name: 'Nope' },
    expectedStatus: 404,
    expectedFields: ['error'],
  });

  await runner.test('13 — DELETE template', {
    testNumber: 13,
    method: 'DELETE',
    endpoint: `/api/pre-visit-summary-templates/${createdId}`,
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['success', 'id'],
    customValidator: (data) => {
      if (data.id !== createdId) {
        return { passed: false, message: 'deleted id mismatch' };
      }
      return { passed: true, message: '' };
    },
  });

  await runner.test('14 — GET after delete returns 404', {
    testNumber: 14,
    method: 'GET',
    endpoint: `/api/pre-visit-summary-templates/${createdId}`,
    headers: authHeaders,
    expectedStatus: 404,
    expectedFields: ['error'],
  });

  runner.printResults();
  runner.saveResults('pre-visit-summary-templates-tests.json');
  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runPreVisitSummaryTemplatesTests();
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
