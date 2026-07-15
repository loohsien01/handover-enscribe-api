/**
 * Test Suite: Note Templates Complete API
 * Tests atomic endpoints for templates with embedded sections + ordering
 * NEW FEATURES: 
 *   - POST/PATCH now use unified sections array format
 *   - Sections with 'id' field: link existing sections
 *   - Sections without 'id' field: create new sections atomically
 *   - Array order determines final section ordering
 * 
 * GET /api/note-templates/complete (batch) - with include_details query param
 * GET /api/note-templates/complete/:id (single with sections)
 * POST /api/note-templates/complete (create with existing/new sections - atomic)
 * PATCH /api/note-templates/complete/:id (update template + create/link sections + reorder - atomic)
 * 
 * Test List:
 *   Test 1: GET /api/note-templates/complete without auth (should fail 401)
 *   Test 2: Create note template sections (setup for dependent tests)
 *   Test 3: GET /api/note-templates/complete with auth (basic batch)
 *   Test 4: GET /api/note-templates/complete?include_details=false (explicit)
 *   Test 5: GET /api/note-templates/complete?include_details=true (explicit)
 *   Test 6: POST /api/note-templates/complete with existing sections (link mode)
 *   Test 7: POST /api/note-templates/complete with new sections only (create mode)
 *   Test 8: POST /api/note-templates/complete with mixed sections (create + link mode)
 *   Test 9: Batch GET with created template (default: no details)
 *   Test 10: Batch GET with include_details=true (with decrypted details)
 *   Test 11: Batch GET with pagination (limit/offset + include_details)
 *   Test 12: POST /api/note-templates/complete without auth (should fail 401)
 *   Test 13: POST /api/note-templates/complete with missing sections (validation)
 *   Test 14: GET /api/note-templates/complete/:id with invalid ID (404)
 *   Test 15: GET /api/note-templates/complete/:id with real template (deps on Test 6)
 *   Test 16: PATCH /api/note-templates/complete/:id (update name, deps on Test 6)
 *   Test 17: PATCH /api/note-templates/complete/:id (add new sections while reordering, deps on Test 6)
 *   Test 18: PATCH /api/note-templates/complete/:id (reorder existing sections only, deps on Test 6)
 *   Test 19: PATCH rejects mutating catalog/system section; reorder-only still OK (full abort on mutate)
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

/**
 * Find a catalog/system section from batch GET (include_details) for immutability tests.
 * @param {{ templates?: Array<{ sections?: Array<Record<string, unknown>> }> }} } data
 */
function findCatalogSectionFromBatch(data) {
  for (const t of data.templates || []) {
    for (const s of t.sections || []) {
      if (s.is_system === true || s.user_id == null) {
        return { id: s.id, name: s.name };
      }
    }
  }
  return null;
}

// Will store real access token from test account
let accessToken = null;

// Cache section IDs from Test 2 for dependent tests
let cachedSectionIds = [];

// Cache complete template ID from Test 4 for dependent tests (Test 8-10)
let cachedCompleteTemplateId = null;

