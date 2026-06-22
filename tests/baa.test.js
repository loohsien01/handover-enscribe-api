/**
 * BAA API — active document, org status, acceptance.
 *
 * Requires:
 * - Migration `sql/migrations/20260620_baa_versions_and_acceptances.sql` applied
 * - BAA v1 seeded: `npm run seed:baa-v1`
 * - `.env.local`: `TEST_BILLING_ACCOUNT_EMAIL` + `TEST_BILLING_ACCOUNT_PASSWORD`
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner } from './testUtils.js';
import { getApiBaseUrl, getBillingTestAccount, hasBillingTestAccount } from './testConfig.js';

const runner = new TestRunner('BAA API tests');

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

/** @param {unknown} data */
function validateBaaStatusShape(data) {
  const d = /** @type {Record<string, unknown>} */ (data);
  if (typeof d.organization_id !== 'string') {
    return { passed: false, message: 'missing organization_id' };
  }
  if (!('active_version' in d)) {
    return { passed: false, message: 'missing active_version' };
  }
  if (typeof d.needs_acceptance !== 'boolean') {
    return { passed: false, message: 'needs_acceptance must be boolean' };
  }
  if (typeof d.can_accept !== 'boolean') {
    return { passed: false, message: 'can_accept must be boolean' };
  }
  if (d.acceptance != null) {
    const a = /** @type {Record<string, unknown>} */ (d.acceptance);
    if (typeof a.version_number !== 'string' || typeof a.accepted_at !== 'string') {
      return { passed: false, message: 'acceptance shape invalid' };
    }
  }
  return { passed: true };
}

