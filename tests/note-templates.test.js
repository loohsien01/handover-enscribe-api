/**
 * Test Suite: Note Templates API
 * Tests CRUD operations: GET all, GET single, POST, PATCH, DELETE
 * Also: POST /api/note-templates/llm-extract (multipart/form-data, field: file)
 * Note: Requires valid JWT token for authentication (tests 2–10, 13–16)
 * Requires: TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts, getApiBaseUrl } from './testConfig.js';

const runner = new TestRunner('Note Templates API Tests');

const MOCK_TOKEN = 'invalid.token.here';
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const PDF_FIXTURE = '2026-03-25____11-16-53-PM.pdf';

function getFixtureFile() {
  const pdfPath = path.join(FIXTURES_DIR, PDF_FIXTURE);
  if (fs.existsSync(pdfPath)) {
    return {
      filename: PDF_FIXTURE,
      contentType: 'application/pdf',
      buffer: fs.readFileSync(pdfPath),
    };
  }
  return null;
}

// Will store real access token from test account
let accessToken = null;
// Cache note template ID from Test 2 for dependent tests (Test 9, 10)
let cachedNoteTemplateId = null;

/**
 * Run all noteTemplate tests
 */
async function runNoteTemplateTests() {
  console.log('Starting Note Templates API tests...');
  console.log(`Server: ${getApiBaseUrl()}`);
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
        }),
      });

      if (signInResponse.ok) {
        const authData = await signInResponse.json();
        accessToken =
          authData?.token?.access_token ||
          authData?.session?.access_token ||
          authData?.access_token ||
          null;
        if (accessToken) {
          console.log('✓ Obtained valid access token from test account\n');
        }
      } else {
        console.log('⚠️  Could not obtain access token from test account');
        console.log('   Verify TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
      }
    }
  } else {
    console.log('⚠️  Test credentials not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
  }

  // Test 1: GET /api/note-templates without auth - should fail
  await runner.test('Test 1: GET /api/note-templates without authentication', {
    method: 'GET',
    endpoint: '/api/note-templates',
    expectedStatus: 401,
    expectedFields: ['error'],
    testNumber: 1,
  });

  const tinyTxt = {
    filename: 'tiny.txt',
    contentType: 'text/plain',
    buffer: Buffer.from('hello'),
  };

  // Only run remaining CRUD + llm-extract (auth) tests if we have a valid token
  if (!accessToken) {
    console.warn('\n⚠️  Skipping Tests 2-10 and 13-16: No valid access token available');
    console.log('To run full test suite:');
    console.log('  1. Add credentials to .env.local:');
    console.log('     TEST_ACCOUNT_EMAIL=your@email.com');
    console.log('     TEST_ACCOUNT_PASSWORD=yourpassword');
    console.log('  2. Ensure server is running: npm run dev:fastify');
    console.log('  3. Run: npm run test:note-templates\n');

    console.log('Contract: POST /api/note-templates/llm-extract — multipart/form-data with "file" field\n');

    await runner.testMultipart('Test 11: POST /note-templates/llm-extract without auth', {
      method: 'POST',
      endpoint: '/api/note-templates/llm-extract',
      testNumber: 11,
      expectedStatus: 401,
      filePart: tinyTxt,
    });

    await runner.testMultipart('Test 12: POST /note-templates/llm-extract with invalid token', {
      method: 'POST',
      endpoint: '/api/note-templates/llm-extract',
      testNumber: 12,
      expectedStatus: 401,
      headers: {
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
      filePart: tinyTxt,
    });

    runner.printResults(16);
    const resultsFile = runner.saveResults('note-templates-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // Test 2: POST /api/note-templates with valid data - CREATE NOTE TEMPLATE FOR DEPENDENT TESTS
  console.log('\n⏳ Test 2 creates a real note template for Tests 9-10. If this fails, those tests will be skipped.\n');
  
  const createResponse = await fetch(`${runner.baseUrl}/api/note-templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      name: 'Test Template',
    }),
  });

  let test2Passed = false;
  let test2Message = '';
  
  if (createResponse.ok && createResponse.status === 201) {
    const createdData = await createResponse.json();
    if (createdData?.id) {
      cachedNoteTemplateId = createdData.id;
      test2Passed = true;
      test2Message = `Created note template with ID: ${cachedNoteTemplateId}`;
    } else {
      test2Message = 'Response missing ID field';
    }
  } else {
    test2Message = `Expected 201, got ${createResponse.status}`;
  }

  runner.results.push({
    name: 'Test 2: POST /api/note-templates with valid data (create for dependent tests)',
    passed: test2Passed,
    endpoint: '/api/note-templates',
    method: 'POST',
    status: createResponse.status,
    expectedStatus: 201,
    customMessage: test2Message,
    testNumber: 2,
    timestamp: new Date().toISOString(),
  });

  const test2Result = test2Passed ? '✅' : '❌';
  console.log(`${test2Result} Test 2: POST /api/note-templates with valid data (create for dependent tests)`);
  console.log(`   ${test2Message}`);
  console.log(`   ⚠️  TEST DEPENDENCY: Tests 9-10 depend on Test 2. If Test 2 fails, Tests 9-10 will be skipped.\n`);

  // Test 3: GET /api/note-templates with auth - list all (DEPENDS ON TEST 2)
  await runner.test('Test 3: GET /api/note-templates with authentication (list all)', {
    method: 'GET',
    endpoint: '/api/note-templates',
    headers: authHeaders,
    expectedStatus: 200,
    testNumber: 3,
  });

  // Test 4: GET /api/note-templates/:id with auth - get single (invalid ID)
  await runner.test('Test 4: GET /api/note-templates/:id with authentication (invalid ID)', {
    method: 'GET',
    endpoint: '/api/note-templates/99999',
    headers: authHeaders,
    expectedStatus: 404,
    testNumber: 4,
  });

  // Test 5: POST /api/note-templates without auth - should fail
  await runner.test('Test 5: POST /api/note-templates without authentication', {
    method: 'POST',
    endpoint: '/api/note-templates',
    body: {
      name: 'Unauthorized Template',
    },
    expectedStatus: 401,
    testNumber: 5,
  });

  // Test 6: POST /api/note-templates with missing name - validation error
  await runner.test('Test 6: POST /api/note-templates with missing name field', {
    method: 'POST',
    endpoint: '/api/note-templates',
    headers: authHeaders,
    body: {},
    expectedStatus: 400,
    testNumber: 6,
    customValidator: (data) => {
      if (!data.error) return { passed: false, message: 'Missing error field' };
      if (data.error.name !== 'ZodError') return { passed: false, message: `Expected ZodError, got ${data.error.name}` };
      if (!data.error.message) return { passed: false, message: 'Missing error message' };
      const message = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error.message);
      if (!message.includes('name')) return { passed: false, message: 'Error message should mention name field' };
      if (!message.includes('invalid_type') && !message.includes('undefined')) return { passed: false, message: 'Error should indicate invalid type or missing field' };
      return { passed: true, message: '✓ Zod validation error with invalid_type' };
    },
  });

  // Test 7: POST /api/note-templates with empty name - validation error
  await runner.test('Test 7: POST /api/note-templates with empty name', {
    method: 'POST',
    endpoint: '/api/note-templates',
    headers: authHeaders,
    body: {
      name: '',
    },
    expectedStatus: 400,
    testNumber: 7,
    customValidator: (data) => {
      if (!data.error) return { passed: false, message: 'Missing error field' };
      if (data.error.name !== 'ZodError') return { passed: false, message: `Expected ZodError, got ${data.error.name}` };
      if (!data.error.message) return { passed: false, message: 'Missing error message' };
      const message = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error.message);
      if (!message.includes('name')) return { passed: false, message: 'Error message should mention name field' };
      return { passed: true, message: '✓ Zod validation error for empty name' };
    },
  });

  // Test 8: PATCH /api/note-templates/:id with invalid ID
  await runner.test('Test 8: PATCH /api/note-templates/:id with invalid ID', {
    method: 'PATCH',
    endpoint: '/api/note-templates/99999',
    headers: authHeaders,
    body: {
      name: 'Updated Name',
    },
    expectedStatus: 404,
    testNumber: 8,
  });

  // Test 9: PATCH /api/note-templates/:id with real created template (DEPENDENT ON TEST 2)
  let test9Passed = false;
  let test9Message = '';
  if (!cachedNoteTemplateId) {
    test9Message = '⚠️  SKIPPED: Test 2 failed, cannot test PATCH with real note template';
  } else {
    const patchResponse = await fetch(`${runner.baseUrl}/api/note-templates/${cachedNoteTemplateId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'Updated Template Name - ' + Date.now(),
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      test9Passed = true;
      test9Message = 'Successfully updated note template';
    } else {
      test9Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 9: PATCH /api/note-templates/:id with real created template',
    passed: test9Passed,
    endpoint: '/api/note-templates/:id',
    method: 'PATCH',
    status: test9Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test9Message,
    testNumber: 9,
    timestamp: new Date().toISOString(),
  });

  const test9Result = test9Passed ? '✅' : (test9Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test9Result} Test 9: PATCH /api/note-templates/:id with real created template`);
  console.log(`   ${test9Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 9 depends on Test 2 (creation). If Test 2 fails, this test is skipped.\n`);

  // Test 10: DELETE /api/note-templates/:id with real created template (DEPENDENT ON TEST 2)
  let test10Passed = false;
  let test10Message = '';
  if (!cachedNoteTemplateId) {
    test10Message = '⚠️  SKIPPED: Test 2 failed, cannot test DELETE with real note template';
  } else {
    const deleteResponse = await fetch(`${runner.baseUrl}/api/note-templates/${cachedNoteTemplateId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    if (deleteResponse.ok && deleteResponse.status === 204) {
      test10Passed = true;
      test10Message = 'Successfully deleted note template';
    } else {
      test10Message = `Expected 204, got ${deleteResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 10: DELETE /api/note-templates/:id with real created template',
    passed: test10Passed,
    endpoint: '/api/note-templates/:id',
    method: 'DELETE',
    status: test10Passed ? 204 : null,
    expectedStatus: 204,
    customMessage: test10Message,
    testNumber: 10,
    timestamp: new Date().toISOString(),
  });

  const test10Result = test10Passed ? '✅' : (test10Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test10Result} Test 10: DELETE /api/note-templates/:id with real created template`);
  console.log(`   ${test10Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 10 depends on Test 2 (creation). If Test 2 fails, this test is skipped.\n`);

  // ===== LLM extract (POST /api/note-templates/llm-extract) =====
  console.log('Contract: POST /api/note-templates/llm-extract — multipart/form-data with "file" field\n');

  await runner.testMultipart('Test 11: POST /note-templates/llm-extract without auth', {
    method: 'POST',
    endpoint: '/api/note-templates/llm-extract',
    testNumber: 11,
    expectedStatus: 401,
    filePart: tinyTxt,
  });

  await runner.testMultipart('Test 12: POST /note-templates/llm-extract with invalid token', {
    method: 'POST',
    endpoint: '/api/note-templates/llm-extract',
    testNumber: 12,
    expectedStatus: 401,
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    filePart: tinyTxt,
  });

  await runner.testMultipart('Test 13: POST /note-templates/llm-extract missing file', {
    method: 'POST',
    endpoint: '/api/note-templates/llm-extract',
    testNumber: 13,
    expectedStatus: 400,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  await runner.testMultipart('Test 14: POST /note-templates/llm-extract unsupported file type', {
    method: 'POST',
    endpoint: '/api/note-templates/llm-extract',
    testNumber: 14,
    expectedStatus: 400,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    filePart: {
      filename: 'image.png',
      contentType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    },
  });

  await runner.testMultipart('Test 15: POST /note-templates/llm-extract empty file', {
    method: 'POST',
    endpoint: '/api/note-templates/llm-extract',
    testNumber: 15,
    expectedStatus: 400,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    filePart: {
      filename: 'empty.pdf',
      contentType: 'application/pdf',
      buffer: Buffer.alloc(0),
    },
  });

  const fixture = getFixtureFile();
  if (!fixture) {
    console.log(`⚠️  Fixture missing: expected ${PDF_FIXTURE}`);
    console.log('    Test 16 will be marked skipped in printed output.\n');
  } else {
    await runner.testMultipart(`Test 16: POST /note-templates/llm-extract valid fixture (${fixture.filename})`, {
      method: 'POST',
      endpoint: '/api/note-templates/llm-extract',
      testNumber: 16,
      expectedStatus: 200,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      filePart: fixture,
      customValidator: (body) => {
        const sections = body?.sections;
        const validLayouts =
          Array.isArray(sections) &&
          sections.every((s) => s?.layout === 'paragraph' || s?.layout === 'bullet points');
        const passed = Array.isArray(sections) && sections.length > 0 && validLayouts;
        return {
          passed,
          message: passed
            ? `Extracted ${sections.length} sections`
            : `Invalid sections response: ${JSON.stringify(body).substring(0, 200)}...`,
        };
      },
    });
  }

  // Print results
  runner.printResults(16);
  // Save results to file
  const resultsFile = runner.saveResults('note-templates-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Note Templates API test suite completed\n');
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runNoteTemplateTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

export { runNoteTemplateTests };
