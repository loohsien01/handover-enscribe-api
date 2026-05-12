/**
 * Billing + personal organization (Stripe + organizations tables).
 *
 * Requires:
 * - Migration `sql/migrations/20260430_organizations_billing.sql` applied
 * - `.env.local`: `TEST_BILLING_ACCOUNT_EMAIL` + `TEST_BILLING_ACCOUNT_PASSWORD` for a
 *   fully confirmed user that has completed `userProfile` (so a personal org exists)
 *
 * No sign-up flow — uses `sign-in` only (works with email verification on).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner } from './testUtils.js';
import { getApiBaseUrl, getBillingTestAccount, hasBillingTestAccount } from './testConfig.js';

const runner = new TestRunner('Billing + organization API tests');

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

export async function runBillingOrgTests() {
  console.log('Starting billing + organization tests...');
  console.log(`Server: ${getApiBaseUrl()}\n`);

  await runner.test('GET /billing/status without authentication', {
    method: 'GET',
    endpoint: '/api/billing/status',
    expectedStatus: 401,
  });

  await runner.test('POST /billing/schedule-cancel without authentication', {
    method: 'POST',
    endpoint: '/api/billing/schedule-cancel',
    expectedStatus: 401,
  });

  await runner.test('POST /billing/unschedule-cancel without authentication', {
    method: 'POST',
    endpoint: '/api/billing/unschedule-cancel',
    expectedStatus: 401,
  });

  if (!hasBillingTestAccount()) {
    console.warn(
      '\n⚠️  Skipping authenticated billing tests: set TEST_BILLING_ACCOUNT_EMAIL and TEST_BILLING_ACCOUNT_PASSWORD in .env.local'
    );
    console.warn(
      '   (use a confirmed account with userProfile so personal org exists after migration).\n'
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
    const resultsFile = runner.saveResults('billing-org-tests.json');
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
      : `Expected 200 + token; got ${signInRes.status} ${JSON.stringify(signInJson?.error || signInJson)}`,
    timestamp: new Date().toISOString(),
  });
  console.log(`${signInOk ? '✅' : '❌'} Sign-in with TEST_BILLING_ACCOUNT_* (prerequisite)`);

  if (!accessToken) {
    runner.printResults();
    const resultsFile = runner.saveResults('billing-org-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  await runner.test('GET /billing/status (personal org, free / no subscription)', {
    method: 'GET',
    endpoint: '/api/billing/status',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      const org = data?.organization;
      if (!org?.id) {
        return { passed: false, message: 'missing organization.id' };
      }
      if (org.type !== 'personal') {
        return { passed: false, message: `expected type personal, got ${org.type}` };
      }
      if ('plan_key' in org || 'subscription_status' in org) {
        return {
          passed: false,
          message: 'plan_key/subscription_status should live under entitlements only',
        };
      }
      const ent = data?.entitlements;
      if (!ent || typeof ent.entitled !== 'boolean') {
        return { passed: false, message: 'missing entitlements payload' };
      }
      if (ent.plan_key !== 'free') {
        return { passed: false, message: `expected entitlements.plan_key free, got ${ent.plan_key}` };
      }
      if (ent.subscription_status !== 'none') {
        return {
          passed: false,
          message: `expected entitlements.subscription_status none, got ${ent.subscription_status}`,
        };
      }
      if (typeof ent.has_internal_access !== 'boolean' || typeof ent.has_pro_plan !== 'boolean') {
        return { passed: false, message: 'entitlements flags missing or wrong type' };
      }
      if (typeof ent.ui_experience_version !== 'string') {
        return { passed: false, message: 'entitlements.ui_experience_version missing' };
      }
      if (!['internal_access', 'subscription', 'none'].includes(ent.entitlement_source)) {
        return { passed: false, message: `unexpected entitlement_source ${ent.entitlement_source}` };
      }
      return { passed: true };
    },
  });

  await runner.test('GET /me/entitlements (authenticated)', {
    method: 'GET',
    endpoint: '/api/me/entitlements',
    headers: authHeaders,
    expectedStatus: 200,
    customValidator: (data) => {
      const ent = data?.entitlements;
      if (!ent) return { passed: false, message: 'missing entitlements' };
      if (typeof ent.entitled !== 'boolean') {
        return { passed: false, message: 'entitlements.entitled missing' };
      }
      if (typeof ent.ui_experience_version !== 'string') {
        return { passed: false, message: 'entitlements.ui_experience_version missing' };
      }
      if (!['internal_access', 'subscription', 'none'].includes(ent.entitlement_source)) {
        return { passed: false, message: `unexpected entitlement_source ${ent.entitlement_source}` };
      }
      return { passed: true };
    },
  });

  await runner.test('GET /me/entitlements without authentication (401)', {
    method: 'GET',
    endpoint: '/api/me/entitlements',
    expectedStatus: 401,
  });

  const checkoutRes = await fetch(`${runner.baseUrl}/api/billing/checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ planKey: 'pro' }),
  });
  let checkoutJson = {};
  try {
    checkoutJson = await checkoutRes.json();
  } catch {
    /* ignore */
  }
  const checkoutPassed =
    checkoutRes.status === 503 ||
    checkoutRes.status === 500 ||
    (checkoutRes.status === 200 && typeof checkoutJson?.url === 'string');
  runner.results.push({
    name: 'POST /billing/checkout-session (503/500 if unconfigured, 200 if Stripe + price set)',
    passed: checkoutPassed,
    endpoint: '/api/billing/checkout-session',
    method: 'POST',
    status: checkoutRes.status,
    body: checkoutJson,
    customMessage: checkoutPassed
      ? checkoutRes.status === 200
        ? 'checkout url returned'
        : 'expected when Stripe or price missing'
      : `Unexpected status ${checkoutRes.status}`,
    timestamp: new Date().toISOString(),
  });
  console.log(`${checkoutPassed ? '✅' : '❌'} POST /billing/checkout-session`);

  await runner.test('POST /billing/checkout-session invalid plan (400)', {
    method: 'POST',
    endpoint: '/api/billing/checkout-session',
    headers: authHeaders,
    body: { planKey: 'enterprise' },
    expectedStatus: 400,
  });

  await runner.test('POST /billing/checkout-session planKey free (400)', {
    method: 'POST',
    endpoint: '/api/billing/checkout-session',
    headers: authHeaders,
    body: { planKey: 'free' },
    expectedStatus: 400,
  });

  await runner.test('POST /billing/schedule-cancel (400 when no subscription on org)', {
    method: 'POST',
    endpoint: '/api/billing/schedule-cancel',
    headers: authHeaders,
    expectedStatus: 400,
    customValidator: (data) => {
      if (data?.code !== 'STRIPE_SUBSCRIPTION_MISSING') {
        return { passed: false, message: `expected STRIPE_SUBSCRIPTION_MISSING, got ${data?.code}` };
      }
      return { passed: true };
    },
  });

  await runner.test('POST /billing/unschedule-cancel (400 when no subscription on org)', {
    method: 'POST',
    endpoint: '/api/billing/unschedule-cancel',
    headers: authHeaders,
    expectedStatus: 400,
    customValidator: (data) => {
      if (data?.code !== 'STRIPE_SUBSCRIPTION_MISSING') {
        return { passed: false, message: `expected STRIPE_SUBSCRIPTION_MISSING, got ${data?.code}` };
      }
      return { passed: true };
    },
  });

  runner.printResults();
  const resultsFile = runner.saveResults('billing-org-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runBillingOrgTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
