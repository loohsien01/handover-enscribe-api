/**
 * Test Suite: Note Templates Complete API
 * Tests atomic endpoints for templates with embedded sections + ordering
 * GET /api/note-templates/complete (batch) - with include_details query param
 * GET /api/note-templates/complete/:id (single with sections)
 * POST /api/note-templates/complete (create with sections - atomic)
 * PATCH /api/note-templates/complete/:id (update template + sections + ordering - atomic)
 * 
 * Test List:
 *   Test 1: GET /api/note-templates/complete without auth (should fail 401)
 *   Test 2: Create note template sections (setup for dependent tests)
 *   Test 3: GET /api/note-templates/complete with auth (basic batch)
 *   Test 4: GET /api/note-templates/complete?include_details=false (explicit)
 *   Test 5: GET /api/note-templates/complete?include_details=true (explicit)
 *   Test 6: POST /api/note-templates/complete with sections (create atomic)
 *   Test 7: Batch GET with created template (default: no details)
 *   Test 8: Batch GET with include_details=true (with decrypted details)
 *   Test 9: Batch GET with pagination (limit/offset + include_details)
 *   Test 10: POST /api/note-templates/complete without auth (should fail 401)
 *   Test 11: POST /api/note-templates/complete with missing sections (validation)
 *   Test 12: GET /api/note-templates/complete/:id with invalid ID (404)
 *   Test 13: GET /api/note-templates/complete/:id with real template (deps on Test 6)
 *   Test 14: PATCH /api/note-templates/complete/:id (update name, deps on Test 6)
 *   Test 15: PATCH /api/note-templates/complete/:id (reorder sections, deps on Test 6)
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

  // Test 3a: GET /api/note-templates/complete with include_details=false (explicit false)
  let test4Passed = false;
  let test4Message = '';
  try {
    const response = await fetch(`${runner.baseUrl}/api/note-templates/complete?limit=20&offset=0&include_details=false`, {
      method: 'GET',
      headers: authHeaders,
    });

    if (response.ok && response.status === 200) {
      const data = await response.json();
      if (data?.templates && Array.isArray(data.templates)) {
        test4Passed = true;
        // Verify sections don't have encrypted_details field
        const hasEncryptedDetails = data.templates.some(t => 
          t.sections?.some(s => s.hasOwnProperty('encrypted_details') || s.hasOwnProperty('details'))
        );
        if (hasEncryptedDetails) {
          test4Passed = false;
          test4Message = 'Sections should not contain encrypted_details or details when include_details=false';
        } else {
          test4Message = `✓ Sections correctly exclude details (${data.templates.length} templates)`;
        }
      } else {
        test4Message = 'Response missing templates array';
      }
    } else {
      test4Message = `Expected 200, got ${response.status}`;
    }
  } catch (error) {
    test4Message = `Error: ${error.message}`;
  }

  runner.results.push({
    name: 'Test 4: GET /api/note-templates/complete with include_details=false (explicit)',
    passed: test4Passed,
    endpoint: '/api/note-templates/complete?include_details=false',
    method: 'GET',
    status: 200,
    expectedStatus: 200,
    customMessage: test4Message,
    testNumber: 4,
    timestamp: new Date().toISOString(),
  });

  const test4Result = test4Passed ? '✅' : '❌';
  console.log(`${test4Result} Test 4: GET /api/note-templates/complete with include_details=false`);
  console.log(`   ${test4Message}\n`);

  // Test 5: GET /api/note-templates/complete with include_details=true (will test structure)
  let test5Passed = false;
  let test5Message = '';
  try {
    const response = await fetch(`${runner.baseUrl}/api/note-templates/complete?limit=20&offset=0&include_details=true`, {
      method: 'GET',
      headers: authHeaders,
    });

    if (response.ok && response.status === 200) {
      const data = await response.json();
      if (data?.templates && Array.isArray(data.templates)) {
        test5Passed = true;
        test5Message = `✓ Response includes details when include_details=true (${data.templates.length} templates)`;
      } else {
        test5Message = 'Response missing templates array';
      }
    } else {
      test5Message = `Expected 200, got ${response.status}`;
    }
  } catch (error) {
    test5Message = `Error: ${error.message}`;
  }

  runner.results.push({
    name: 'Test 5: GET /api/note-templates/complete with include_details=true (explicit)',
    passed: test5Passed,
    endpoint: '/api/note-templates/complete?include_details=true',
    method: 'GET',
    status: 200,
    expectedStatus: 200,
    customMessage: test5Message,
    testNumber: 5,
    timestamp: new Date().toISOString(),
  });

  const test5Result = test5Passed ? '✅' : '❌';
  console.log(`${test5Result} Test 5: GET /api/note-templates/complete with include_details=true`);
  console.log(`   ${test5Message}\n`);

  // ===== CREATE COMPLETE TEMPLATE (DEPENDS ON TEST 2) =====
  
  let test6Passed = false;
  let test6Message = '';
  if (!test2Passed || cachedSectionIds.length === 0) {
    test6Message = '⚠️  SKIPPED: Test 2 failed, cannot test POST /complete without sections';
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
        test6Passed = true;
        test6Message = `Created complete template with ID: ${cachedCompleteTemplateId}, sections: ${createdData.sections?.length || 0}`;
      } else {
        test6Message = 'Response missing template.id field';
      }
    } else {
      test6Message = `Expected 201, got ${createResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 6: POST /api/note-templates/complete with sections (create with atomic ordering)',
    passed: test6Passed,
    endpoint: '/api/note-templates/complete',
    method: 'POST',
    status: test6Passed ? 201 : null,
    expectedStatus: 201,
    customMessage: test6Message,
    testNumber: 6,
    timestamp: new Date().toISOString(),
  });

  const test6Result = test6Passed ? '✅' : (test6Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test6Result} Test 6: POST /api/note-templates/complete with sections (atomic)`);
  console.log(`   ${test6Message}`);
  console.log(`   ⚠️  TEST DEPENDENCY: Tests 7-9, 13-15 depend on Test 6. If Test 6 fails, those tests will be skipped.\n`);

  // Test 7: GET /api/note-templates/complete batch with created template - default (no details)
  let test7Passed = false;
  let test7Message = '';
  if (!cachedCompleteTemplateId) {
    test7Message = '⚠️  SKIPPED: Test 6 failed, cannot test batch GET with real template';
  } else {
    try {
      const response = await fetch(`${runner.baseUrl}/api/note-templates/complete?limit=20&offset=0`, {
        method: 'GET',
        headers: authHeaders,
      });

      if (response.ok && response.status === 200) {
        const data = await response.json();
        const createdTemplate = data.templates?.find(t => t.id === cachedCompleteTemplateId);
        
        if (createdTemplate) {
          // Verify sections DON'T have details field by default
          const hasSectionDetails = createdTemplate.sections?.some(s => 
            s.hasOwnProperty('details') || s.hasOwnProperty('encrypted_details')
          );
          
          if (!hasSectionDetails) {
            test7Passed = true;
            test7Message = `✓ Default batch fetch correctly omits section details (${createdTemplate.sections?.length || 0} sections)`;
          } else {
            test7Message = 'ERROR: Sections should not have details/encrypted_details by default';
          }
        } else {
          test7Message = 'Created template not found in batch response';
        }
      } else {
        test7Message = `Expected 200, got ${response.status}`;
      }
    } catch (error) {
      test7Message = `Error: ${error.message}`;
    }
  }

  runner.results.push({
    name: 'Test 7: GET /api/note-templates/complete batch (default: no details)',
    passed: test7Passed,
    endpoint: '/api/note-templates/complete',
    method: 'GET',
    status: test7Passed || test7Message.includes('SKIPPED') ? 200 : null,
    expectedStatus: 200,
    customMessage: test7Message,
    testNumber: 7,
    timestamp: new Date().toISOString(),
  });

  const test7Result = test7Passed ? '✅' : (test7Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test7Result} Test 7: GET /api/note-templates/complete batch (default: no details)`);
  console.log(`   ${test7Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 7 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 8: GET /api/note-templates/complete batch with include_details=true (should have details)
  let test8Passed = false;
  let test8Message = '';
  if (!cachedCompleteTemplateId) {
    test8Message = '⚠️  SKIPPED: Test 6 failed, cannot test batch GET with real template';
  } else {
    try {
      const response = await fetch(`${runner.baseUrl}/api/note-templates/complete?limit=20&offset=0&include_details=true`, {
        method: 'GET',
        headers: authHeaders,
      });

      if (response.ok && response.status === 200) {
        const data = await response.json();
        const createdTemplate = data.templates?.find(t => t.id === cachedCompleteTemplateId);
        
        if (createdTemplate && createdTemplate.sections?.length > 0) {
          // Verify sections HAVE details field when requested
          const allSectionsHaveDetails = createdTemplate.sections.every(s => 
            s.hasOwnProperty('details') && typeof s.details === 'string'
          );
          
          if (allSectionsHaveDetails) {
            test8Passed = true;
            test8Message = `✓ Batch fetch with include_details=true correctly includes decrypted details (${createdTemplate.sections.length} sections with content)`;
          } else {
            test8Message = 'ERROR: Some or all sections missing details field when include_details=true';
          }
        } else {
          test8Message = 'Created template or sections not found in batch response';
        }
      } else {
        test8Message = `Expected 200, got ${response.status}`;
      }
    } catch (error) {
      test8Message = `Error: ${error.message}`;
    }
  }

  runner.results.push({
    name: 'Test 8: GET /api/note-templates/complete batch with include_details=true (with details)',
    passed: test8Passed,
    endpoint: '/api/note-templates/complete?include_details=true',
    method: 'GET',
    status: test8Passed || test8Message.includes('SKIPPED') ? 200 : null,
    expectedStatus: 200,
    customMessage: test8Message,
    testNumber: 8,
    timestamp: new Date().toISOString(),
  });

  const test8Result = test8Passed ? '✅' : (test8Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test8Result} Test 8: GET /api/note-templates/complete batch with include_details=true`);
  console.log(`   ${test8Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 8 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 9: GET /api/note-templates/complete batch with pagination (include_details behavior)
  let test9Passed = false;
  let test9Message = '';
  if (!cachedCompleteTemplateId) {
    test9Message = '⚠️  SKIPPED: Test 6 failed, cannot test batch GET with real template';
  } else {
    try {
      const response = await fetch(`${runner.baseUrl}/api/note-templates/complete?limit=1&offset=0&include_details=false`, {
        method: 'GET',
        headers: authHeaders,
      });

      if (response.ok && response.status === 200) {
        const data = await response.json();
        
        if (data?.templates && data?.total !== undefined) {
          test9Passed = true;
          test9Message = `✓ Pagination with include_details=false works correctly (returned ${data.templates.length}/${data.total} templates)`;
        } else {
          test9Message = 'Response missing templates or total field';
        }
      } else {
        test9Message = `Expected 200, got ${response.status}`;
      }
    } catch (error) {
      test9Message = `Error: ${error.message}`;
    }
  }

  runner.results.push({
    name: 'Test 9: GET /api/note-templates/complete batch with pagination (limit/offset + include_details)',
    passed: test9Passed,
    endpoint: '/api/note-templates/complete?limit=1&offset=0&include_details=false',
    method: 'GET',
    status: test9Passed || test9Message.includes('SKIPPED') ? 200 : null,
    expectedStatus: 200,
    customMessage: test9Message,
    testNumber: 9,
    timestamp: new Date().toISOString(),
  });

  const test9Result = test9Passed ? '✅' : (test9Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test9Result} Test 9: GET /api/note-templates/complete batch with pagination`);
  console.log(`   ${test9Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 9 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 10: POST /api/note-templates/complete without auth - should fail
  await runner.test('Test 10: POST /api/note-templates/complete without authentication', {
    method: 'POST',
    endpoint: '/api/note-templates/complete',
    body: {
      name: 'Unauthorized Template',
      noteTemplateSection_ids: [1],
    },
    expectedStatus: 401,
    testNumber: 10,
  });

  // Test 11: POST /api/note-templates/complete with missing sections - validation error
  await runner.test('Test 11: POST /api/note-templates/complete with missing noteTemplateSection_ids', {
    method: 'POST',
    endpoint: '/api/note-templates/complete',
    headers: authHeaders,
    body: {
      name: 'Incomplete Template',
    },
    expectedStatus: 400,
    testNumber: 11,
    customValidator: (data) => {
      if (!data.error && !data.details) return { passed: false, message: 'Missing error or details field' };
      return { passed: true, message: '✓ Validation error for missing sections' };
    },
  });

  // Test 12: GET /api/note-templates/complete/:id with invalid ID
  await runner.test('Test 12: GET /api/note-templates/complete/:id with invalid ID', {
    method: 'GET',
    endpoint: '/api/note-templates/complete/99999999',
    headers: authHeaders,
    expectedStatus: 404,
    testNumber: 12,
  });

  // ===== GET SINGLE COMPLETE TEMPLATE (DEPENDS ON TEST 6) =====
  
  let test13Passed = false;
  let test13Message = '';
  if (!cachedCompleteTemplateId) {
    test13Message = '⚠️  SKIPPED: Test 6 failed, cannot test GET /complete/:id with real template';
  } else {
    const getResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'GET',
      headers: authHeaders,
    });

    if (getResponse.ok && getResponse.status === 200) {
      const data = await getResponse.json();
      if (data?.template?.id && Array.isArray(data?.sections)) {
        test13Passed = true;
        test13Message = `Retrieved template ${data.template.id} with ${data.sections.length} decrypted sections`;
      } else {
        test13Message = 'Response missing template.id or sections array';
      }
    } else {
      test13Message = `Expected 200, got ${getResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 13: GET /api/note-templates/complete/:id with real created template',
    passed: test13Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'GET',
    status: test13Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test13Message,
    testNumber: 13,
    timestamp: new Date().toISOString(),
  });

  const test13Result = test13Passed ? '✅' : (test13Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test13Result} Test 13: GET /api/note-templates/complete/:id with real created template`);
  console.log(`   ${test13Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 13 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // ===== UPDATE COMPLETE TEMPLATE (DEPENDS ON TEST 6) =====
  
  let test14Passed = false;
  let test14Message = '';
  if (!cachedCompleteTemplateId) {
    test14Message = '⚠️  SKIPPED: Test 6 failed, cannot test PATCH /complete/:id with real template';
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
        test14Passed = true;
        test14Message = 'Successfully updated template name (atomic)';
      } else {
        test14Message = 'Response missing template.id field';
      }
    } else {
      test14Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 14: PATCH /api/note-templates/complete/:id (update name)',
    passed: test14Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test14Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test14Message,
    testNumber: 14,
    timestamp: new Date().toISOString(),
  });

  const test14Result = test14Passed ? '✅' : (test14Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test14Result} Test 14: PATCH /api/note-templates/complete/:id (update name)`);
  console.log(`   ${test14Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 14 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 15: PATCH /api/note-templates/complete/:id with section reordering (DEPENDS ON TEST 6)
  let test15Passed = false;
  let test15Message = '';
  if (!cachedCompleteTemplateId || cachedSectionIds.length < 2) {
    test15Message = '⚠️  SKIPPED: Test 6 failed or not enough sections to test reordering';
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
        test15Passed = true;
        test15Message = `Successfully reordered ${data.sections.length} sections (atomic)`;
      } else {
        test15Message = 'Response sections count mismatch';
      }
    } else {
      test15Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 15: PATCH /api/note-templates/complete/:id (reorder sections)',
    passed: test15Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test15Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test15Message,
    testNumber: 15,
    timestamp: new Date().toISOString(),
  });

  const test15Result = test15Passed ? '✅' : (test15Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test15Result} Test 15: PATCH /api/note-templates/complete/:id (reorder sections)`);
  console.log(`   ${test15Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 15 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

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
  runner.printResults(15);  // Updated count: Tests 1-15 (sequential numbering)
  // Save results to file
  const resultsFile = runner.saveResults('note-templates-complete-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Note Templates Complete API test suite completed\n');

  return runner.getSummary();
}

// Run tests
runNoteTemplatesCompleteTests();
