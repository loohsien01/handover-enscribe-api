/**
 * Test Suite: Note Template Section Orders API
 * Tests CRUD operations: GET all, GET single, POST, PATCH, DELETE
 * With atomic batch operations and order validation
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

const runner = new TestRunner('Note Template Section Orders API Tests');

// Will store real access token from test account
let accessToken = null;

// Cache IDs from dependent tests for downstream tests
let cachedTemplateId = null;
let cachedSection1Id = null;
let cachedSection2Id = null;
let cachedSection3Id = null;
let cachedOrderId = null;

/**
 * Run all note template section orders tests
 */
async function runNoteTemplateSectionOrdersTests() {
  console.log('Starting Note Template Section Orders API tests...');
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

  // Test 1: GET without auth - should fail
  await runner.test('Test 1: GET /note-template-section-orders without authentication', {
    method: 'GET',
    endpoint: '/api/note-template-section-orders',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Only run remaining tests if we have a valid token
  if (!accessToken) {
    console.warn('\n⚠️  Skipping Tests 2+: No valid access token available');
    console.log('To run full test suite:');
    console.log('  1. Add credentials to .env.local:');
    console.log('     TEST_ACCOUNT_EMAIL=your@email.com');
    console.log('     TEST_ACCOUNT_PASSWORD=yourpassword');
    console.log('  2. Ensure server is running: npm run dev:fastify');
    console.log('  3. Run: npm run test:note-template-section-orders\n');
    
    runner.printResults();
    const resultsFile = runner.saveResults('note-template-section-orders-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // ================================
  // Setup: Create Test Template
  // ================================
  console.log('\n⏳ Setting up test data: Creating note template and sections...\n');

  // Create template
  let templateCreated = false;
  const templateResponse = await fetch(`${runner.baseUrl}/api/note-templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      name: 'Test Template',
    }),
  });

  if (templateResponse.ok) {
    const template = await templateResponse.json();
    cachedTemplateId = template.id;
    templateCreated = true;
    console.log(`✓ Created test template (ID: ${cachedTemplateId})\n`);
  }

  if (!templateCreated) {
    console.log('❌ Failed to create test template. Skipping remaining tests.\n');
    runner.printResults();
    const resultsFile = runner.saveResults('note-template-section-orders-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  // Create 3 test sections
  const sectionNames = ['ChiefComplaint', 'PhysicalExam', 'Assessment'];
  let sectionsCreated = 0;

  for (const name of sectionNames) {
    const sectionResponse = await fetch(`${runner.baseUrl}/api/note-template-sections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: `${name} - ${Date.now()}`,
        layout: 'paragraph',
        details: `Details for ${name}`,
      }),
    });

    if (sectionResponse.ok) {
      const section = await sectionResponse.json();
      if (!cachedSection1Id) cachedSection1Id = section.id;
      else if (!cachedSection2Id) cachedSection2Id = section.id;
      else if (!cachedSection3Id) cachedSection3Id = section.id;
      sectionsCreated++;
    }
  }

  if (sectionsCreated < 3) {
    console.log(`⚠️  Only created ${sectionsCreated}/3 sections. Some tests may be skipped.\n`);
  } else {
    console.log(`✓ Created 3 test sections (IDs: ${cachedSection1Id}, ${cachedSection2Id}, ${cachedSection3Id})\n`);
  }

  // ================================
  // Test 2: POST without auth - should fail
  // ================================
  await runner.test('Test 2: POST /note-template-section-orders without authentication', {
    method: 'POST',
    endpoint: '/api/note-template-section-orders',
    body: {
      noteTemplate_id: cachedTemplateId,
      section_id: cachedSection1Id,
      order: 1,
    },
    expectedStatus: 401,
  });

  // ================================
  // Test 3: POST with valid data (create section order)
  // ================================
  console.log('\n⏳ Test 3 creates a section order for dependent tests. If this fails, Tests 8-11 will be skipped.\n');

  let test3Passed = false;
  let test3Message = '';

  const postResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      noteTemplate_id: cachedTemplateId,
      section_id: cachedSection1Id,
      order: 1,
    }),
  });

  if (postResponse.ok && postResponse.status === 201) {
    const createdOrder = await postResponse.json();
    if (createdOrder?.id) {
      cachedOrderId = createdOrder.id;
      test3Passed = true;
      test3Message = `Created section order with ID: ${cachedOrderId}`;
    } else {
      test3Message = 'Response missing ID field';
    }
  } else {
    test3Message = `Expected 201, got ${postResponse.status}`;
  }

  runner.results.push({
    name: 'Test 3: POST /note-template-section-orders with valid data (create for dependent tests)',
    passed: test3Passed,
    endpoint: '/api/note-template-section-orders',
    method: 'POST',
    status: postResponse.status,
    expectedStatus: 201,
    customMessage: test3Message,
    testNumber: 3,
    timestamp: new Date().toISOString(),
  });

  const test3Result = test3Passed ? '✅' : '❌';
  console.log(`${test3Result} Test 3: POST /note-template-section-orders with valid data (create for dependent tests)`);
  console.log(`   ${test3Message}\n`);

  // ================================
  // Test 4: GET all section orders with auth
  // ================================
  await runner.test('Test 4: GET /note-template-section-orders with authentication (list all)', {
    method: 'GET',
    endpoint: '/api/note-template-section-orders',
    headers: authHeaders,
    expectedStatus: 200,
  });

  // ================================
  // Test 5: GET single section order by ID
  // ================================
  let test5Passed = false;
  let test5Message = '';

  if (!cachedOrderId) {
    test5Message = '⚠️  SKIPPED: Test 3 failed, cannot test GET single';
  } else {
    const getResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders/${cachedOrderId}`, {
      method: 'GET',
      headers: authHeaders,
    });

    if (getResponse.ok && getResponse.status === 200) {
      test5Passed = true;
      test5Message = 'Successfully retrieved section order';
    } else {
      test5Message = `Expected 200, got ${getResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 5: GET /note-template-section-orders/:id with valid ID',
    passed: test5Passed,
    endpoint: '/api/note-template-section-orders/:id',
    method: 'GET',
    status: test5Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test5Message,
    testNumber: 5,
    timestamp: new Date().toISOString(),
  });

  const test5Result = test5Passed ? '✅' : (test5Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test5Result} Test 5: GET /note-template-section-orders/:id with valid ID`);
  console.log(`   ${test5Message}\n`);

  // ================================
  // Test 6: GET with invalid ID - should return 404
  // ================================
  await runner.test('Test 6: GET /note-template-section-orders/:id with invalid ID', {
    method: 'GET',
    endpoint: '/api/note-template-section-orders/999999',
    headers: authHeaders,
    expectedStatus: 404,
  });

  // ================================
  // Test 7: POST with non-consecutive order (expected order = 2, got 3)
  // ================================
  let test7Passed = false;
  let test7Message = '';

  const nonConsecutiveResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      noteTemplate_id: cachedTemplateId,
      section_id: cachedSection2Id,
      order: 3, // Should be 2 (since max is 1)
    }),
  });

  if (nonConsecutiveResponse.status === 400) {
    const errorData = await nonConsecutiveResponse.json();
    const errorString = typeof errorData.error === 'string' ? errorData.error : JSON.stringify(errorData.error);
    if (errorData.error && errorString.includes('consecutive')) {
      test7Passed = true;
      test7Message = 'Correctly rejected non-consecutive order';
    } else {
      test7Message = 'Got 400 but error message incorrect';
    }
  } else {
    test7Message = `Expected 400, got ${nonConsecutiveResponse.status}`;
  }

  runner.results.push({
    name: 'Test 7: POST with non-consecutive order (order validation)',
    passed: test7Passed,
    endpoint: '/api/note-template-section-orders',
    method: 'POST',
    status: nonConsecutiveResponse.status,
    expectedStatus: 400,
    customMessage: test7Message,
    testNumber: 7,
    timestamp: new Date().toISOString(),
  });

  const test7Result = test7Passed ? '✅' : '❌';
  console.log(`${test7Result} Test 7: POST with non-consecutive order (order validation)`);
  console.log(`   ${test7Message}\n`);

  // ================================
  // Test 8: POST correct next order (order = 2)
  // ================================
  let test8Passed = false;
  let test8Message = '';

  const consecutiveResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      noteTemplate_id: cachedTemplateId,
      section_id: cachedSection2Id,
      order: 2, // Correct: next consecutive order
    }),
  });

  if (consecutiveResponse.ok && consecutiveResponse.status === 201) {
    test8Passed = true;
    test8Message = 'Successfully created with correct consecutive order';
  } else {
    test8Message = `Expected 201, got ${consecutiveResponse.status}`;
  }

  runner.results.push({
    name: 'Test 8: POST with correct consecutive order',
    passed: test8Passed,
    endpoint: '/api/note-template-section-orders',
    method: 'POST',
    status: consecutiveResponse.status,
    expectedStatus: 201,
    customMessage: test8Message,
    testNumber: 8,
    timestamp: new Date().toISOString(),
  });

  const test8Result = test8Passed ? '✅' : '❌';
  console.log(`${test8Result} Test 8: POST with correct consecutive order`);
  console.log(`   ${test8Message}\n`);

  // ================================
  // Test 9: PATCH batch reorder (atomic)
  // ================================
  console.log('\n⏳ Test 9 reorders all sections. If this fails, test 10 will be skipped.\n');

  let test9Passed = false;
  let test9Message = '';

  if (!cachedOrderId || !cachedSection1Id || !cachedSection2Id || !cachedSection3Id) {
    test9Message = '⚠️  SKIPPED: Prerequisite data not available';
  } else {
    const patchResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        noteTemplate_id: cachedTemplateId,
        sections: [
          { id: cachedSection2Id, order: 1 }, // Reordered
          { id: cachedSection1Id, order: 2 }, // Reordered
          { id: cachedSection3Id, order: 3 }, // New
        ],
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      const patchData = await patchResponse.json();
      if (patchData.sections && patchData.sections.length === 3) {
        test9Passed = true;
        test9Message = 'Successfully reordered all sections (atomic)';
      } else {
        test9Message = 'Response sections array incorrect';
      }
    } else {
      test9Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 9: PATCH /note-template-section-orders (atomic batch reorder)',
    passed: test9Passed,
    endpoint: '/api/note-template-section-orders',
    method: 'PATCH',
    status: test9Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test9Message,
    testNumber: 9,
    timestamp: new Date().toISOString(),
  });

  const test9Result = test9Passed ? '✅' : (test9Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test9Result} Test 9: PATCH /note-template-section-orders (atomic batch reorder)`);
  console.log(`   ${test9Message}\n`);

  // ================================
  // Test 10: PATCH with gap in order (1, 3, 4 instead of 1, 2, 3)
  // ================================
  let test10Passed = false;
  let test10Message = '';
  let gapResponse;

  if (!cachedSection1Id || !cachedSection2Id || !cachedSection3Id) {
    test10Message = '⚠️  SKIPPED: Prerequisite data not available';
  } else {
    gapResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        noteTemplate_id: cachedTemplateId,
        sections: [
          { id: cachedSection1Id, order: 1 },
          { id: cachedSection2Id, order: 3 }, // Gap: should be 2
          { id: cachedSection3Id, order: 4 },
        ],
      }),
    });

    if (gapResponse.status === 400) {
      const errorData = await gapResponse.json();
      const errorString = typeof errorData.error === 'string' ? errorData.error : JSON.stringify(errorData.error);
      if (errorData.error && errorString.includes('consecutive')) {
        test10Passed = true;
        test10Message = 'Correctly rejected orders with gaps';
      } else {
        test10Message = 'Got 400 but error message incorrect';
      }
    } else {
      test10Message = `Expected 400, got ${gapResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 10: PATCH with gap in order (1, 3, 4) - validation error',
    passed: test10Passed,
    endpoint: '/api/note-template-section-orders',
    method: 'PATCH',
    status: gapResponse?.status,
    expectedStatus: 400,
    customMessage: test10Message,
    testNumber: 10,
    timestamp: new Date().toISOString(),
  });

  const test10Result = test10Passed ? '✅' : (test10Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test10Result} Test 10: PATCH with gap in order (1, 3, 4) - validation error`);
  console.log(`   ${test10Message}\n`);

  // ================================
  // Test 11: PATCH with non-existent section ID
  // ================================
  let test11Passed = false;
  let test11Message = '';
  let invalidSectionResponse;

  if (!cachedSection1Id || !cachedSection2Id) {
    test11Message = '⚠️  SKIPPED: Prerequisite data not available';
  } else {
    invalidSectionResponse = await fetch(`${runner.baseUrl}/api/note-template-section-orders`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        noteTemplate_id: cachedTemplateId,
        sections: [
          { id: cachedSection1Id, order: 1 },
          { id: 999999, order: 2 }, // Non-existent section
        ],
      }),
    });

    if (invalidSectionResponse.status === 400) {
      test11Passed = true;
      test11Message = 'Correctly rejected non-existent section (atomic failure)';
    } else {
      test11Message = `Expected 400, got ${invalidSectionResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 11: PATCH with non-existent section ID (atomic failure)',
    passed: test11Passed,
    endpoint: '/api/note-template-section-orders',
    method: 'PATCH',
    status: invalidSectionResponse?.status,
    expectedStatus: 400,
    customMessage: test11Message,
    testNumber: 11,
    timestamp: new Date().toISOString(),
  });

  const test11Result = test11Passed ? '✅' : (test11Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test11Result} Test 11: PATCH with non-existent section ID (atomic failure)`);
  console.log(`   ${test11Message}\n`);

  // ================================
  // Test 12: POST to non-existent template - should fail
  // ================================
  await runner.test('Test 12: POST to non-existent template (404)', {
    method: 'POST',
    endpoint: '/api/note-template-section-orders',
    headers: authHeaders,
    body: {
      noteTemplate_id: 999999,
      section_id: cachedSection1Id,
      order: 1,
    },
    expectedStatus: 404,
  });

  // ================================
  // Cleanup: Delete test data (template and sections)
  // ================================
  console.log('\n⏳ Cleaning up test data...\n');

  // Delete template (cascade will delete associated section orders)
  if (cachedTemplateId) {
    const deleteTemplateResponse = await fetch(`${runner.baseUrl}/api/note-templates/${cachedTemplateId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    if (deleteTemplateResponse.ok || deleteTemplateResponse.status === 204) {
      console.log(`✓ Deleted test template (ID: ${cachedTemplateId})`);
    } else {
      console.log(`⚠️  Failed to delete test template (status: ${deleteTemplateResponse.status})`);
    }
  }

  // Delete sections (in case they weren't cascade-deleted)
  for (const sectionId of [cachedSection1Id, cachedSection2Id, cachedSection3Id]) {
    if (sectionId) {
      const deleteSectionResponse = await fetch(`${runner.baseUrl}/api/note-template-sections/${sectionId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });

      if (deleteSectionResponse.ok || deleteSectionResponse.status === 204) {
        console.log(`✓ Deleted test section (ID: ${sectionId})`);
      }
      // Silently skip if section deletion fails (may be cascade-deleted already)
    }
  }

  console.log('');

  // ================================
  // Print results
  // ================================
  runner.printResults();

  // Save results to file
  const resultsFile = runner.saveResults('note-template-section-orders-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Note Template Section Orders API test suite completed\n');

  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runNoteTemplateSectionOrdersTests();
    process.exit(0);
  } catch (error) {
    console.error('Test runner error:', error);
    process.exit(1);
  }
}

export { runNoteTemplateSectionOrdersTests };
