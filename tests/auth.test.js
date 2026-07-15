/**
 * Test Suite: Authentication API
 * Tests all auth endpoints: sign-up, sign-in, sign-out, check-validity, resend,
 * confirm-sign-up, forgot-password / confirm-forgot-password (via suite coverage)
 *
 * `testNumber`: integers 1, 2, 3, … in file order (echoed in results JSON).
 *
 * `skipTest8`: when true, skips test 8 — sign-up with `userProfile.username` `"info"`
 * (requires DB seed `userProfiles.username === "info"`).
 * Test 9 requires `TEST_ACCOUNT_EMAIL` (duplicate email → 409).
 * Test 10 requires `TEST_ACCOUNT_EMAIL` and `TEST_ACCOUNT_PASSWORD` (sign-in smoke).
 * Tests 23–26 cover confirm-sign-up validation (Zod + Cognito reject of bad code).
 * Tests 35–39 cover Turnstile enforcement (docs/AUTH_BOT_PROTECTION.md): sign-in,
 * sign-up and forgot-password require a `turnstileToken`, verified server-side.
 *
 * Turnstile note: the server requires a valid Turnstile token on sign-in /
 * sign-up / forgot-password. Live tests cannot solve a real challenge, so set
 * `CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN` (any non-empty value) in `.env.local` — the same
 * value is read by the server (non-prod only) and by these tests. Without it, the
 * happy/business-path tests are skipped; the "token required" negatives still run.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { TestRunner } from './testUtils.js';
import {
  getTestAccount,
  hasTestAccounts,
  getTurnstileTestToken,
  hasTurnstileTestToken,
} from './testConfig.js';

const runner = new TestRunner('Authentication API Tests');

/**
 * Turnstile is required server-side on sign-in / sign-up / forgot-password
 * (docs/AUTH_BOT_PROTECTION.md). Tests hit a live server and cannot solve a real
 * challenge, so they rely on the non-prod bypass token. When it is not configured,
 * the turnstile-gated happy/business paths are skipped (a missing/invalid token
 * would 400 before the controller runs); the "token is required" negative tests
 * still run since they assert that 400.
 */
const TURNSTILE_TOKEN = getTurnstileTestToken();
const turnstileReady = hasTurnstileTestToken();

/** Push a uniform skipped result so suite numbering stays stable. */
function pushSkipped(name, testNumber, expectedStatus, customMessage) {
  runner.results.push({
    name,
    passed: true,
    skipped: true,
    endpoint: '/api/auth',
    method: 'POST',
    status: null,
    expectedStatus,
    body: {},
    customMessage,
    testNumber,
    timestamp: new Date().toISOString(),
  });
}

/** Skips test 8 by default. Set `false` to enable. */
const skipTest8 = false;

/**
 * Extract tid from wrapper JWT token (for token rotation validation)
 * Wrapper JWT format: { sub: userId, tid: tokenId, iat, exp }
 * @param {string} wrapperJwt - The wrapper JWT token (wrapper cookie value)
 * @returns {string|null} The tid if extracted, null otherwise
 */
const JSON_ACCEPT_HEADERS = { Accept: 'application/json' };

/**
 * Parse Zod issues from serialized API error body
 * @param {object} body
 * @returns {Array<{ path?: string[] }>}
 */
