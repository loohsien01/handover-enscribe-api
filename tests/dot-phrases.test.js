/**
 * Test Suite: Dot Phrases API
 * Tests CRUD operations: GET all, GET single, POST, PATCH, DELETE
 * Note: Requires valid JWT token for authentication
 * Requires: TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts, getApiBaseUrl } from './testConfig.js';

const runner = new TestRunner('Dot Phrases API Tests');

// Will store real access token from test account
let accessToken = null;
// Cache dot phrase ID from Test 2 for dependent tests (Test 9, 10)
let cachedDotPhraseId = null;

/**
 * Run all dotPhrases tests
 */
async function runDotPhrasesTests() {
  console.log('Starting Dot Phrases API tests...');
  console.log(`Server: ${getApiBaseUrl()}`);
  console.log('Note: These tests require valid JWT authentication\n');
  console.log('Note: These tests require valid JWT authentication\n');

  // Get valid access token from test account
  if (hasTestAccounts()) {
    const testAccount = getTestAccount('primary');
    if (testAccount && testAccount.email && testAccount.password) {
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
        console.log('✓ Obtained valid access token from test account\n');
      } else {
        console.log('⚠️  Could not obtain access token from test account');
        console.log('   Verify TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
      }
    }
  } else {
    console.log('⚠️  Test credentials not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
  }

  // Test 1: GET /dot-phrases without auth - should fail
  await runner.test('Test 1: GET /dot-phrases without authentication', {
    method: 'GET',
    endpoint: '/api/dot-phrases',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Only run remaining tests if we have a valid token
  if (!accessToken) {
    console.warn('\n⚠️  Skipping Tests 2-10: No valid access token available');
    console.log('To run full test suite:');
    console.log('  1. Add credentials to .env.local:');
    console.log('     TEST_ACCOUNT_EMAIL=your@email.com');
    console.log('     TEST_ACCOUNT_PASSWORD=yourpassword');
    console.log('  2. Ensure server is running: npm run dev:fastify');
    console.log('  3. Run: npm run test:dot-phrases\n');
    
    runner.printResults();
    const resultsFile = runner.saveResults('dot-phrases-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // Test 2: POST /dot-phrases with valid data - CREATE DOT PHRASE FOR DEPENDENT TESTS
  console.log('\n⏳ Test 2 creates a real dot phrase for Tests 9-10. If this fails, those tests will be skipped.\n');
  
  const createResponse = await fetch(`${runner.baseUrl}/api/dot-phrases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      trigger: 'test-hpi-' + Date.now(),
      expansion: 'History of Present Illness with relevant medical details and symptoms',
    }),
  });

  let test2Passed = false;
  let test2Message = '';
  
  if (createResponse.ok && createResponse.status === 201) {
    const createdData = await createResponse.json();
    if (createdData?.id) {
      cachedDotPhraseId = createdData.id;
      test2Passed = true;
      test2Message = `Created dot phrase with ID: ${cachedDotPhraseId}`;
    } else {
      test2Message = 'Response missing ID field';
    }
  } else {
    test2Message = `Expected 201, got ${createResponse.status}`;
  }

  runner.results.push({
    name: 'Test 2: POST /dot-phrases with valid data (create for dependent tests)',
    passed: test2Passed,
    endpoint: '/api/dot-phrases',
    method: 'POST',
    status: createResponse.status,
    expectedStatus: 201,
    customMessage: test2Message,
    testNumber: 2,
    timestamp: new Date().toISOString(),
  });

  const test2Result = test2Passed ? '✅' : '❌';
  console.log(`${test2Result} Test 2: POST /dot-phrases with valid data (create for dependent tests)`);
  console.log(`   ${test2Message}\n`);

  // Test 3: GET /dot-phrases with auth - list all
  await runner.test('Test 3: GET /dot-phrases with authentication (list all)', {
    method: 'GET',
    endpoint: '/api/dot-phrases',
    headers: authHeaders,
    expectedStatus: 200,
  });

  // Test 4: GET /dot-phrases/:id with auth - get single (invalid ID)
  await runner.test('Test 4: GET /dot-phrases/:id with authentication (invalid ID)', {
    method: 'GET',
    endpoint: '/api/dot-phrases/invalid-id-123',
    headers: authHeaders,
    expectedStatus: 404, // Expected to not exist
  });

  // Test 5: POST /dot-phrases without auth - should fail
  await runner.test('Test 5: POST /dot-phrases without authentication', {
    method: 'POST',
    endpoint: '/api/dot-phrases',
    body: {
      trigger: 'hpi',
      expansion: 'History of Present Illness',
    },
    expectedStatus: 401,
  });

  // Test 6: POST /dot-phrases with missing trigger - validation error
  await runner.test('Test 6: POST /dot-phrases with missing trigger', {
    method: 'POST',
    endpoint: '/api/dot-phrases',
    headers: authHeaders,
    body: {
      expansion: 'Missing trigger field',
    },
    expectedStatus: 400,
    validator: (data) => {
      if (!data.error) return { valid: false, reason: 'Missing error field' };
      if (data.error.name !== 'ZodError') return { valid: false, reason: `Expected ZodError, got ${data.error.name}` };
      if (!data.error.message.includes('trigger')) return { valid: false, reason: 'Error message should mention trigger field' };
      if (!data.error.message.includes('required')) return { valid: false, reason: 'Error message should mention required' };
      return { valid: true };
    },
  });

  // Test 7: POST /dot-phrases with missing expansion - validation error
  await runner.test('Test 7: POST /dot-phrases with missing expansion', {
    method: 'POST',
    endpoint: '/api/dot-phrases',
    headers: authHeaders,
    body: {
      trigger: 'test',
    },
    expectedStatus: 400,
    validator: (data) => {
      if (!data.error) return { valid: false, reason: 'Missing error field' };
      if (data.error.name !== 'ZodError') return { valid: false, reason: `Expected ZodError, got ${data.error.name}` };
      if (!data.error.message.includes('expansion')) return { valid: false, reason: 'Error message should mention expansion field' };
      if (!data.error.message.includes('required')) return { valid: false, reason: 'Error message should mention required' };
      return { valid: true };
    },
  });

  // Test 8: PATCH /dot-phrases/:id with invalid ID
  await runner.test('Test 8: PATCH /dot-phrases/:id with invalid ID', {
    method: 'PATCH',
    endpoint: '/api/dot-phrases/invalid-id-123',
    headers: authHeaders,
    body: {
      trigger: 'updated',
      expansion: 'Updated expansion',
    },
    expectedStatus: 400, // Expected to not exist
  });

  // Test 9: PATCH /dot-phrases/:id with real created dot phrase (DEPENDENT ON TEST 2)
  let test9Passed = false;
  let test9Message = '';
  if (!cachedDotPhraseId) {
    test9Message = '⚠️  SKIPPED: Test 2 failed, cannot test PATCH with real dot phrase';
  } else {
    const patchResponse = await fetch(`${runner.baseUrl}/api/dot-phrases/${cachedDotPhraseId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        expansion: 'Updated expansion with new content',
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      test9Passed = true;
      test9Message = 'Successfully updated dot phrase';
    } else {
      test9Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 9: PATCH /dot-phrases/:id with real created dot phrase',
    passed: test9Passed,
    endpoint: '/api/dot-phrases/:id',
    method: 'PATCH',
    status: test9Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test9Message,
    testNumber: 9,
    timestamp: new Date().toISOString(),
  });

  const test9Result = test9Passed ? '✅' : (test9Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test9Result} Test 9: PATCH /dot-phrases/:id with real created dot phrase`);
  console.log(`   ${test9Message}`);

  // Test 10: DELETE /dot-phrases/:id with real created dot phrase (DEPENDENT ON TEST 2)
  let test10Passed = false;
  let test10Message = '';
  if (!cachedDotPhraseId) {
    test10Message = '⚠️  SKIPPED: Test 2 failed, cannot test DELETE with real dot phrase';
  } else {
    const deleteResponse = await fetch(`${runner.baseUrl}/api/dot-phrases/${cachedDotPhraseId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    if (deleteResponse.ok && deleteResponse.status === 200) {
      test10Passed = true;
      test10Message = 'Successfully deleted dot phrase';
    } else {
      test10Message = `Expected 200, got ${deleteResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 10: DELETE /dot-phrases/:id with real created dot phrase',
    passed: test10Passed,
    endpoint: '/api/dot-phrases/:id',
    method: 'DELETE',
    status: test10Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test10Message,
    testNumber: 10,
    timestamp: new Date().toISOString(),
  });

  const test10Result = test10Passed ? '✅' : (test10Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test10Result} Test 10: DELETE /dot-phrases/:id with real created dot phrase`);
  console.log(`   ${test10Message}\n`);
  // Print results
  runner.printResults();
  // Save results to file
  const resultsFile = runner.saveResults('dot-phrases-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Dot Phrases API test suite completed\n');
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runDotPhrasesTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

export { runDotPhrasesTests };
