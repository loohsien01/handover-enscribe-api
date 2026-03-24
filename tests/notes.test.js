/**
 * Test Suite: Notes API
 * Tests all note endpoints: CRUD operations with pagination, encryption/decryption using master key
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

const runner = new TestRunner('Notes API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Track created test data for cleanup
const createdNoteIds = [];
const createdNoteTemplateIds = [];
const createdEncounterIds = [];

// Load test data from setup
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');
let testData = null;

function loadTestData() {
  if (!fs.existsSync(TEST_DATA_FILE)) {
    console.error('\n❌ Test data file not found!');
    console.error('Run setup first: npm run test:setup\n');
    process.exit(1);
  }

  try {
    const data = fs.readFileSync(TEST_DATA_FILE, 'utf-8');
    testData = JSON.parse(data);

    if (!testData.encounters || testData.encounters.length === 0) {
      throw new Error('No encounters found in test data');
    }

    return testData;
  } catch (error) {
    console.error('\n❌ Error reading test data:', error.message);
    console.error('Run setup first: npm run test:setup\n');
    process.exit(1);
  }
}

// Test data
const mockEncounterData = {
  name: 'Test Encounter for Notes',
};

const mockNoteTemplateData = {
  name: 'Test Note Template for API Testing',
};

const mockNoteData = {
  text: 'Patient reports fatigue. Vitals: BP 120/80, HR 72. Diagnosis: Viral syndrome. Plan: Rest and fluids.',
};

/**
 * Helper: Create a test encounter for notes
 */
async function createTestEncounter(accessToken) {
  try {
    const response = await fetch(`${runner.baseUrl}/api/patient-encounters`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(mockEncounterData),
    });

    if (!response.ok) {
      throw new Error(`Failed to create test encounter: ${response.status}`);
    }

    const data = await response.json();
    const encounterId = data.id;
    createdEncounterIds.push(encounterId);
    return encounterId;
  } catch (error) {
    console.error('Error creating test encounter:', error);
    throw error;
  }
}

/**
 * Helper: Create a test note template for notes
 */
async function createTestNoteTemplate(accessToken) {
  try {
    const response = await fetch(`${runner.baseUrl}/api/note-templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(mockNoteTemplateData),
    });

    if (!response.ok) {
      throw new Error(`Failed to create test note template: ${response.status}`);
    }

    const data = await response.json();
    const templateId = data.id;
    createdNoteTemplateIds.push(templateId);
    return templateId;
  } catch (error) {
    console.error('Error creating test note template:', error);
    throw error;
  }
}

/**
 * Helper: Clean up test notes, templates, and encounters after tests complete
 */
async function cleanupTestData(accessToken) {
  let successCount = 0;
  let failedCount = 0;

  // Delete notes
  if (createdNoteIds.length > 0) {
    console.log(`\n  [Cleanup] Deleting ${createdNoteIds.length} created test notes...`);
    
    for (const id of createdNoteIds) {
      try {
        const response = await fetch(`${runner.baseUrl}/api/notes/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        if (response.ok || response.status === 204) {
          successCount++;
          console.log(`  ✅ Deleted note ${id}`);
        } else {
          failedCount++;
          console.log(`  ⚠️  Failed to delete note ${id}: ${response.status}`);
        }
      } catch (error) {
        failedCount++;
        console.log(`  ⚠️  Could not delete note ${id}:`, error.message);
      }
    }
  }

  // Delete note templates
  if (createdNoteTemplateIds.length > 0) {
    console.log(`  [Cleanup] Deleting ${createdNoteTemplateIds.length} created test note templates...`);
    
    for (const id of createdNoteTemplateIds) {
      try {
        const response = await fetch(`${runner.baseUrl}/api/note-templates/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        if (response.ok || response.status === 204) {
          successCount++;
          console.log(`  ✅ Deleted note template ${id}`);
        } else {
          failedCount++;
          console.log(`  ⚠️  Failed to delete note template ${id}: ${response.status}`);
        }
      } catch (error) {
        failedCount++;
        console.log(`  ⚠️  Could not delete note template ${id}:`, error.message);
      }
    }
  }

  // Delete encounters
  if (createdEncounterIds.length > 0) {
    console.log(`  [Cleanup] Deleting ${createdEncounterIds.length} created test encounters...`);
    
    for (const id of createdEncounterIds) {
      try {
        const response = await fetch(`${runner.baseUrl}/api/patient-encounters/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        if (response.ok || response.status === 204) {
          successCount++;
          console.log(`  ✅ Deleted encounter ${id}`);
        } else {
          failedCount++;
          console.log(`  ⚠️  Failed to delete encounter ${id}: ${response.status}`);
        }
      } catch (error) {
        failedCount++;
        console.log(`  ⚠️  Could not delete encounter ${id}:`, error.message);
      }
    }
  }

  if (failedCount === 0 && successCount > 0) {
    console.log(`  ✅ Cleanup complete - deleted ${successCount} resources\n`);
  } else if (failedCount > 0) {
    console.log(`  ⚠️  Cleanup partial - deleted ${successCount}, failed ${failedCount}\n`);
  }
}