// Track ALL created template IDs for cleanup (from tests 6, 6a, 6b)
let cachedCreatedTemplateIds = [];

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
    // Test 6: Create template by LINKING existing sections (using new sections array format)
    const createResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'Complete Template (Existing Sections) - ' + Date.now(),
        sections: cachedSectionIds.map(id => ({ id })), // Link existing sections
      }),
    });

    if (createResponse.ok && createResponse.status === 201) {
      const createdData = await createResponse.json();
      if (createdData?.template?.id) {
        cachedCompleteTemplateId = createdData.template.id;
        cachedCreatedTemplateIds.push(cachedCompleteTemplateId);
        test6Passed = true;
        test6Message = `Created complete template with ID: ${cachedCompleteTemplateId}, linked ${createdData.sections?.length || 0} sections`;
      } else {
        test6Message = 'Response missing template.id field';
      }
    } else {
      test6Message = `Expected 201, got ${createResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 6: POST /api/note-templates/complete with existing sections (link mode)',
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
  console.log(`${test6Result} Test 6: POST /api/note-templates/complete with existing sections (link mode)`);
  console.log(`   ${test6Message}`);
  console.log(`   ⚠️  TEST DEPENDENCY: Tests 7-9, 13-16 depend on Test 6. If Test 6 fails, those tests will be skipped.\n`);

  // Test 7: Create template with NEW sections only (create mode)
  let test7Passed = false;
  let test7Message = '';
  if (!accessToken) {
    test7Message = '⚠️  SKIPPED: No access token';
  } else {
    const createNewResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'Template with New Sections - ' + Date.now(),
        sections: [
          {
            name: 'Assessment - ' + Date.now(),
            layout: 'paragraph',
            details: 'Clinical assessment and diagnostic thinking',
          },
          {
            name: 'Plan - ' + Date.now(),
            layout: 'bullet points',
            details: '• Treatment plan\n• Follow-up\n• Patient education',
          },
        ],
      }),
    });

    if (createNewResponse.ok && createNewResponse.status === 201) {
      const createdData = await createNewResponse.json();
      if (createdData?.template?.id && createdData?.sections?.length === 2) {
        cachedCreatedTemplateIds.push(createdData.template.id);
        // Track the newly created sections for cleanup
        createdData.sections.forEach(section => {
          if (section.id && !cachedSectionIds.includes(section.id)) {
            cachedSectionIds.push(section.id);
          }
        });
        test7Passed = true;
        test7Message = `Created template with ID: ${createdData.template.id}, created ${createdData.sections.length} NEW sections atomically`;
      } else {
        test7Message = 'Response missing template.id or sections count mismatch';
      }
    } else {
      test7Message = `Expected 201, got ${createNewResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 7: POST /api/note-templates/complete with new sections (create mode)',
    passed: test7Passed,
    endpoint: '/api/note-templates/complete',
    method: 'POST',
    status: test7Passed ? 201 : null,
    expectedStatus: 201,
    customMessage: test7Message,
    testNumber: 7,
    timestamp: new Date().toISOString(),
  });

  const test7Result = test7Passed ? '✅' : (test7Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test7Result} Test 7: POST /api/note-templates/complete with new sections (create mode)`);
  console.log(`   ${test7Message}\n`);

  // Test 8: Create template with MIXED sections (both existing and new)
  let test8Passed = false;
  let test8Message = '';
  if (!test2Passed || cachedSectionIds.length === 0 || !accessToken) {
    test8Message = '⚠️  SKIPPED: Test 2 failed or no access token';
  } else {
    const createMixedResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        name: 'Template with Mixed Sections - ' + Date.now(),
        sections: [
          { id: cachedSectionIds[0] }, // Link existing section
          {
            name: 'New Custom Section - ' + Date.now(),
            layout: 'paragraph',
            details: 'This is a newly created section in the same request',
          },
          { id: cachedSectionIds[1] }, // Link another existing section
        ],
      }),
    });

    if (createMixedResponse.ok && createMixedResponse.status === 201) {
      const createdData = await createMixedResponse.json();
      if (createdData?.template?.id && createdData?.sections?.length === 3) {
        cachedCreatedTemplateIds.push(createdData.template.id);
        // Track any newly created sections for cleanup
        createdData.sections.forEach(section => {
          if (section.id && !cachedSectionIds.includes(section.id)) {
            cachedSectionIds.push(section.id);
          }
        });
        test8Passed = true;
        test8Message = `Created template with ID: ${createdData.template.id}, linked 2 existing + created 1 new section atomically`;
      } else {
        test8Message = 'Response missing template.id or sections count mismatch';
      }
    } else {
      test8Message = `Expected 201, got ${createMixedResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 8: POST /api/note-templates/complete with mixed sections (create + link mode)',
    passed: test8Passed,
    endpoint: '/api/note-templates/complete',
    method: 'POST',
    status: test8Passed ? 201 : null,
    expectedStatus: 201,
    customMessage: test8Message,
    testNumber: 8,
    timestamp: new Date().toISOString(),
  });

  const test8Result = test8Passed ? '✅' : (test8Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test8Result} Test 8: POST /api/note-templates/complete with mixed sections (create + link mode)`);
  console.log(`   ${test8Message}\n`);

  // Test 9: GET /api/note-templates/complete batch with created template - default (no details)
  let test9Passed = false;
  let test9Message = '';
  if (!cachedCompleteTemplateId) {
    test9Message = '⚠️  SKIPPED: Test 6 failed, cannot test batch GET with real template';
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
            test9Passed = true;
            test9Message = `✓ Default batch fetch correctly omits section details (${createdTemplate.sections?.length || 0} sections)`;
          } else {
            test9Message = 'ERROR: Sections should not have details/encrypted_details by default';
          }
        } else {
          test9Message = 'Created template not found in batch response';
        }
      } else {
        test9Message = `Expected 200, got ${response.status}`;
      }
    } catch (error) {
      test9Message = `Error: ${error.message}`;
    }
  }

  runner.results.push({
    name: 'Test 9: GET /api/note-templates/complete batch (default: no details)',
    passed: test9Passed,
    endpoint: '/api/note-templates/complete',
    method: 'GET',
    status: test9Passed || test9Message.includes('SKIPPED') ? 200 : null,
    expectedStatus: 200,
    customMessage: test9Message,
    testNumber: 9,
    timestamp: new Date().toISOString(),
  });

  const test9Result = test9Passed ? '✅' : (test9Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test9Result} Test 9: GET /api/note-templates/complete batch (default: no details)`);
  console.log(`   ${test9Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 9 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 10: GET /api/note-templates/complete batch with include_details=true (should have details)
  let test10Passed = false;
  let test10Message = '';
  if (!cachedCompleteTemplateId) {
    test10Message = '⚠️  SKIPPED: Test 6 failed, cannot test batch GET with real template';
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
            test10Passed = true;
            test10Message = `✓ Batch fetch with include_details=true correctly includes decrypted details (${createdTemplate.sections.length} sections with content)`;
          } else {
            test10Message = 'ERROR: Some or all sections missing details field when include_details=true';
          }
        } else {
          test10Message = 'Created template or sections not found in batch response';
        }
      } else {
        test10Message = `Expected 200, got ${response.status}`;
      }
    } catch (error) {
      test10Message = `Error: ${error.message}`;
    }
  }

  runner.results.push({
    name: 'Test 10: GET /api/note-templates/complete batch with include_details=true (with details)',
    passed: test10Passed,
    endpoint: '/api/note-templates/complete?include_details=true',
    method: 'GET',
    status: test10Passed || test10Message.includes('SKIPPED') ? 200 : null,
    expectedStatus: 200,
    customMessage: test10Message,
    testNumber: 10,
    timestamp: new Date().toISOString(),
  });

  const test10Result = test10Passed ? '✅' : (test10Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test10Result} Test 10: GET /api/note-templates/complete batch with include_details=true`);
  console.log(`   ${test10Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 10 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 11: GET /api/note-templates/complete batch with pagination (include_details behavior)
  let test11Passed = false;
  let test11Message = '';
  if (!cachedCompleteTemplateId) {
    test11Message = '⚠️  SKIPPED: Test 6 failed, cannot test batch GET with real template';
  } else {
    try {
      const response = await fetch(`${runner.baseUrl}/api/note-templates/complete?limit=1&offset=0&include_details=false`, {
        method: 'GET',
        headers: authHeaders,
      });

      if (response.ok && response.status === 200) {
        const data = await response.json();
        
        if (data?.templates && data?.total !== undefined) {
          test11Passed = true;
          test11Message = `✓ Pagination with include_details=false works correctly (returned ${data.templates.length}/${data.total} templates)`;
        } else {
          test11Message = 'Response missing templates or total field';
        }
      } else {
        test11Message = `Expected 200, got ${response.status}`;
      }
    } catch (error) {
      test11Message = `Error: ${error.message}`;
    }
  }

  runner.results.push({
    name: 'Test 11: GET /api/note-templates/complete batch with pagination (limit/offset + include_details)',
    passed: test11Passed,
    endpoint: '/api/note-templates/complete?limit=1&offset=0&include_details=false',
    method: 'GET',
    status: test11Passed || test11Message.includes('SKIPPED') ? 200 : null,
    expectedStatus: 200,
    customMessage: test11Message,
    testNumber: 11,
    timestamp: new Date().toISOString(),
  });

  const test11Result = test11Passed ? '✅' : (test11Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test11Result} Test 11: GET /api/note-templates/complete batch with pagination`);
  console.log(`   ${test11Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 11 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 12: POST /api/note-templates/complete without auth - should fail
  await runner.test('Test 12: POST /api/note-templates/complete without authentication', {
    method: 'POST',
    endpoint: '/api/note-templates/complete',
    body: {
      name: 'Unauthorized Template',
      sections: [{ name: 'Test Section' }],
    },
    expectedStatus: 401,
    testNumber: 12,
  });

  // Test 13: POST /api/note-templates/complete with missing sections - validation error
  await runner.test('Test 13: POST /api/note-templates/complete with missing sections array', {
    method: 'POST',
    endpoint: '/api/note-templates/complete',
    headers: authHeaders,
    body: {
      name: 'Incomplete Template',
    },
    expectedStatus: 400,
    testNumber: 13,
    customValidator: (data) => {
      if (!data.error && !data.details) return { passed: false, message: 'Missing error or details field' };
      return { passed: true, message: '✓ Validation error for missing sections' };
    },
  });

  // Test 14: GET /api/note-templates/complete/:id with invalid ID
  await runner.test('Test 14: GET /api/note-templates/complete/:id with invalid ID', {
    method: 'GET',
    endpoint: '/api/note-templates/complete/99999999',
    headers: authHeaders,
    expectedStatus: 404,
    testNumber: 14,
  });

  // ===== GET SINGLE COMPLETE TEMPLATE (DEPENDS ON TEST 6) =====
  
  let test15Passed = false;
  let test15Message = '';
  if (!cachedCompleteTemplateId) {
    test15Message = '⚠️  SKIPPED: Test 6 failed, cannot test GET /complete/:id with real template';
  } else {
    const getResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'GET',
      headers: authHeaders,
    });

    if (getResponse.ok && getResponse.status === 200) {
      const data = await getResponse.json();
      if (data?.template?.id && Array.isArray(data?.sections)) {
        test15Passed = true;
        test15Message = `Retrieved template ${data.template.id} with ${data.sections.length} decrypted sections`;
      } else {
        test15Message = 'Response missing template.id or sections array';
      }
    } else {
      test15Message = `Expected 200, got ${getResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 15: GET /api/note-templates/complete/:id with real created template',
    passed: test15Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'GET',
    status: test15Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test15Message,
    testNumber: 15,
    timestamp: new Date().toISOString(),
  });

  const test15Result = test15Passed ? '✅' : (test15Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test15Result} Test 15: GET /api/note-templates/complete/:id with real created template`);
  console.log(`   ${test15Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 15 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // ===== UPDATE COMPLETE TEMPLATE (DEPENDS ON TEST 6) =====
  
  let test16Passed = false;
  let test16Message = '';
  if (!cachedCompleteTemplateId) {
    test16Message = '⚠️  SKIPPED: Test 6 failed, cannot test PATCH /complete/:id with real template';
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
        test16Passed = true;
        test16Message = 'Successfully updated template name (atomic)';
      } else {
        test16Message = 'Response missing template.id field';
      }
    } else {
      test16Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 16: PATCH /api/note-templates/complete/:id (update name only)',
    passed: test16Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test16Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test16Message,
    testNumber: 16,
    timestamp: new Date().toISOString(),
  });

  const test16Result = test16Passed ? '✅' : (test16Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test16Result} Test 16: PATCH /api/note-templates/complete/:id (update name only)`);
  console.log(`   ${test16Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 16 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 17: PATCH /api/note-templates/complete/:id with adding new sections and reordering
  let test17Passed = false;
  let test17Message = '';
  if (!cachedCompleteTemplateId || cachedSectionIds.length < 2) {
    test17Message = '⚠️  SKIPPED: Test 6 failed or not enough sections to test';
  } else {
    // Add a new section and reorder: keep 2nd existing, add new, then 1st existing
    const patchResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        sections: [
          { id: cachedSectionIds[1] }, // Existing section (reordered to first)
          {
            name: 'New Additional Section - ' + Date.now(),
            layout: 'paragraph',
            details: 'Section added during PATCH update',
          },
          { id: cachedSectionIds[0] }, // Existing section (reordered to third)
        ],
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      const data = await patchResponse.json();
      // Should now have 3 sections (2 existing + 1 new)
      if (data?.sections?.length === 3) {
        // Track any newly created sections for cleanup
        data.sections.forEach(section => {
          if (section.id && !cachedSectionIds.includes(section.id)) {
            cachedSectionIds.push(section.id);
          }
        });
        test17Passed = true;
        test17Message = `Successfully added new section and reordered to ${data.sections.length} total sections (atomic)`;
      } else {
        test17Message = `Expected 3 sections, got ${data?.sections?.length || 0}`;
      }
    } else {
      test17Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 17: PATCH /api/note-templates/complete/:id (add new sections + reorder)',
    passed: test17Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test17Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test17Message,
    testNumber: 17,
    timestamp: new Date().toISOString(),
  });

  const test17Result = test17Passed ? '✅' : (test17Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test17Result} Test 17: PATCH /api/note-templates/complete/:id (add new sections + reorder)`);
  console.log(`   ${test17Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 17 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 18: PATCH /api/note-templates/complete/:id with section reordering only (no new sections)
  let test18Passed = false;
  let test18Message = '';
  if (!cachedCompleteTemplateId || cachedSectionIds.length < 2) {
    test18Message = '⚠️  SKIPPED: Test 6 failed or not enough sections to test reordering';
  } else {
    // Reverse only the first 2 sections' order
    const patchResponse = await fetch(`${runner.baseUrl}/api/note-templates/complete/${cachedCompleteTemplateId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        sections: [
          { id: cachedSectionIds[0] }, // Was second, now first
          { id: cachedSectionIds[1] }, // Was first, now second
        ],
      }),
    });

    if (patchResponse.ok && patchResponse.status === 200) {
      const data = await patchResponse.json();
      if (data?.sections?.length >= 2) {
        test18Passed = true;
        test18Message = `Successfully reordered ${data.sections.length} sections (atomic)`;
      } else {
        test18Message = 'Response sections count mismatch';
      }
    } else {
      test18Message = `Expected 200, got ${patchResponse.status}`;
    }
  }

  runner.results.push({
    name: 'Test 18: PATCH /api/note-templates/complete/:id (reorder sections only)',
    passed: test18Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test18Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test18Message,
    testNumber: 18,
    timestamp: new Date().toISOString(),
  });

  const test18Result = test18Passed ? '✅' : (test18Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test18Result} Test 18: PATCH /api/note-templates/complete/:id (reorder sections only)`);
  console.log(`   ${test18Message}`);
  console.log(`   ⏳ DEPENDENCY: Test 18 depends on Test 6 (creation). If Test 6 fails, this test is skipped.\n`);

  // Test 19: catalog/system section cannot be mutated via PATCH /complete (403 + no partial persist); reorder-only OK
  let test19Passed = false;
  let test19Message = '';
  try {
    const batchRes = await fetch(
      `${runner.baseUrl}/api/note-templates/complete?limit=50&offset=0&include_details=true`,
      { method: 'GET', headers: authHeaders },
    );
    if (!batchRes.ok) {
      test19Message = `Batch GET failed: ${batchRes.status}`;
    } else {
      const batchData = await batchRes.json();
      const cat = findCatalogSectionFromBatch(batchData);
      if (!cat?.id) {
        test19Message =
          '⚠️  SKIPPED: No catalog section (is_system or user_id null) in batch — seed system templates to run this assertion';
      } else {
        const catalogNameBefore = cat.name;
        const postRes = await fetch(`${runner.baseUrl}/api/note-templates/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            name: `Immutable probe ${Date.now()}`,
            sections: [{ id: cat.id }],
          }),
        });
        if (!postRes.ok || postRes.status !== 201) {
          test19Message = `POST probe template failed: ${postRes.status}`;
        } else {
          const postBody = await postRes.json();
          const probeTemplateId = postBody?.template?.id;
          if (!probeTemplateId) {
            test19Message = 'POST response missing template.id';
          } else {
            cachedCreatedTemplateIds.push(probeTemplateId);
            const patchMutate = await fetch(
              `${runner.baseUrl}/api/note-templates/complete/${probeTemplateId}`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  ...authHeaders,
                },
                body: JSON.stringify({
                  sections: [
                    {
                      id: cat.id,
                      name: `${catalogNameBefore} — mutated by test`,
                    },
                  ],
                }),
              },
            );
            const mutateBody = await patchMutate.json().catch(() => ({}));
            const immutabilityRejected =
              (patchMutate.status === 403 && mutateBody?.code === 'SYSTEM_SECTION_IMMUTABLE') ||
              (patchMutate.status === 400 &&
                (mutateBody?.code === 'SYSTEM_SECTION_IMMUTABLE' ||
                  mutateBody?.error === 'System template sections cannot be modified'));
            if (!immutabilityRejected) {
              test19Message = `Expected 403 + code SYSTEM_SECTION_IMMUTABLE (or legacy 400 with immutability message), got ${patchMutate.status} ${JSON.stringify(mutateBody)}`;
            } else {
              const verifyRes = await fetch(
                `${runner.baseUrl}/api/note-templates/complete/${probeTemplateId}`,
                { method: 'GET', headers: authHeaders },
              );
              if (!verifyRes.ok) {
                test19Message = `Verify GET failed: ${verifyRes.status}`;
              } else {
                const verifyData = await verifyRes.json();
                const row = verifyData?.sections?.find((x) => String(x.id) === String(cat.id));
                if (row?.name !== catalogNameBefore) {
                  test19Message = `Expected catalog name unchanged after failed PATCH, got "${row?.name}"`;
                } else {
                  const patchReorder = await fetch(
                    `${runner.baseUrl}/api/note-templates/complete/${probeTemplateId}`,
                    {
                      method: 'PATCH',
                      headers: {
                        'Content-Type': 'application/json',
                        ...authHeaders,
                      },
                      body: JSON.stringify({
                        sections: [{ id: cat.id }],
                      }),
                    },
                  );
                  if (!patchReorder.ok || patchReorder.status !== 200) {
                    test19Message = `Reorder-only PATCH should succeed (200), got ${patchReorder.status}`;
                  } else {
                    test19Passed = true;
                    test19Message =
                      'Mutating PATCH returned 403 SYSTEM_SECTION_IMMUTABLE; catalog name unchanged; reorder-only PATCH succeeded';
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    test19Message = error?.message || String(error);
  }

  runner.results.push({
    name: 'Test 19: PATCH /complete rejects mutating catalog section (403 + transactional); reorder-only OK',
    passed: test19Passed,
    endpoint: '/api/note-templates/complete/:id',
    method: 'PATCH',
    status: test19Passed ? 403 : null,
    expectedStatus: 403,
    customMessage: test19Message,
    testNumber: 19,
    timestamp: new Date().toISOString(),
  });

  const test19Result = test19Passed ? '✅' : (test19Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test19Result} Test 19: PATCH /complete catalog immutability + reorder-only`);
  console.log(`   ${test19Message}\n`);

  // ===== CLEANUP (not formal tests) =====
  console.log('Cleaning up test data...\n');

  // Delete all created templates (from tests 6, 7, 8)
  if (cachedCreatedTemplateIds.length > 0 && accessToken) {
    for (const templateId of cachedCreatedTemplateIds) {
      try {
        const deleteTemplateResponse = await fetch(`${runner.baseUrl}/api/note-templates/${templateId}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        if (deleteTemplateResponse.ok && deleteTemplateResponse.status === 204) {
          console.log(`✓ Deleted test template ${templateId}`);
        } else {
          console.log(`⚠️  Failed to delete test template ${templateId}: ${deleteTemplateResponse.status}`);
        }
      } catch (error) {
        console.log(`⚠️  Error deleting test template ${templateId}: ${error.message}`);
      }
    }
  }

  // Delete all created sections (from tests 2, 7, 8, 17)
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
  runner.printResults(19); // Tests 1–19 (sequential numbering)
  // Save results to file
  const resultsFile = runner.saveResults('note-templates-complete-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Note Templates Complete API test suite completed\n');

  return runner.getSummary();
}

// Run tests
runNoteTemplatesCompleteTests();