function parseZodIssues(body) {
  try {
    const raw = body?.error?.message;
    if (!raw || body?.error?.name !== 'ZodError') return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function extractTidFromWrapperJwt(wrapperJwt) {
  if (!wrapperJwt) return null;
  
  try {
    // Split JWT into parts: header.payload.signature
    const parts = wrapperJwt.split('.');
    if (parts.length !== 3) return null;
    
    // Decode payload (second part) from base64
    const payload = parts[1];
    // Add padding if needed for base64 decoding
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    
    return parsed?.tid || null;
  } catch (err) {
    console.error('  ❌ Error extracting tid from wrapper JWT:', err.message);
    return null;
  }
}

/**
 * Run all auth tests
 */
async function runAuthTests() {
  console.log('Starting Authentication API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  if (!turnstileReady) {
    console.warn(
      '⚠️  CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN not set in .env.local — sign-in / sign-up / ' +
      'forgot-password happy-path tests will be skipped. Set it (any non-empty ' +
      'value, matched by the server) to run them.\n'
    );
  }

  // 1
  await runner.test('Sign-up without password', {
    testNumber: 1,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'test@example.com',
      userProfile: { username: 'test_user_zod', specialty: 'Cardiology' },
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasPasswordIssue = /invalid_type.*password/.test(JSON.stringify(body?.error));
      
      return {
        passed: isZodError && hasPasswordIssue,
        message: (isZodError && hasPasswordIssue)
          ? 'Should return ZodError for missing password'
          : `Expected ZodError for missing password. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 2
  await runner.test('Sign-up with invalid email', {
    testNumber: 2,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'notanemail',
      password: 'Password123!',
      userProfile: { username: 'test_user_zod2', specialty: 'Cardiology' },
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasEmailIssue = /invalid_format.*email/.test(JSON.stringify(body?.error));
      
      return {
        passed: isZodError && hasEmailIssue,
        message: (isZodError && hasEmailIssue)
          ? 'Should return ZodError for invalid email format'
          : `Expected ZodError for invalid email. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 3
  await runner.test('Sign-up with password too short', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'valid@example.com',
      password: 'Short1!',
      userProfile: { username: 'test_user_zod3', specialty: 'Cardiology' },
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasPasswordIssue = /too_small.*password/.test(JSON.stringify(body?.error));
      
      return {
        passed: isZodError && hasPasswordIssue,
        message: (isZodError && hasPasswordIssue)
          ? 'Should return ZodError for password too short'
          : `Expected ZodError for password too short. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 4
  await runner.test('Sign-up without userProfile (Zod)', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'zod_pf_0@example.com',
      password: 'TestPassword123!',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const issues = parseZodIssues(body);
      const hit = issues.some(
        (i) => Array.isArray(i.path) && i.path.length === 1 && i.path[0] === 'userProfile'
      );
      return {
        passed: hit,
        message: hit
          ? 'Zod flags missing userProfile'
          : `Expected issue path userProfile; issues=${JSON.stringify(issues)}`,
      };
    },
  });

  // 5
  await runner.test('Sign-up with userProfile missing specialty (Zod)', {
    testNumber: 5,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'zod_pf_1@example.com',
      password: 'TestPassword123!',
      userProfile: { username: 'only_username_no_specialty' },
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const issues = parseZodIssues(body);
      const hit = issues.some(
        (i) => Array.isArray(i.path) && i.path.includes('userProfile') && i.path.includes('specialty')
      );
      return {
        passed: hit,
        message: hit
          ? 'Zod flags missing userProfile.specialty'
          : `Expected issue path userProfile.specialty; issues=${JSON.stringify(issues)}`,
      };
    },
  });

  // 6
  await runner.test('Sign-up with userProfile empty username (Zod)', {
    testNumber: 6,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'zod_pf_2@example.com',
      password: 'TestPassword123!',
      userProfile: { username: '', specialty: 'Cardiology' },
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const issues = parseZodIssues(body);
      const hit = issues.some(
        (i) => Array.isArray(i.path) && i.path.includes('userProfile') && i.path.includes('username')
      );
      return {
        passed: hit,
        message: hit
          ? 'Zod flags invalid userProfile.username'
          : `Expected issue path userProfile.username; issues=${JSON.stringify(issues)}`,
      };
    },
  });

  // 7
  await runner.test('Sign-up with userProfile wrong type (Zod)', {
    testNumber: 7,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'zod_pf_3@example.com',
      password: 'TestPassword123!',
      userProfile: 'not-an-object',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const issues = parseZodIssues(body);
      const hit = issues.some(
        (i) =>
          Array.isArray(i.path) &&
          i.path.length === 1 &&
          i.path[0] === 'userProfile' &&
          i.code === 'invalid_type'
      );
      return {
        passed: hit,
        message: hit
          ? 'Zod flags userProfile must be an object'
          : `Expected invalid_type on userProfile; issues=${JSON.stringify(issues)}`,
      };
    },
  });

  // 8: requires DB seed `userProfiles.username === "info"` + turnstile bypass
  if (!skipTest8 && turnstileReady) {
    await runner.test(
      'Sign-up with userProfile username "info" (409 USERNAME_TAKEN, no auth user)',
      {
        testNumber: 8,
        method: 'POST',
        endpoint: '/api/auth',
        headers: JSON_ACCEPT_HEADERS,
        body: {
          action: 'sign-up',
          email: `info@sjpedgi.doctor`,
          password: '@2Sengaring',
          userProfile: { username: 'info', specialty: 'Internal Medicine' },
          turnstileToken: TURNSTILE_TOKEN,
        },
        expectedStatus: 409,
        customValidator: (body) => {
          const passed =
            body?.code === 'USERNAME_TAKEN' &&
            body?.error === 'This username is already taken' &&
            body?.user == null &&
            body?.userProfile == null;
          return {
            passed,
            message: passed
              ? 'Username taken rejected before auth user creation'
              : `Expected 409 USERNAME_TAKEN, no user/userProfile; got ${JSON.stringify(body)}`,
          };
        },
      }
    );
  } else {
    const reason = skipTest8 ? 'SKIPPED (skipTest8)' : 'SKIPPED (no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN)';
    console.log(`\n⏭️  Test 8: ${reason}.\n`);
    pushSkipped(
      'Sign-up with userProfile username "info" (409 USERNAME_TAKEN, no auth user)',
      8,
      409,
      reason
    );
  }

  // 9 — duplicate email (requires TEST_ACCOUNT_EMAIL in .env.local + turnstile bypass)
  const dupEmailAccount = getTestAccount('primary');
  if (dupEmailAccount?.email && turnstileReady) {
    await runner.test('Sign-up with existing email (409 EMAIL_ALREADY_REGISTERED)', {
      testNumber: 9,
      method: 'POST',
      endpoint: '/api/auth',
      headers: JSON_ACCEPT_HEADERS,
      body: {
        action: 'sign-up',
        email: dupEmailAccount.email,
        password: 'AnotherPassword123!',
        userProfile: { username: 'dup_email_probe_user', specialty: 'Cardiology' },
        turnstileToken: TURNSTILE_TOKEN,
      },
      expectedStatus: 409,
      customValidator: (body) => {
        const passed =
          body?.code === 'EMAIL_ALREADY_REGISTERED' &&
          body?.error === 'An account with this email already exists' &&
          body?.user == null &&
          body?.userProfile == null;
        return {
          passed,
          message: passed
            ? 'Duplicate email rejected before auth/profile writes'
            : `Expected 409 EMAIL_ALREADY_REGISTERED, no user/userProfile; got ${JSON.stringify(body)}`,
        };
      },
    });
  } else {
    const reason = !dupEmailAccount?.email
      ? 'SKIPPED: no primary test email'
      : 'SKIPPED: no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN';
    console.warn(`⚠️  Skipping test 9: ${reason}.`);
    pushSkipped('Sign-up with existing email (409 EMAIL_ALREADY_REGISTERED)', 9, 409, reason);
  }

  // 10 — requires TEST_ACCOUNT_* in .env.local (no dummy sign-in fallback) + turnstile bypass
  const testAccount = getTestAccount('primary');
  if (testAccount?.email && testAccount?.password && turnstileReady) {
    await runner.test('Sign-in with email and password (real credentials)', {
      testNumber: 10,
      method: 'POST',
      endpoint: '/api/auth',
      body: {
        action: 'sign-in',
        email: testAccount.email,
        password: testAccount.password,
        turnstileToken: TURNSTILE_TOKEN,
      },
      expectedStatus: 200,
      expectedFields: ['user', 'token', 'token.access_token', 'tid'],
      customValidator: (body) => {
        const hasTid = body?.tid && typeof body.tid === 'string';
        const tidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.tid);
        return {
          passed: hasTid && tidFormat,
          message: hasTid && tidFormat ? 'tid is valid UUID' : `tid missing or invalid format. Got: ${body?.tid}`
        };
      },
    });
  } else {
    const reason = !(testAccount?.email && testAccount?.password)
      ? 'SKIPPED: no primary test credentials'
      : 'SKIPPED: no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN';
    console.warn(`⚠️  Skipping test 10: ${reason}.`);
    pushSkipped('Sign-in with email and password (real credentials)', 10, 200, reason);
  }

  // 11 — business error (401) only reachable once turnstile passes
  if (turnstileReady) {
    await runner.test('Sign-in with wrong password', {
      testNumber: 11,
      method: 'POST',
      endpoint: '/api/auth',
      body: {
        action: 'sign-in',
        email: 'existinguser@example.com',
        password: 'WrongPassword123!',
        turnstileToken: TURNSTILE_TOKEN,
      },
      expectedStatus: 401,
      customValidator: (body) => {
        // Business error (not Zod) - should be plain error string from Supabase
        return {
          passed: body?.error && typeof body.error === 'string',
          message: body?.error || 'Should return error message for wrong password'
        };
      },
    });
  } else {
    pushSkipped('Sign-in with wrong password', 11, 401, 'SKIPPED: no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN');
  }

  // 11
  await runner.test('Sign-in with empty password', {
    testNumber: 12,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-in',
      email: 'existinguser@example.com',
      password: '',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasPasswordIssue = /too_small.*password/.test(JSON.stringify(body?.error));
      
      return {
        passed: isZodError && hasPasswordIssue,
        message: (isZodError && hasPasswordIssue)
          ? 'Should return ZodError for empty password'
          : `Expected ZodError for empty password. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 13 — business error (401) only reachable once turnstile passes
  if (turnstileReady) {
    await runner.test('Sign-in with non-existent user', {
      testNumber: 13,
      method: 'POST',
      endpoint: '/api/auth',
      body: {
        action: 'sign-in',
        email: 'nonexistent@example.com',
        password: 'Password123!',
        turnstileToken: TURNSTILE_TOKEN,
      },
      expectedStatus: 401,
    });
  } else {
    pushSkipped('Sign-in with non-existent user', 13, 401, 'SKIPPED: no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN');
  }

  // 14
  await runner.test('Check validity without auth header', {
    testNumber: 14,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'check-validity',
    },
    expectedStatus: 401,
  });

  // 15
  await runner.test('Check validity with invalid token', {
    testNumber: 15,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'check-validity',
    },
    headers: {
      Authorization: 'Bearer invalid.token.here',
    },
    expectedStatus: 401,
  });

  // 16
  await runner.test('Sign-out without auth header', {
    testNumber: 16,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-out',
    },
    expectedStatus: 401,
  });

  // 17
  await runner.test('Resend confirmation email', {
    testNumber: 17,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'resend',
      email: 'newuser@example.com',
    },
    expectedStatus: 200,
    expectedFields: ['message'],
  });

  // 18
  await runner.test('Resend without email', {
    testNumber: 18,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'resend',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasEmailIssue = /invalid_type.*email/.test(JSON.stringify(body?.error));
      
      return {
        passed: isZodError && hasEmailIssue,
        message: (isZodError && hasEmailIssue)
          ? 'Should return ZodError for missing email'
          : `Expected ZodError for missing email. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 19
  await runner.test('Invalid action type', {
    testNumber: 19,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'invalid-action',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Should return plain error string for unknown action
      return {
        passed: body?.error && typeof body.error === 'string' && body.error.includes('Unknown action'),
        message: body?.error || 'Should return error for unknown action'
      };
    },
  });

  // 20
  await runner.test('Missing action field', {
    testNumber: 20,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      email: 'test@example.com',
      password: 'password',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      
      return {
        passed: isZodError,
        message: isZodError
          ? 'Should return ZodError for missing action'
          : `Expected ZodError for missing action. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 21
  await runner.test('Resend with emailRedirectTo', {
    testNumber: 21,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'resend',
      email: 'anotheruser@example.com',
      emailRedirectTo: 'https://myapp.com/confirm',
    },
    expectedStatus: 200,
  });

  // 22
  await runner.test('Resend with invalid emailRedirectTo URL', {
    testNumber: 22,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'resend',
      email: 'testuser@example.com',
      emailRedirectTo: 'not-a-valid-url',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasUrlIssue = /invalid_format.*emailRedirectTo/.test(JSON.stringify(body?.error));
      
      return {
        passed: isZodError && hasUrlIssue,
        message: (isZodError && hasUrlIssue)
          ? 'Should return ZodError for invalid emailRedirectTo URL'
          : `Expected ZodError for invalid emailRedirectTo URL. Got: ${JSON.stringify(body?.error)}`
      };
    },
  });

  // 23
  await runner.test('Confirm-sign-up without email', {
    testNumber: 23,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'confirm-sign-up',
      code: '123456',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasEmailIssue = /invalid_type.*email|Invalid email/.test(JSON.stringify(body?.error));
      return {
        passed: isZodError && hasEmailIssue,
        message: isZodError && hasEmailIssue
          ? 'Should return ZodError for missing email'
          : `Expected ZodError for missing email. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 24
  await runner.test('Confirm-sign-up without code', {
    testNumber: 24,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'confirm-sign-up',
      email: 'newuser@example.com',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasCodeIssue = /invalid_type.*code|Verification code/.test(JSON.stringify(body?.error));
      return {
        passed: isZodError && hasCodeIssue,
        message: isZodError && hasCodeIssue
          ? 'Should return ZodError for missing code'
          : `Expected ZodError for missing code. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 25
  await runner.test('Confirm-sign-up with invalid email', {
    testNumber: 25,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'confirm-sign-up',
      email: 'not-an-email',
      code: '123456',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasEmailIssue = /invalid_format.*email|Invalid email/.test(JSON.stringify(body?.error));
      return {
        passed: isZodError && hasEmailIssue,
        message: isZodError && hasEmailIssue
          ? 'Should return ZodError for invalid email'
          : `Expected ZodError for invalid email. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 26 — wrong/expired code (Cognito returns 400; no user created)
  await runner.test('Confirm-sign-up with wrong code (400 from Cognito)', {
    testNumber: 26,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'confirm-sign-up',
      email: 'nobody-confirm-signup@example.com',
      code: '000000',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const hasError = typeof body?.error === 'string' && body.error.length > 0;
      return {
        passed: hasError,
        message: hasError
          ? 'Cognito rejected invalid confirm-sign-up'
          : `Expected string error from Cognito. Got: ${JSON.stringify(body)}`,
      };
    },
  });

  // ===========================================
  // TURNSTILE ENFORCEMENT (docs/AUTH_BOT_PROTECTION.md)
  // Token is REQUIRED server-side; these run regardless of bypass config since
  // they assert the request is rejected when the token is absent.
  // ===========================================

  // 35 — sign-in requires turnstileToken
  await runner.test('Sign-in without turnstileToken (400 Zod required)', {
    testNumber: 35,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-in',
      email: 'existinguser@example.com',
      password: 'Password123!',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const issues = parseZodIssues(body);
      const hit = issues.some((i) => Array.isArray(i.path) && i.path.includes('turnstileToken'));
      return {
        passed: isZodError && hit,
        message: isZodError && hit
          ? 'Sign-in rejected without turnstileToken'
          : `Expected ZodError on turnstileToken. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 36 — sign-up requires turnstileToken
  await runner.test('Sign-up without turnstileToken (400 Zod required)', {
    testNumber: 36,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'turnstile_signup@example.com',
      password: 'TestPassword123!',
      userProfile: { username: 'turnstile_probe', specialty: 'Cardiology' },
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const issues = parseZodIssues(body);
      const hit = issues.some((i) => Array.isArray(i.path) && i.path.includes('turnstileToken'));
      return {
        passed: isZodError && hit,
        message: isZodError && hit
          ? 'Sign-up rejected without turnstileToken'
          : `Expected ZodError on turnstileToken. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 37 — forgot-password requires turnstileToken
  await runner.test('Forgot-password without turnstileToken (400 Zod required)', {
    testNumber: 37,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'forgot-password',
      email: 'existinguser@example.com',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const issues = parseZodIssues(body);
      const hit = issues.some((i) => Array.isArray(i.path) && i.path.includes('turnstileToken'));
      return {
        passed: isZodError && hit,
        message: isZodError && hit
          ? 'Forgot-password rejected without turnstileToken'
          : `Expected ZodError on turnstileToken. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 38 — forgot-password requires a valid email (Zod)
  await runner.test('Forgot-password with invalid email (400 Zod)', {
    testNumber: 38,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'forgot-password',
      email: 'not-an-email',
      turnstileToken: TURNSTILE_TOKEN || 'placeholder-token',
    },
    expectedStatus: 400,
    customValidator: (body) => {
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      const hasEmailIssue = /invalid_format.*email|Invalid email/.test(JSON.stringify(body?.error));
      return {
        passed: isZodError && hasEmailIssue,
        message: isZodError && hasEmailIssue
          ? 'Forgot-password rejected for invalid email'
          : `Expected ZodError on email. Got: ${JSON.stringify(body?.error)}`,
      };
    },
  });

  // 39 — forgot-password happy path: always 200 (enumeration-safe) once turnstile passes
  if (turnstileReady) {
    await runner.test('Forgot-password with valid token (200 generic message)', {
      testNumber: 39,
      method: 'POST',
      endpoint: '/api/auth',
      body: {
        action: 'forgot-password',
        email: 'nobody-forgot-password@example.com',
        turnstileToken: TURNSTILE_TOKEN,
      },
      expectedStatus: 200,
      expectedFields: ['message'],
      customValidator: (body) => {
        const passed = typeof body?.message === 'string' && body.message.length > 0;
        return {
          passed,
          message: passed
            ? 'Forgot-password returns generic 200 (no account enumeration)'
            : `Expected generic 200 message. Got: ${JSON.stringify(body)}`,
        };
      },
    });
  } else {
    pushSkipped(
      'Forgot-password with valid token (200 generic message)',
      39,
      200,
      'SKIPPED: no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN'
    );
  }

  // ===========================================
  // REAL ACCOUNT TESTS (if configured)
  // ===========================================
  
  if (hasTestAccounts() && turnstileReady) {
    const testAccount = getTestAccount('primary');
    
    if (testAccount && testAccount.email && testAccount.password) {
      console.log(`\n📝 Running real account tests with: ${testAccount.email.split('@')[0]}@****\n`);
      
      // 27
      await runner.test('Sign-in with valid account (real credentials)', {
        testNumber: 27,
        method: 'POST',
        endpoint: '/api/auth',
        body: {
          action: 'sign-in',
          email: testAccount.email,
          password: testAccount.password,
          turnstileToken: TURNSTILE_TOKEN,
        },
        expectedStatus: 200,
        expectedFields: ['token.access_token', 'user.id', 'user.email', 'tid'],
        customValidator: (body) => {
          const hasTid = body?.tid && typeof body.tid === 'string';
          const tidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.tid);
          return {
            passed: hasTid && tidFormat,
            message: hasTid && tidFormat ? 'tid is valid UUID' : `tid missing or invalid format. Got: ${body?.tid}`
          };
        },
      });

      // Extract token from previous sign-in for check-validity
      const signInResult = runner.results[runner.results.length - 1];
      const accessToken = signInResult.body?.token?.access_token;

      // 28
      if (accessToken) {
        await runner.test('Check validity endpoint (with real token)', {
          testNumber: 28,
          method: 'POST',
          endpoint: '/api/auth',
          body: {
            action: 'check-validity',
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          expectedStatus: 200,
          expectedFields: ['valid', 'message', 'user.id', 'user.email'],
        });
      } else {
        console.warn('⚠️  Could not extract token from sign-in test, skipping check-validity test');
      }
    }
  } else {
    console.log('\n⚠️  Test accounts not configured or no CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN. Skipping real credential tests.');
    console.log('To enable: Add TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD and CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN to .env.local\n');
  }

  // ===========================================
  // NEW: Token Refresh and Cookie Status Tests
  // ===========================================

  if (hasTestAccounts() && turnstileReady) {
    const testAccount = getTestAccount('primary');
    
    if (testAccount && testAccount.email && testAccount.password) {
      console.log(`\n✅ Testing token refresh and cookie status endpoints...\n`);

      // First: Sign in to get refresh token cookie
      let refreshTokenCookie = null;
      let newAccessToken = null;

      try {
        const response = await fetch(`${runner.baseUrl}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sign-in',
            email: testAccount.email,
            password: testAccount.password,
            turnstileToken: TURNSTILE_TOKEN,
          }),
        });

        const signInData = await response.json();
        const originalAccessToken = signInData?.token?.access_token;

        // Extract refresh_token cookie from Set-Cookie header
        const setCookieHeader = response.headers.get('set-cookie');
        if (setCookieHeader) {
          const match = setCookieHeader.match(/refresh_token=([^;]+)/);
          if (match) {
            refreshTokenCookie = match[1]; // Keep original encoding, don't decode
          }
        }

        console.log(`  ℹ️  Extracted refresh token: ${refreshTokenCookie ? 'yes' : 'no'}`);
        if (refreshTokenCookie) {
          console.log(`  ℹ️  Cookie preview: ${refreshTokenCookie.slice(0, 50)}...`);
          const initialTid = extractTidFromWrapperJwt(refreshTokenCookie);
          if (initialTid) {
            console.log(`  ℹ️  Initial tid: ${initialTid}`);
          }
        }
        console.log();

        // 29
        await runner.test('POST /api/auth/refresh without token', {
          testNumber: 29,
          method: 'POST',
          endpoint: '/api/auth/refresh',
          expectedStatus: 401,
          expectedFields: ['error'],
          customValidator: (body) => {
            const hasError = body?.error && typeof body.error === 'string';
            return {
              passed: hasError,
              message: body?.error || 'Should return error for missing refresh token'
            };
          },
        });

        // 30
        await runner.test('POST /api/auth/refresh with invalid token', {
          testNumber: 30,
          method: 'POST',
          endpoint: '/api/auth/refresh',
          headers: {
            'Cookie': 'refresh_token=invalid.jwt.here',
          },
          expectedStatus: 401,
          expectedFields: ['error'],
          customValidator: (body) => {
            const hasError = body?.error && typeof body.error === 'string';
            return {
              passed: hasError,
              message: body?.error || 'Should return error for invalid JWT'
            };
          },
        });

        // 31
        if (refreshTokenCookie) {
          await runner.test('GET /api/auth/cookie-status with valid cookie', {
            testNumber: 31,
            method: 'GET',
            endpoint: '/api/auth/cookie-status',
            headers: {
              'Cookie': `refresh_token=${refreshTokenCookie}`,
            },
            expectedStatus: 200,
            expectedFields: ['cookiePresent'],
            customValidator: (body) => {
              return {
                passed: body?.cookiePresent === true,
                message: body?.cookiePresent === true ? 'Cookie correctly detected' : 'Should return cookiePresent: true'
              };
            },
          });
        }

        // 32
        await runner.test('GET /api/auth/cookie-status without cookie', {
          testNumber: 32,
          method: 'GET',
          endpoint: '/api/auth/cookie-status',
          expectedStatus: 200,
          expectedFields: ['cookiePresent'],
          customValidator: (body) => {
            return {
              passed: body?.cookiePresent === false,
              message: body?.cookiePresent === false ? 'No cookie correctly detected' : 'Should return cookiePresent: false'
            };
          },
        });

        // 33
        await runner.test('GET /api/auth/cookie-status with invalid cookie', {
          testNumber: 33,
          method: 'GET',
          endpoint: '/api/auth/cookie-status',
          headers: {
            'Cookie': 'refresh_token=invalid.jwt.here',
          },
          expectedStatus: 200,
          expectedFields: ['cookiePresent'],
          customValidator: (body) => {
            return {
              passed: body?.cookiePresent === false,
              message: body?.cookiePresent === false ? 'Invalid cookie correctly detected' : 'Should return cookiePresent: false'
            };
          },
        });

        // ===== REFRESH TESTS RUN LAST (after cookie-status tests) =====
        // 34
        if (refreshTokenCookie) {
          const oldTid = extractTidFromWrapperJwt(refreshTokenCookie);
          let newTid = null;

          // Wait 60 seconds to test JWT expiry/regeneration
          console.log(`  ⚠️⚠️⚠️  Please check Supabase: Access token expiry time is  30s`);
          console.log(`  ⏳ Waiting 5 seconds before refresh to test JWT regeneration...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          console.log(`  ✅ Wait complete, proceeding with refresh test\n`);

          await runner.test('POST /api/auth/refresh with valid token', {
            testNumber: 34,
            method: 'POST',
            endpoint: '/api/auth/refresh',
            headers: {
              'Cookie': `refresh_token=${refreshTokenCookie}`,
            },
            expectedStatus: 200,
            expectedFields: ['accessToken', 'user.id', 'user.email'],
            customValidator: (body, response) => {
              const hasAccessToken = body?.accessToken && typeof body.accessToken === 'string';
              const hasUser =
                body?.user?.id &&
                typeof body.user.id === 'string' &&
                body?.user?.email &&
                typeof body.user.email === 'string';
              newAccessToken = body?.accessToken;
              
              // Extract new tid from Set-Cookie header to validate token rotation
              const setCookieHeader = response?.headers?.['set-cookie'];
              if (setCookieHeader) {
                const cookieMatch = setCookieHeader.match(/refresh_token=([^;]+)/);
                if (cookieMatch) {
                  const newWrapperJwt = cookieMatch[1];
                  newTid = extractTidFromWrapperJwt(newWrapperJwt);
                }
              }

              // Compare access tokens to verify JWT was regenerated
              const jwtChanged = originalAccessToken && originalAccessToken !== newAccessToken;
              
              // Optionally decode JWTs to compare iat timestamps
              let oldIat = null, newIat = null;
              if (originalAccessToken && newAccessToken) {
                try {
                  const oldParts = originalAccessToken.split('.');
                  const newParts = newAccessToken.split('.');
                  if (oldParts.length === 3 && newParts.length === 3) {
                    const oldPayload = oldParts[1];
                    const newPayload = newParts[1];
                    const oldPadded = oldPayload + '='.repeat((4 - (oldPayload.length % 4)) % 4);
                    const newPadded = newPayload + '='.repeat((4 - (newPayload.length % 4)) % 4);
                    const oldDecoded = JSON.parse(Buffer.from(oldPadded, 'base64').toString('utf-8'));
                    const newDecoded = JSON.parse(Buffer.from(newPadded, 'base64').toString('utf-8'));
                    oldIat = oldDecoded?.iat;
                    newIat = newDecoded?.iat;
                  }
                } catch (err) {
                  // Silently fail JWT decoding, not critical
                }
              }

              // Log rotation validation
              console.log(`    ℹ️  Token Rotation Validation:`);
              console.log(`       Old tid: ${oldTid || 'unable to extract'}`);
              console.log(`       New tid: ${newTid || 'unable to extract'}`);
              if (oldTid && newTid) {
                const tidRotated = oldTid !== newTid;
                console.log(`       Tid rotation: ${tidRotated ? '✅ YES (tid changed)' : '❌ NO (tid unchanged)'}`);
              }
              console.log(`       Access Token changed: ${jwtChanged ? '✅ YES (new JWT)' : '❌ NO (same JWT)'}`);
              if (oldIat && newIat) {
                console.log(`       Old iat: ${oldIat}, New iat: ${newIat}`);
              }

              const passed =
                hasAccessToken && hasUser && newTid && oldTid && oldTid !== newTid && jwtChanged;
              return {
                passed,
                message: passed
                  ? '✅ Token rotated successfully (tid + JWT both changed)'
                  : !hasAccessToken
                    ? 'No accessToken in response'
                    : !hasUser
                      ? 'No user.id/user.email in response'
                      : 'Token rotation not detected (tid or JWT unchanged or missing)',
              };
            },
          });
        } else {
          console.warn('  ⚠️  Could not extract refresh token, skipping refresh tests');
        }
      } catch (err) {
        console.error('  ❌ Failed to extract tokens for refresh tests:', err.message);
      }
  }
}
  runner.printResults();

  // Save results to file
  const resultsFile = runner.saveResults('auth-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runAuthTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

export { runAuthTests };
