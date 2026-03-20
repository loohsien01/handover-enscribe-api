/**
 * Test Suite: Note Templates Complete API
 * Tests atomic endpoints for templates with embedded sections + ordering
 * GET /api/note-templates/complete (batch)
 * GET /api/note-templates/complete/:id (single with sections)
 * POST /api/note-templates/complete (create with sections - atomic)
 * PATCH /api/note-templates/complete/:id (update template + sections + ordering - atomic)
 * 
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

const runner = new TestRunner('Note Templates Complete API Tests');

// Will store real access token from test account
let accessToken = null;

// Cache section IDs from Test 2 for dependent tests
let cachedSectionIds = [];

// Cache complete template ID from Test 4 for dependent tests (Test 8-10)
let cachedCompleteTemplateId = null;

/**
 * Run all note templates complete tests
 */
async function runNoteTemplatesCompleteTests() {
  console.log('Starting Note Templates Complete API tests...');
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

  // Test 1: GET /api/note-templates/complete without auth - should fail
  await runner.test('Test 1: GET /api/note-templates/complete without authentication', {
    method: 'GET',
    endpoint: '/api/note-templates/complete',
    expectedStatus: 401,
    expectedFields: ['error'],
    testNumber: 1,
  });

  // Only run remaining tests if we have a valid token
  if (!accessToken) {
    console.warn('\n⚠️  Skipping Tests 2-10: No valid access token available');
    console.log('To run full test suite:');
    console.log('  1. Add credentials to .env.local:');
    console.log('     TEST_ACCOUNT_EMAIL=your@email.com');
    console.log('     TEST_ACCOUNT_PASSWORD=yourpassword');
    console.log('  2. Ensure server is running: npm run dev:fastify');
    console.log('  3. Run: npm run test:note-templates-complete\n');
    
    runner.printResults();
    const resultsFile = runner.saveResults('note-templates-complete-tests.json');
    console.log(`✅ Test results saved to: ${resultsFile}\n`);
    return runner.getSummary();
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // ===== SETUP: Create sections for dependent tests =====
  
  console.log('⏳ Test 2 creates real note template sections for Tests 4-10. If this fails, those tests will be skipped.\n');

  let test2Passed = false;
  let test2Message = '';

  try {
    // Create first section
    const section1Response = await fetch(`${runner.baseUrl}/api/note-template-sections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'History of Present Illness - ' + Date.now(),
        layout: 'paragraph',
        details: 'Ask about onset, duration, severity, associated symptoms, prior treatments',
      }),
    });

    if (!section1Response.ok) {
      test2Message = `Failed to create section 1: ${section1Response.status}`;
    } else {
      const section1Data = await section1Response.json();
      if (section1Data?.id) {
        cachedSectionIds.push(section1Data.id);

        // Create second section
        const section2Response = await fetch(`${runner.baseUrl}/api/note-template-sections`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            name: 'Physical Examination - ' + Date.now(),
            layout: 'bullet points',
            details: '• Vitals (BP, HR, RR, Temp, O2)\n• General appearance\n• Head/Neck\n• Chest/Lungs\n• Abdomen\n• Extremities',
          }),
        });

        if (!section2Response.ok) {
          test2Message = `Failed to create section 2: ${section2Response.status}`;
        } else {
          const section2Data = await section2Response.json();
          if (section2Data?.id) {
            cachedSectionIds.push(section2Data.id);
            test2Passed = true;
            test2Message = `Created 2 sections with IDs: [${cachedSectionIds.join(', ')}]`;
          } else {
            test2Message = 'Section 2 response missing ID';
          }
        }
      } else {
        test2Message = 'Section 1 response missing ID';
      }
    }
  } catch (error) {
    test2Message = `Error creating sections: ${error.message}`;
  }

  runner.results.push({
    name: 'Test 2: Create note template sections (setup for dependent tests)',
    passed: test2Passed,
    endpoint: '/api/note-template-sections',
    method: 'POST',
    status: test2Passed ? 201 : null,
    expectedStatus: 201,
    customMessage: test2Message,
    testNumber: 2,
    timestamp: new Date().toISOString(),
  });

  const test2Result = test2Passed ? '✅' : '❌';
  console.log(`${test2Result} Test 2: Create note template sections (setup for dependent tests)`);
  console.log(`   ${test2Message}`);
  console.log(`   ⚠️  TEST DEPENDENCY: Tests 4-10 depend on Test 2. If Test 2 fails, those tests will be skipped.\n`);

  // Test 3: GET /api/note-templates/complete with auth (batch, no sections yet)
  await runner.test('Test 3: GET /api/note-templates/complete with authentication (batch, pagination)', {
    method: 'GET',
    endpoint: '/api/note-templates/complete?limit=20&offset=0',
    headers: authHeaders,
    expectedStatus: 200,
    expectedFields: ['templates', 'total'],
    testNumber: 3,
  });

  // ===== CREATE COMPLETE TEMPLATE (DEPENDS ON TEST 2) =====
  
  let test4Passed = false;
  let test4Message = '';
  if (!test2Passed || cachedSectionIds.length === 0) {
    test4Message = '⚠️  SKIPPED: Test 2 failed, cannot test POST /complete without sections';
  } else {
    const createResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'Complete Template - ' + Date.now(),
        noteTemplateSection_ids: cachedSectionIds,
      }),
    });

    if (createResponse.ok && createResponse.status === 201) {
      const createdData = await createResponse.json();
      if (createdData?.template?.id) {
        cachedCompleteTemplateId = createdData.template.id;
        test4Passed = true;
        test4Message = `Created complete template with ID: ${cachedCompleteTemplateId}, sections: ${createdData.sections?.length || 0}`;
      } else {
        test4Message = 'Response missing template.id field';
      }
    } else {
      test4Message = `Expected 201, got ${createResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 4: POST /api/note-templates/complete with sections (create with atomic ordering)',
    passed: test4Passed,
    endpoint: '/api/note-templates/complete',
    method: 'POST',
    status: test4Passed ? 201 : null,
    expectedStatus: 201,
    customMessage: test4Message,
    testNumber: 4,
    timestamp: new Date().toISOString(),
  });

  const test4Result = test4Passed ? '✅' : (test4Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test4Result} Test 4: POST /api/note-templates/complete with sections (atomic)`);
  console.log(`   ${test4Message}`);
  console.log(`   ⚠️  TEST DEPENDENCY: Tests 8-10 depend on Test 4. If Test 4 fails, those tests will be skipped.\n`);

  // Test 5: POST /api/note-templates/complete without auth - should fail
  await runner.test('Test 5: POST /api/note-templates/complete without authentication', {
    method: 'POST',
    endpoint: '/api/note-templates/complete',
    body: {
      name: 'Unauthorized Template',
      noteTemplateSection_ids: [1],
    },
    expectedStatus: 401,
    testNumber: 5,
  });

  // Test 6: POST /api/note-templates/complete with missing sections - validation error
  await runner.test('Test 6: POST /api/note-templates/complete with missing noteTemplateSection_ids', {
    method: 'POST',
    endpoint: '/api/note-templates/complete',
    headers: authHeaders,
    body: {
      name: 'Incomplete Template',
    },
    expectedStatus: 400,
    testNumber: 6,
    customValidator: (data) => {
      if (!data.error && !data.details) return { passed: false, message: 'Missing error or details field' };
      return { passed: true, message: '✓ Validation error for missing sections' };
    },
  });

  // Test 7: GET /api/note-templates/complete/:id with invalid ID
  await runner.test('Test 7: GET /api/note-templates/complete/:id with invalid ID', {
    method: 'GET',
    endpoint: '/api/note-templates/complete/99999999',
    headers: authHeaders,
    expectedStatus: 404,
    testNumber: 7,
  });

  // ===== GET SINGLE COMPLETE TEMPLATE (DEPENDS ON TEST 4) =====
  
  let test8Passed = false;
  let test8Message = '';
  if (!cachedCompleteTemplateId) {
    test8Message = '⚠️  SKIPPED: Test 4 failed, cannot test GET /complete/:id with real template';
  } else {
    const getResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'GET',
      headers: authHeaders,
    });

    if (getResponse.ok && getResponse.status === 200) {
      const data = await getResponse.json();
      if (data?.template?.id && Array.isArray(data?.sections)) {
        test8Passed = true;
        test8Message = `Retrieved template ${data.template.id} with ${data.sections.length} decrypted sections`;
      } else {
        test8Message = 'Response missing template.id or sections array';
      }
    } else {
      test8Message = `Expected 200, got ${getResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 8: GET /api/note-templates/complete/:id with real created template',
    passed: test8Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'GET',
    status: test8Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test8Message,
    testNumber: 8,
    timestamp: new Date().toISOString(),
  });

  const test8Result = test8Passed ? '✅' : (test8Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test8Result} Test 8: GET /api/note-templates/complete/:id with real created template`);
  console.log(`   ${test8Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 8 depends on Test 4 (creation). If Test 4 fails, this test is skipped.\n`);

  // ===== UPDATE COMPLETE TEMPLATE (DEPENDS ON TEST 4) =====
  
  let test9Passed = false;
  let test9Message = '';
  if (!cachedCompleteTemplateId) {
    test9Message = '⚠️  SKIPPED: Test 4 failed, cannot test PATCH /complete/:id with real template';
  } else {
    const patchResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'Updated Complete Template - ' + Date.now(),
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      const data = await patchResponse.json();
      if (data?.template?.id) {
        test9Passed = true;
        test9Message = 'Successfully updated template name (atomic)';
      } else {
        test9Message = 'Response missing template.id field';
      }
    } else {
      test9Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 9: PATCH /api/note-templates/complete/:id (update name)',
    passed: test9Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test9Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test9Message,
    testNumber: 9,
    timestamp: new Date().toISOString(),
  });

  const test9Result = test9Passed ? '✅' : (test9Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test9Result} Test 9: PATCH /api/note-templates/complete/:id (update name)`);
  console.log(`   ${test9Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 9 depends on Test 4 (creation). If Test 4 fails, this test is skipped.\n`);

  // Test 10: PATCH /api/note-templates/complete/:id with section reordering (DEPENDS ON TEST 4)
  let test10Passed = false;
  let test10Message = '';
  if (!cachedCompleteTemplateId || cachedSectionIds.length < 2) {
    test10Message = '⚠️  SKIPPED: Test 4 failed or not enough sections to test reordering';
  } else {
    // Reverse the order of sections
    const reversedIds = [...cachedSectionIds].reverse();
    const patchResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        noteTemplateSection_ids: reversedIds,
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      const data = await patchResponse.json();
      if (data?.sections?.length === cachedSectionIds.length) {
        test10Passed = true;
        test10Message = `Successfully reordered ${data.sections.length} sections (atomic)`;
      } else {
        test10Message = 'Response sections count mismatch';
      }
    } else {
      test10Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 10: PATCH /api/note-templates/complete/:id (reorder sections)',
    passed: test10Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test10Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test10Message,
    testNumber: 10,
    timestamp: new Date().toISOString(),
  });

  const test10Result = test10Passed ? '✅' : (test10Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test10Result} Test 10: PATCH /api/note-templates/complete/:id (reorder sections)`);
  console.log(`   ${test10Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 10 depends on Test 4 (creation). If Test 4 fails, this test is skipped.\n`);

  // ===== CLEANUP (not formal tests) =====
  console.log('Cleaning up test data...\n');

  // Delete created complete template
  if (cachedCompleteTemplateId && accessToken) {
    try {
      const deleteTemplateResponse = await fetch(`${runner.baseUrl}/api/note-templates/${cachedCompleteTemplateId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (deleteTemplateResponse.ok && deleteTemplateResponse.status === 204) {
        console.log(`✓ Deleted test template ${cachedCompleteTemplateId}`);
      } else {
        console.log(`⚠️  Failed to delete test template ${cachedCompleteTemplateId}: ${deleteTemplateResponse.status}`);
      }
    } catch (error) {
      console.log(`⚠️  Error deleting test template: ${error.message}`);
    }
  }

  // Delete created sections
  if (cachedSectionIds.length > 0 && accessToken) {
    for (const sectionId of cachedSectionIds) {
      try {
        const deleteSectionResponse = await fetch(`${runner.baseUrl}/api/note-template-sections/${sectionId}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        if (deleteSectionResponse.ok && deleteSectionResponse.status === 204) {
          console.log(`✓ Deleted test section ${sectionId}`);
        } else {
          console.log(`⚠️  Failed to delete test section ${sectionId}: ${deleteSectionResponse.status}`);
        }
      } catch (error) {
        console.log(`⚠️  Error deleting test section ${sectionId}: ${error.message}`);
      }
    }
  }

  console.log('');

  // Print results
  runner.printResults(10);
  // Save results to file
  const resultsFile = runner.saveResults('note-templates-complete-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Note Templates Complete API test suite completed\n');

  return runner.getSummary();
}

// Run tests
runNoteTemplatesCompleteTests();
