/**
 * Test Suite: User profile API (public."userProfiles")
 * GET/POST/PATCH /api/user-profile
 * Requires: TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local for full coverage
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts, getApiBaseUrl } from './testConfig.js';

const runner = new TestRunner('User Profile API Tests');

async function runUserProfileTests() {
  console.log('Starting User Profile API tests...');
  console.log(`Server: ${getApiBaseUrl()}\n`);

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
        accessToken = authData.token?.access_token;
        if (accessToken) {
          console.log('✓ Obtained access token from test account\n');
        }
      }
    }
  }

  const base = '/api/user-profile';

  await runner.test('Test 1: GET /user-profile without authentication', {
    method: 'GET',
    endpoint: base,
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  await runner.test('Test 2: POST /user-profile without authentication', {
    method: 'POST',
    endpoint: base,
    body: { username: 'u', specialty: 's' },
    expectedStatus: 401,
  });

  await runner.test('Test 3: PATCH /user-profile without authentication', {
    method: 'PATCH',
    endpoint: base,
    body: { username: 'u' },
    expectedStatus: 401,
  });

  if (!accessToken) {
    console.warn('\n⚠️  Skipping authenticated tests: no access token');
    console.log('   Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
    runner.printResults();
    const resultsFile = runner.saveResults('user-profile-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };
  const suffix = Date.now();
  const username = `test-provider-${suffix}`;
  const specialty = 'Family Medicine';

  const postRes = await fetch(`${runner.baseUrl}${base}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ username, specialty }),
  });

  let postOk = postRes.status === 201 || postRes.status === 200;
  let postJson = {};
  try {
    postJson = await postRes.json();
  } catch {
    postOk = false;
  }
  if (!postJson?.id || !postJson?.user_id) {
    postOk = false;
  }

  runner.results.push({
    name: 'Test 4: POST /user-profile (create)',
    passed: postOk,
    endpoint: base,
    method: 'POST',
    status: postRes.status,
    expectedStatus: 201,
    customMessage: postOk
      ? `Created profile id=${postJson.id}`
      : `Expected 201 with id, got ${postRes.status} ${JSON.stringify(postJson)}`,
    testNumber: 4,
    timestamp: new Date().toISOString(),
  });
  console.log(`${postOk ? '✅' : '❌'} Test 4: POST /user-profile (create)`);

  await runner.test('Test 5: GET /user-profile with authentication', {
    method: 'GET',
    endpoint: base,
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      if (data.username !== username) {
        return { passed: false, message: 'username mismatch' };
      }
      return { passed: true };
    },
  });

  const patchUsername = `${username}-patched`;
  await runner.test('Test 6: PATCH /user-profile (partial username)', {
    method: 'PATCH',
    endpoint: base,
    headers: authHeaders,
    body: { username: patchUsername },
    expectedStatus: 200,
    customValidator: (data) => {
      if (data.username !== patchUsername) {
        return { passed: false, message: 'patched username not returned' };
      }
      return { passed: true };
    },
  });

  const upsertRes = await fetch(`${runner.baseUrl}${base}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      username: patchUsername,
      specialty: 'Internal Medicine',
    }),
  });
  const upsertOk = upsertRes.status === 200;
  let upsertJson = {};
  try {
    upsertJson = await upsertRes.json();
  } catch {
    /* ignore */
  }
  const upsertPassed =
    upsertOk && upsertJson.specialty === 'Internal Medicine';

  runner.results.push({
    name: 'Test 7: POST /user-profile again (upsert update)',
    passed: upsertPassed,
    endpoint: base,
    method: 'POST',
    status: upsertRes.status,
    expectedStatus: 200,
    customMessage: upsertPassed
      ? 'Upsert updated specialty'
      : `Expected 200 and updated specialty, got ${upsertRes.status}`,
    testNumber: 7,
    timestamp: new Date().toISOString(),
  });
  console.log(`${upsertPassed ? '✅' : '❌'} Test 7: POST /user-profile again (upsert update)\n`);

  await runner.test('Test 8: POST /user-profile with empty username (validation)', {
    method: 'POST',
    endpoint: base,
    headers: authHeaders,
    body: { username: '', specialty: 'x' },
    expectedStatus: 400,
  });

  runner.printResults();
  const resultsFile = runner.saveResults('user-profile-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runUserProfileTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

export { runUserProfileTests };