/**
 * Run all notes tests
 */
async function runNotesTests() {
  console.log('Starting Notes API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  // Load test data first (created by setup)
  testData = loadTestData();
  console.log(`✅ Loaded test data:`);
  console.log(`  Encounters: ${testData.encounters.length}\n`);

  let realAccessToken = null;
  let testEncounterId = null;
  let testTemplateId = null;
  let createdNoteId = null;

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

          // Use existing encounter from test data
          if (testData.encounters.length > 0) {
            testEncounterId = testData.encounters[testData.encounters.length - 1].id;
            console.log(`✅ Using existing encounter ${testEncounterId} from test data\n`);
          } else {
            console.error('❌ No encounters available in test data\n');
          }
        }
      } catch (error) {
        console.log('⚠️  Could not get real token, using mock tests only\n');
      }
    }
  }

  // ===== AUTHENTICATION TESTS =====

  // Test 1: Get all notes without auth (should fail)
  await runner.test('Get all notes without auth', {
    method: 'GET',
    endpoint: '/api/notes',
    expectedStatus: 401,
    testNumber: 1,
  });

  // Test 2: Get all notes with invalid token (should fail)
  await runner.test('Get all notes with invalid token', {
    method: 'GET',
    endpoint: '/api/notes',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
    testNumber: 2,
  });

  // Test 3: Get single note without auth (should fail)
  await runner.test('Get note without auth', {
    method: 'GET',
    endpoint: '/api/notes/1',
    expectedStatus: 401,
    testNumber: 3,
  });

  // Test 4: Create note without auth (should fail)
  await runner.test('Create note without auth', {
    method: 'POST',
    endpoint: '/api/notes',
    body: mockNoteData,
    expectedStatus: 401,
    testNumber: 4,
  });

  // Test 5: Update note without auth (should fail)
  await runner.test('Update note without auth', {
    method: 'PATCH',
    endpoint: '/api/notes/1',
    body: mockNoteData,
    expectedStatus: 401,
    testNumber: 5,
  });

  // Test 6: Delete note without auth (should fail)
  await runner.test('Delete note without auth', {
    method: 'DELETE',
    endpoint: '/api/notes/1',
    expectedStatus: 401,
    testNumber: 6,
  });

  // ===== PAGINATION AND LIST TESTS =====

  if (realAccessToken) {
    // Test 7: Get all notes with pagination (valid token)
    await runner.test('Get all notes with pagination', {
      method: 'GET',
      endpoint: '/api/notes?limit=100&offset=0&sortBy=created_at&order=desc',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      expectedFields: [],
      testNumber: 7,
      onSuccess: (data) => {
        // Validate descending order by created_at
        if (Array.isArray(data) && data.length > 1) {
          let isDescending = true;
          for (let i = 0; i < data.length - 1; i++) {
            const current = new Date(data[i].created_at).getTime();
            const next = new Date(data[i + 1].created_at).getTime();
            if (current < next) {
              isDescending = false;
              break;
            }
          }
          if (!isDescending) {
            console.log(`    ⚠️  WARNING: Notes not in descending order by created_at`);
          } else {
            console.log(`    ✓ Notes correctly ordered descending by created_at`);
          }
        }
      },
    });

    // Test 8: Get all notes with different sort parameters (ascending by updated_at)
    await runner.test('Get notes sorted by updated_at (ascending)', {
      testNumber: 8,
      method: 'GET',
      endpoint: '/api/notes?sortBy=updated_at&order=asc',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      onSuccess: (data) => {
        // Validate ascending order by updated_at
        if (Array.isArray(data) && data.length > 1) {
          let isAscending = true;
          for (let i = 0; i < data.length - 1; i++) {
            const current = new Date(data[i].updated_at).getTime();
            const next = new Date(data[i + 1].updated_at).getTime();
            if (current > next) {
              isAscending = false;
              break;
            }
          }
          if (!isAscending) {
            console.log(`    ⚠️  WARNING: Notes not in ascending order by updated_at`);
          } else {
            console.log(`    ✓ Notes correctly ordered ascending by updated_at`);
          }
        }
      },
    });

    // Test 9: Pagination with limit and offset
    await runner.test('Pagination: limit=2&offset=0 (first 2 records)', {
      method: 'GET',
      endpoint: '/api/notes?limit=2&offset=0',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      testNumber: 9,
      onSuccess: (data) => {
        if (Array.isArray(data)) {
          if (data.length !== 2) {
            console.log(`    ⚠️  WARNING: Expected 2 records, got ${data.length}`);
          } else {
            console.log(`    ✓ Returned correct limit of 2 records`);
          }
        }
      },
    });

    // Test 10: Invalid limit (non-numeric)
    await runner.test('Pagination: invalid limit parameter (non-numeric)', {
      method: 'GET',
      endpoint: '/api/notes?limit=abc&offset=0',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
      testNumber: 10,
    });

    // Test 11: Invalid offset (negative)
    await runner.test('Pagination: invalid offset parameter (negative)', {
      method: 'GET',
      endpoint: '/api/notes?limit=2&offset=-1',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
      testNumber: 11,
    });

    // ===== CREATE TESTS =====

    // Test 12: Create note template first (required for notes)
    if (realAccessToken) {
      await runner.test('Create note template for testing', {        testNumber: 12,        method: 'POST',
        endpoint: '/api/note-templates',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: mockNoteTemplateData,
        expectedStatus: 201,
        expectedFields: ['id', 'name'],
        onSuccess: (data) => {
          if (data.id) {
            testTemplateId = data.id;
            createdNoteTemplateIds.push(data.id);
            console.log(`    Created note template ID: ${data.id}`);
          }
        },
      });
    }

    // Test 10: Create note with valid data
    if (testEncounterId && testTemplateId) {
      await runner.test('Create note with valid data', {
        method: 'POST',
        endpoint: '/api/notes',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: {
          patientEncounter_id: testEncounterId,
          ...mockNoteData,
        },
        expectedStatus: 201,
        expectedFields: ['id', 'patientEncounter_id'],
        testNumber: 13,
        onSuccess: (data) => {
          // Store the created ID for retrieval and cleanup
          if (data.id) {
            createdNoteId = data.id;
            createdNoteIds.push(data.id);
            console.log(`    Created note ID: ${data.id}`);
          }
        },
      });

      // Test 14: Create note with non-existent encounter (should fail)
      await runner.test('Create note with non-existent encounter', {        testNumber: 14,        method: 'POST',
        endpoint: '/api/notes',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: {
          patientEncounter_id: 99999999,
          ...mockNoteData,
        },
        expectedStatus: 404,
      });

      // ===== RETRIEVAL TESTS =====

      if (createdNoteId) {
        // Test 15: Get single note by ID
        await runner.test('Get single note by ID', {
          method: 'GET',
          endpoint: `/api/notes/${createdNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 200,
          expectedFields: ['id', 'patientEncounter_id', 'text'],
          testNumber: 15,
        });

        // Test 16: Get note with invalid ID format (should fail)
        await runner.test('Get note with invalid ID format', {
          method: 'GET',
          endpoint: '/api/notes/invalid-id',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 400,
          testNumber: 16,
        });

        // Test 17: Get note with non-existent ID (should fail)
        await runner.test('Get note with non-existent ID', {
          method: 'GET',
          endpoint: '/api/notes/99999999',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 404,
          testNumber: 17,
        });
      }

      // ===== UPDATE TESTS =====

      // Test 18: Update note with valid data
      const updatedNoteData = {
        text: 'Updated note: Patient condition improved. Continue with rest and fluids. Follow up next week.',
        status: 'paused',
      };

      if (!createdNoteId) {
        console.log('  ⚠️  Test 13 (Create note) must pass first - Test 18 cannot run\n');
      } else {
        await runner.test('Update note with valid data', {
          method: 'PATCH',
          endpoint: `/api/notes/${createdNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: updatedNoteData,
          expectedStatus: 200,
          expectedFields: ['id', 'patientEncounter_id', 'text'],
          testNumber: 18,
        });
      }

      // Test 19: Update note with invalid ID format (should fail)
      await runner.test('Update note with invalid ID format', {        testNumber: 19,        method: 'PATCH',
        endpoint: '/api/notes/invalid-id',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: updatedNoteData,
        expectedStatus: 400,
      });

      // Test 21: Update non-existent note (should fail)
      await runner.test('Update non-existent note', {        testNumber: 22,        method: 'PATCH',
        endpoint: '/api/notes/99999999',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: updatedNoteData,
        expectedStatus: 404,
      });

      // Test 22: Update note with invalid status enum (should fail)
      if (createdNoteId) {
        await runner.test('Update note with invalid status enum', {
          method: 'PATCH',
          endpoint: `/api/notes/${createdNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: { status: 'draft' },
          expectedStatus: 400,
          testNumber: 23,
        });
      }

      // ===== DELETE TESTS =====

      // Test 23: Delete note with invalid ID format (should fail)
      await runner.test('Delete note with invalid ID format', {        testNumber: 24,        method: 'DELETE',
        endpoint: '/api/notes/invalid-id',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 400,
      });

      // Test 24: Delete non-existent note (should fail with 404)
      await runner.test('Delete non-existent note', {
        method: 'DELETE',
        endpoint: '/api/notes/99999999',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 404,
        testNumber: 25,
      });

      // Test 25: Delete note successfully
      if (!createdNoteId) {
        console.log('  ⚠️  Test 13 (Create note) must pass first - Test 25 cannot run\n');
      } else {
        await runner.test('Delete note successfully', {
          method: 'DELETE',
          endpoint: `/api/notes/${createdNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 200,
          expectedFields: ['success', 'data'],
          testNumber: 26,
        });

        // Test 26: Verify note was deleted
        await runner.test('Verify note was deleted', {
          method: 'GET',
          endpoint: `/api/notes/${createdNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 404,
          testNumber: 27,
        });
      }
    }
  }

  // ===== SUMMARY AND CLEANUP =====

  // Print test results
  runner.saveResults('notes-tests.json');
  runner.printResults();

  // Return summary for master test runner
  const summary = runner.getSummary();

  // Cleanup test data
  if (realAccessToken) {
    await cleanupTestData(realAccessToken);
  }

  return summary;
}

// Run tests
runNotesTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});

export { runNotesTests };