export async function runBaaTests() {
  console.log('Starting BAA API tests...');
  console.log(`Server: ${getApiBaseUrl()}\n`);

  await runner.test('GET /baa/active without authentication', {
    method: 'GET',
    endpoint: '/api/baa/active',
    expectedStatus: 401,
  });

  await runner.test('GET /me/baa/status without authentication', {
    method: 'GET',
    endpoint: '/api/me/baa/status',
    expectedStatus: 401,
  });

  await runner.test('POST /me/baa/accept without authentication', {
    method: 'POST',
    endpoint: '/api/me/baa/accept',
    expectedStatus: 401,
  });

  if (!hasBillingTestAccount()) {
    console.warn(
      '\n⚠️  Skipping authenticated BAA tests: set TEST_BILLING_ACCOUNT_EMAIL and TEST_BILLING_ACCOUNT_PASSWORD in .env.local\n'
    );
    runner.results.push({
      name: 'Sign-in prerequisite (TEST_BILLING_ACCOUNT_*)',
      passed: true,
      skipped: true,
      endpoint: '/api/auth',
      method: 'POST',
      customMessage: 'Missing TEST_BILLING_ACCOUNT_EMAIL / TEST_BILLING_ACCOUNT_PASSWORD',
      timestamp: new Date().toISOString(),
    });
    runner.printResults();
    const resultsFile = runner.saveResults('baa-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const billingAccount = getBillingTestAccount();
  const signInRes = await fetch(`${runner.baseUrl}/api/auth`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      action: 'sign-in',
      email: billingAccount.email,
      password: billingAccount.password,
    }),
  });

  let signInJson = {};
  try {
    signInJson = await signInRes.json();
  } catch {
    /* ignore */
  }

  const accessToken = signInJson?.token?.access_token;
  const signInOk = signInRes.status === 200 && Boolean(accessToken);

  runner.results.push({
    name: 'Sign-in with TEST_BILLING_ACCOUNT_* (prerequisite)',
    passed: signInOk,
    endpoint: '/api/auth',
    method: 'POST',
    status: signInRes.status,
    expectedStatus: 200,
    customMessage: signInOk
      ? `token ok for ${billingAccount.email.split('@')[0]}@…`
      : `Expected 200 + token; got ${signInRes.status}`,
    timestamp: new Date().toISOString(),
  });
  console.log(`${signInOk ? '✅' : '❌'} Sign-in with TEST_BILLING_ACCOUNT_* (prerequisite)`);

  if (!accessToken) {
    runner.printResults();
    const resultsFile = runner.saveResults('baa-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  let activeVersionNumber = null;

  await runner.test('GET /baa/active (authenticated)', {
    method: 'GET',
    endpoint: '/api/baa/active',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      if (typeof data?.version_number !== 'string') {
        return { passed: false, message: 'missing version_number' };
      }
      if (typeof data?.title !== 'string') {
        return { passed: false, message: 'missing title' };
      }
      if (typeof data?.content_markdown !== 'string' || !data.content_markdown.trim()) {
        return { passed: false, message: 'missing content_markdown' };
      }
      if (typeof data?.effective_date !== 'string') {
        return { passed: false, message: 'missing effective_date' };
      }
      activeVersionNumber = data.version_number;
      return { passed: true };
    },
  });

  await runner.test('GET /me/baa/status (authenticated)', {
    method: 'GET',
    endpoint: '/api/me/baa/status',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: validateBaaStatusShape,
  });

  const acceptRes = await fetch(`${runner.baseUrl}/api/me/baa/accept`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders },
    body: JSON.stringify(activeVersionNumber ? { version_number: activeVersionNumber } : {}),
  });
  let acceptJson = {};
  try {
    acceptJson = await acceptRes.json();
  } catch {
    /* ignore */
  }
  const acceptOk =
    (acceptRes.status === 200 || acceptRes.status === 201) &&
    acceptJson?.acceptance?.id &&
    typeof acceptJson.acceptance.accepted_at === 'string' &&
    (!activeVersionNumber || acceptJson.acceptance.version_number === activeVersionNumber);
  runner.results.push({
    name: 'POST /me/baa/accept (owner, idempotent)',
    passed: acceptOk,
    endpoint: '/api/me/baa/accept',
    method: 'POST',
    status: acceptRes.status,
    body: acceptJson,
    customMessage: acceptOk
      ? `acceptance recorded (${acceptRes.status})`
      : `Expected 200/201 + acceptance; got ${acceptRes.status}`,
    timestamp: new Date().toISOString(),
  });
  console.log(`${acceptOk ? '✅' : '❌'} POST /me/baa/accept (owner, idempotent)`);

  await runner.test('POST /me/baa/accept again (200 idempotent)', {
    method: 'POST',
    endpoint: '/api/me/baa/accept',
    headers: authHeaders,
    body: {},
    expectedStatus: 200,
    customValidator: (data) => {
      if (!data?.acceptance?.id) {
        return { passed: false, message: 'missing acceptance on idempotent retry' };
      }
      return { passed: true };
    },
  });

  await runner.test('GET /me/baa/status after accept (needs_acceptance false)', {
    method: 'GET',
    endpoint: '/api/me/baa/status',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      const shape = validateBaaStatusShape(data);
      if (!shape.passed) return shape;
      if (data.needs_acceptance !== false) {
        return { passed: false, message: 'expected needs_acceptance false after accept' };
      }
      if (data.can_accept !== true) {
        return { passed: false, message: 'expected can_accept true for owner' };
      }
      if (!data.acceptance?.version_number) {
        return { passed: false, message: 'expected acceptance after accept' };
      }
      return { passed: true };
    },
  });

  await runner.test('POST /me/baa/accept version mismatch (409)', {
    method: 'POST',
    endpoint: '/api/me/baa/accept',
    headers: authHeaders,
    body: { version_number: '0.0.0-does-not-exist' },
    expectedStatus: 409,
    customValidator: (data) => {
      if (data?.code !== 'BAA_VERSION_MISMATCH') {
        return { passed: false, message: `expected BAA_VERSION_MISMATCH, got ${data?.code}` };
      }
      if (typeof data?.active_version !== 'string') {
        return { passed: false, message: 'missing active_version in 409 body' };
      }
      return { passed: true };
    },
  });

  runner.printResults();
  const resultsFile = runner.saveResults('baa-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runBaaTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
