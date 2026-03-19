/**
 * Test Suite: Note Template Sections API
 * Tests all note template section endpoints: CRUD operations with encryption/decryption
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
import { getTestAccount, hasTestAccounts } from './testConfig.js';

const runner = new TestRunner('Note Template Sections API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Cache section ID from Test 10 for dependent tests (Tests 12-15, 19-20)
let cachedSectionId = null;

// Test data - Use timestamps to ensure unique names
const mockSectionData = {
  name: 'Test Section 1',
  layout: 'paragraph',
  details: 'This is a test section with sample details that will be encrypted',
};


/**
 * Run all note template sections tests
 */
async function runNoteTemplateSectionsTests() {
  console.log('Starting Note Template Sections API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  let realAccessToken = null;

  // Get real token early if test account is configured
  if (hasTestAccounts()) {
    const testAccount = getTestAccount('primary');
    if (testAccount && testAccount.email && testAccount.password) {
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
        const signInResponse = await response.json();
        if (signInResponse?.token?.access_token) {
          realAccessToken = signInResponse.token.access_token;
          console.log('✅ Obtained real access token for validation tests\n');
        }
      } catch (error) {
        console.log('⚠️  Could not get real token, using mock tests only\n');
      }
    }
  }

  // ===== AUTHENTICATION TESTS =====

  // Test 1: Get all sections without auth (should fail)
  await runner.test('Test 1: GET /api/note-template-sections without authentication', {
    method: 'GET',
    endpoint: '/api/note-template-sections',
    expectedStatus: 401,
    testNumber: 1,
  });

  // Test 2: Get all sections with invalid token (should fail)
  await runner.test('Test 2: GET /api/note-template-sections with invalid token', {
    method: 'GET',
    endpoint: '/api/note-template-sections',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
    testNumber: 2,
  });

  // Test 3: Get single section without auth (should fail)
  await runner.test('Test 3: GET /api/note-template-sections/:id without authentication', {
    method: 'GET',
    endpoint: '/api/note-template-sections/1',
    expectedStatus: 401,
    testNumber: 3,
  });

  // Test 4: Create section without auth (should fail)
  await runner.test('Test 4: POST /api/note-template-sections without authentication', {
    method: 'POST',
    endpoint: '/api/note-template-sections',
    body: mockSectionData,
    expectedStatus: 401,
    testNumber: 4,
  });

  // Test 5: Update section without auth (should fail)
  await runner.test('Test 5: PATCH /api/note-template-sections/:id without authentication', {
    method: 'PATCH',
    endpoint: '/api/note-template-sections/1',
    body: { name: 'Updated' },
    expectedStatus: 401,
    testNumber: 5,
  });

  // Test 6: Delete section without auth (should fail)
  await runner.test('Test 6: DELETE /api/note-template-sections/:id without authentication', {
    method: 'DELETE',
    endpoint: '/api/note-template-sections/1',
    expectedStatus: 401,
    testNumber: 6,
  });

  // ===== VALIDATION TESTS =====

  if (realAccessToken) {
    // Test 7: Create section with missing name (should fail - validation error)
    await runner.test('Test 7: POST /api/note-template-sections with missing name', {
      method: 'POST',
      endpoint: '/api/note-template-sections',
      body: { layout: 'paragraph', details: 'Test' },
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
      testNumber: 7,
      customValidator: (body) => {
        const hasError = body.error !== undefined;
        return {
          passed: hasError,
          message: hasError ? '✓ Zod validation error returned' : '✗ Expected validation error',
        };
      },
    });

    // Test 8: Create section with missing layout (should fail - validation error)
    await runner.test('Test 8: POST /api/note-template-sections with missing layout', {
      method: 'POST',
      endpoint: '/api/note-template-sections',
      body: { name: 'Test', details: 'Test' },
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
      testNumber: 8,
      customValidator: (body) => {
        const hasError = body.error !== undefined;
        return {
          passed: hasError,
          message: hasError ? '✓ Zod validation error returned' : '✗ Expected validation error',
        };
      },
    });

    // Test 9: Create section with empty name (should fail - validation error)
    await runner.test('Test 9: POST /api/note-template-sections with empty name', {
      method: 'POST',
      endpoint: '/api/note-template-sections',
      body: { name: '', layout: 'paragraph', details: 'Test' },
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
      testNumber: 9,
      customValidator: (body) => {
        const hasError = body.error !== undefined;
        return {
          passed: hasError,
          message: hasError ? '✓ Zod validation error returned' : '✗ Expected validation error',
        };
      },
    });

    // ===== CRUD TESTS =====

    // Test 10: Create section (should succeed)
    await runner.test('Test 10: POST /api/note-template-sections with valid data', {
      method: 'POST',
      endpoint: '/api/note-template-sections',
      body: mockSectionData,
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 201,
      expectedFields: ['id', 'name', 'layout', 'details', 'user_id', 'created_at'],
      testNumber: 10,
      onSuccess: (data) => {
        cachedSectionId = data.id;
        console.log(`    ✓ Created section with ID: ${data.id}, details decrypted: ${data.details ? 'yes' : 'no'}`);
      },
    });

    // Test 11: Get all sections (should include the created one)
    await runner.test('Test 11: GET /api/note-template-sections with authentication (list all)', {
      method: 'GET',
      endpoint: '/api/note-template-sections',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      testNumber: 11,
      customValidator: (data) => {
        if (!Array.isArray(data)) {
          return { passed: false, message: '✗ Response is not an array' };
        }
        const created = data.find((s) => s.id === cachedSectionId);
        if (created) {
          return {
            passed: true,
            message: `✓ Created section found in list (decrypted: ${created.details ? 'yes' : 'no'})`,
          };
        }
        return { passed: false, message: '✗ Created section not found in list' };
      },
    });

    // Test 12: Get single section by ID (DEPENDENT ON TEST 10)
    if (!cachedSectionId) {
      console.log('⚠️  Test 12: GET /api/note-template-sections/:id with valid ID');
      console.log('   ⚠️  SKIPPED: Test 10 failed, cannot test GET with real section\n');
    } else {
      await runner.test('Test 12: GET /api/note-template-sections/:id with valid ID', {
        method: 'GET',
        endpoint: `/api/note-template-sections/${cachedSectionId}`,
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 200,
        expectedFields: ['id', 'name', 'layout', 'details'],
        testNumber: 12,
        customValidator: (data) => {
          const detailsMatch = data.details === mockSectionData.details;
          return {
            passed: detailsMatch,
            message: detailsMatch
              ? '✓ Details correctly decrypted'
              : `✗ Details mismatch - expected "${mockSectionData.details}", got "${data.details}"`,
          };
        },
      });
    }

    // Test 13: Update section name (DEPENDENT ON TEST 10)
    if (!cachedSectionId) {
      console.log('⚠️  Test 13: PATCH /api/note-template-sections/:id to update name');
      console.log('   ⚠️  SKIPPED: Test 10 failed, cannot test PATCH with real section\n');
    } else {
      await runner.test('Test 13: PATCH /api/note-template-sections/:id to update name', {
        method: 'PATCH',
        endpoint: `/api/note-template-sections/${cachedSectionId}`,
        body: { name: 'Updated Test Section 1' },
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 200,
        testNumber: 13,
        customValidator: (data) => {
          const nameUpdated = data.name === 'Updated Test Section 1';
          return {
            passed: nameUpdated,
            message: nameUpdated ? '✓ Name updated correctly' : '✗ Name update failed',
          };
        },
      });
    }

    // Test 14: Update section details (re-encryption) (DEPENDENT ON TEST 10)
    if (!cachedSectionId) {
      console.log('⚠️  Test 14: PATCH /api/note-template-sections/:id to update details');
      console.log('   ⚠️  SKIPPED: Test 10 failed, cannot test PATCH with real section\n');
    } else {
      await runner.test('Test 14: PATCH /api/note-template-sections/:id to update details', {
        method: 'PATCH',
        endpoint: `/api/note-template-sections/${cachedSectionId}`,
        body: { details: 'Updated details with new encryption' },
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 200,
        testNumber: 14,
        customValidator: (data) => {
          const detailsUpdated = data.details === 'Updated details with new encryption';
          return {
            passed: detailsUpdated,
            message: detailsUpdated
              ? '✓ Details updated and re-encrypted correctly'
              : '✗ Details update failed',
          };
        },
      });
    }

    // Test 15: Update with no fields (should fail - validation error) (DEPENDENT ON TEST 10)
    if (!cachedSectionId) {
      console.log('⚠️  Test 15: PATCH /api/note-template-sections/:id with no fields');
      console.log('   ⚠️  SKIPPED: Test 10 failed, cannot test PATCH with real section\n');
    } else {
      await runner.test('Test 15: PATCH /api/note-template-sections/:id with no fields', {
        method: 'PATCH',
        endpoint: `/api/note-template-sections/${cachedSectionId}`,
        body: {},
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 400,
        testNumber: 15,
        customValidator: (body) => {
          const hasError = body.error !== undefined;
          return {
            passed: hasError,
            message: hasError ? '✓ Zod validation error for empty update' : '✗ Expected validation error',
          };
        },
      });
    }

    // Test 16: Create duplicate section name (should fail with 409)
    await runner.test('Test 16: POST /api/note-template-sections with duplicate name', {
      method: 'POST',
      endpoint: '/api/note-template-sections',
      body: { name: 'Updated Test Section 1', layout: 'paragraph', details: 'Different' },
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 409,
      testNumber: 16,
      customValidator: (body) => {
        const isDuplicateError = body.code === 'DUPLICATE_NAME';
        return {
          passed: isDuplicateError,
          message: isDuplicateError
            ? '✓ Duplicate name error returned (409 Conflict)'
            : '✗ Expected DUPLICATE_NAME error',
        };
      },
    });

    // Test 17: Get invalid section ID (should fail with 404)
    await runner.test('Test 17: GET /api/note-template-sections/:id with invalid ID', {
      method: 'GET',
      endpoint: '/api/note-template-sections/99999999',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 404,
      testNumber: 17,
    });

    // Test 18: Delete section successfully (DEPENDENT ON TEST 10)
    let test18Passed = false;
    if (!cachedSectionId) {
      console.log('⚠️  Test 18: DELETE /api/note-template-sections/:id successfully');
      console.log('   ⚠️  SKIPPED: Test 10 failed, cannot test DELETE with real section\n');
    } else {
      await runner.test('Test 18: DELETE /api/note-template-sections/:id successfully', {
        method: 'DELETE',
        endpoint: `/api/note-template-sections/${cachedSectionId}`,
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 204,
        testNumber: 18,
        onSuccess: () => {
          test18Passed = true;
        },
      });
    }

    // Test 19: Verify deleted section is gone (DEPENDENT ON TEST 18 AND TEST 10)
    if (!cachedSectionId || !test18Passed) {
      console.log('⚠️  Test 19: GET /api/note-template-sections/:id verifies section deleted');
      console.log('   ⚠️  SKIPPED: Test 18 or Test 10 failed, cannot verify deletion\n');
    } else {
      await runner.test('Test 19: GET /api/note-template-sections/:id verifies section deleted', {
        method: 'GET',
        endpoint: `/api/note-template-sections/${cachedSectionId}`,
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 404,
        testNumber: 19,
      });
    }

    // Test 20: Verify system-generated sections are present
    const systemSectionNames = [
      'Chief Complaint',
      'History of Present Illness',
      'Past Medical/Surgical/Family/Social History',
      'Review of Systems',
      'Medications',
      'Allergies',
      'General Exam',
      'HEENT',
      'Cardiovascular',
      'Musculoskeletal',
      'Other Findings',
      'Assessment',
      'Plan',
      'Billing - ICD-10 Codes',
      'Billing - CPT Codes',
      'Additional Inquiries',
    ];

    await runner.test('Test 20: GET /api/note-template-sections retrieves 16 system-generated sections', {
      method: 'GET',
      endpoint: '/api/note-template-sections',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      testNumber: 20,
      customValidator: (data) => {
        if (!Array.isArray(data)) {
          return { passed: false, message: '✗ Response is not an array' };
        }

        const systemSections = data.filter((s) => s.user_id === null);
        const foundNames = systemSections.map((s) => s.name);
        const missingNames = systemSectionNames.filter((name) => !foundNames.includes(name));
        const decryptedCount = systemSections.filter((s) => s.details && !s.encrypted_details).length;

        if (systemSections.length !== 16) {
          return {
            passed: false,
            message: `✗ Expected 16 system sections, found ${systemSections.length}`,
          };
        }

        if (missingNames.length > 0) {
          return {
            passed: false,
            message: `✗ Missing system sections: ${missingNames.join(', ')}`,
          };
        }

        if (decryptedCount !== 16) {
          return {
            passed: false,
            message: `✗ Expected all 16 sections decrypted, found ${decryptedCount} with details`,
          };
        }

        return {
          passed: true,
          message: `✓ All 16 system-generated sections present and decrypted`,
        };
      },
    });
  } // Closes if (realAccessToken)

  // ===== REPORTING =====

  runner.printResults(20);
  const resultsFile = runner.saveResults('note-template-sections-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  console.log('✅ Note Template Sections API test suite completed\n');
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runNoteTemplateSectionsTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

export { runNoteTemplateSectionsTests };
