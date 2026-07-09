/**
 * Test Suite: Authentication API
 * Tests all auth endpoints: sign-up, sign-in, sign-out, check-validity, resend
 *
 * `testNumber`: integers 1, 2, 3, … in file order (echoed in results JSON).
 *
 * `skipTest7`: when true, skips test 7 — sign-up with `userProfile.username` `"info"`
 * (requires DB seed `userProfiles.username === "info"`).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts } from './testConfig.js';

const runner = new TestRunner('Authentication API Tests');

/** Skips test 7 by default. Set `false` to enable. */
const skipTest7 = false;

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

  // 1
  await runner.test('Sign-up without password', {
    testNumber: 1,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-up',
      email: 'test@example.com',
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
  await runner.test('Sign-up with userProfile missing specialty (Zod)', {
    testNumber: 4,
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

  // 5
  await runner.test('Sign-up with userProfile empty username (Zod)', {
    testNumber: 5,
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

  // 6
  await runner.test('Sign-up with userProfile wrong type (Zod)', {
    testNumber: 6,
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

  // 7: requires DB seed `userProfiles.username === "info"`
  if (!skipTest7) {
    await runner.test(
      'Sign-up with userProfile username "info" (409 USERNAME_TAKEN, no auth user)',
      {
        testNumber: 7,
        method: 'POST',
        endpoint: '/api/auth',
        headers: JSON_ACCEPT_HEADERS,
        body: {
          action: 'sign-up',
          email: `info@sjpedgi.doctor`,
          password: '@2Sengaring',
          userProfile: { username: 'info', specialty: 'Internal Medicine' },
        },
        expectedStatus: 409,
        customValidator: (body) => {
          const passed =
            body?.code === 'USERNAME_TAKEN' &&
            body?.error === 'This username is already taken' &&
            body?.user == null &&
            body?.profileError == null;
          return {
            passed,
            message: passed
              ? 'Username taken rejected before auth user creation'
              : `Expected 409 USERNAME_TAKEN, no user/profileError; got ${JSON.stringify(body)}`,
          };
        },
      }
    );
  } else {
    console.log(
      '\n⏭️  Test 7: SKIPPED BY DEFAULT (set skipTest7 = false to enable).\n'
    );
    runner.results.push({
      name: 'Sign-up with userProfile username "info" (409 USERNAME_TAKEN, no auth user)',
      passed: true,
      skipped: true,
      endpoint: '/api/auth',
      method: 'POST',
      status: null,
      expectedStatus: 409,
      body: {},
      customMessage: 'SKIPPED (skipTest7)',
      testNumber: 7,
      timestamp: new Date().toISOString(),
    });
  }

  // 8 — requires TEST_ACCOUNT_* in .env.local (no dummy sign-in fallback)
  const testAccount = getTestAccount('primary');
  if (testAccount?.email && testAccount?.password) {
    await runner.test('Sign-in with email and password (real credentials)', {
      testNumber: 8,
      method: 'POST',
      endpoint: '/api/auth',
      body: {
        action: 'sign-in',
        email: testAccount.email,
        password: testAccount.password,
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
    console.warn(
      '⚠️  Skipping test 8: set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local for sign-in smoke test.'
    );
    runner.results.push({
      name: 'Sign-in with email and password (real credentials)',
      passed: true,
      skipped: true,
      endpoint: '/api/auth',
      method: 'POST',
      status: null,
      expectedStatus: 200,
      body: {},
      customMessage: 'SKIPPED: no primary test credentials',
      testNumber: 8,
      timestamp: new Date().toISOString(),
    });
  }

  // 9
  await runner.test('Sign-in with wrong password', {
    testNumber: 9,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-in',
      email: 'existinguser@example.com',
      password: 'WrongPassword123!',
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

  // 10
  await runner.test('Sign-in with empty password', {
    testNumber: 10,
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

  // 11
  await runner.test('Sign-in with non-existent user', {
    testNumber: 11,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-in',
      email: 'nonexistent@example.com',
      password: 'Password123!',
    },
    expectedStatus: 401,
  });

  // 12
  await runner.test('Check validity without auth header', {
    testNumber: 12,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'check-validity',
    },
    expectedStatus: 401,
  });

  // 13
  await runner.test('Check validity with invalid token', {
    testNumber: 13,
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

  // 14
  await runner.test('Sign-out without auth header', {
    testNumber: 14,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'sign-out',
    },
    expectedStatus: 401,
  });

  // 15
  await runner.test('Resend confirmation email', {
    testNumber: 15,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'resend',
      email: 'newuser@example.com',
    },
    expectedStatus: 200,
    expectedFields: ['message'],
  });

  // 16
  await runner.test('Resend without email', {
    testNumber: 16,
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

  // 17
  await runner.test('Invalid action type', {
    testNumber: 17,
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

  // 18
  await runner.test('Missing action field', {
    testNumber: 18,
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

  // 19
  await runner.test('Resend with emailRedirectTo', {
    testNumber: 19,
    method: 'POST',
    endpoint: '/api/auth',
    body: {
      action: 'resend',
      email: 'anotheruser@example.com',
      emailRedirectTo: 'https://myapp.com/confirm',
    },
    expectedStatus: 200,
  });

  // 20
  await runner.test('Resend with invalid emailRedirectTo URL', {
    testNumber: 20,
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

  // ===========================================
  // REAL ACCOUNT TESTS (if configured)
  // ===========================================
  
  if (hasTestAccounts()) {
    const testAccount = getTestAccount('primary');
    
    if (testAccount && testAccount.email && testAccount.password) {
      console.log(`\n📝 Running real account tests with: ${testAccount.email.split('@')[0]}@****\n`);
      
      // 21
      await runner.test('Sign-in with valid account (real credentials)', {
        testNumber: 21,
        method: 'POST',
        endpoint: '/api/auth',
        body: {
          action: 'sign-in',
          email: testAccount.email,
          password: testAccount.password,
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

      // Extract token from test 21 for test 22
      const signInResult = runner.results[runner.results.length - 1];
      const accessToken = signInResult.body?.token?.access_token;

      // 22 (token from test 21)
      if (accessToken) {
        await runner.test('Check validity endpoint (with real token)', {
          testNumber: 22,
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
    console.log('\n⚠️  Test accounts not configured. Skipping real credential tests.');
    console.log('To enable: Add TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD to .env.local\n');
  }

  // ===========================================
  // NEW: Token Refresh and Cookie Status Tests
  // ===========================================

  if (hasTestAccounts()) {
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

        // 23
        await runner.test('POST /api/auth/refresh without token', {
          testNumber: 23,
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

        // 24
        await runner.test('POST /api/auth/refresh with invalid token', {
          testNumber: 24,
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

        // 25 (before refresh — avoids cookie rotation)
        if (refreshTokenCookie) {
          await runner.test('GET /api/auth/cookie-status with valid cookie', {
            testNumber: 25,
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

        // 26
        await runner.test('GET /api/auth/cookie-status without cookie', {
          testNumber: 26,
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

        // 27
        await runner.test('GET /api/auth/cookie-status with invalid cookie', {
          testNumber: 27,
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
        // 28 (after cookie-status; may wait for access-token expiry)
        if (refreshTokenCookie) {
          const oldTid = extractTidFromWrapperJwt(refreshTokenCookie);
          let newTid = null;

          // Wait 60 seconds to test JWT expiry/regeneration
          console.log(`  ⚠️⚠️⚠️  Please check Supabase: Access token expiry time is  30s`);
          console.log(`  ⏳ Waiting 5 seconds before refresh to test JWT regeneration...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          console.log(`  ✅ Wait complete, proceeding with refresh test\n`);

          await runner.test('POST /api/auth/refresh with valid token', {
            testNumber: 28,
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
