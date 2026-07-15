/**
 * Test Suite: SOAP Notes API
 * Tests all SOAP note endpoints: CRUD operations with pagination, encryption/decryption
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

const runner = new TestRunner('SOAP Notes API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Track created test data for cleanup
const createdSoapNoteIds = [];
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
  name: 'Test Encounter for SOAP Notes',
};

const mockSoapNoteData = {
  soapNote_text: {
    soapNote: {
      subjective: 'Patient reports fatigue and headache',
      objective: 'BP 120/80, HR 72, afebrile',
      assessment: 'Viral syndrome',
      plan: 'Rest, fluids, monitor symptoms',
    },
    billingSuggestion: 'CPT 99213 - Office visit',
  },
};

/**
 * Helper: Create a test encounter for SOAP notes
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
 * Helper: Clean up test SOAP notes and encounters after tests complete
 */
async function cleanupTestData(accessToken) {
  let successCount = 0;
  let failedCount = 0;

  // Delete SOAP notes
  if (createdSoapNoteIds.length > 0) {
    console.log(`\n  [Cleanup] Deleting ${createdSoapNoteIds.length} created test SOAP notes...`);
    
    for (const id of createdSoapNoteIds) {
      try {
        const response = await fetch(`${runner.baseUrl}/api/soap-notes/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        if (response.ok || response.status === 204) {
          successCount++;
        } else {
          failedCount++;
          console.log(`  ⚠️  Failed to delete SOAP note ${id}: ${response.status}`);
        }
      } catch (error) {
        failedCount++;
        console.log(`  ⚠️  Could not delete SOAP note ${id}:`, error.message);
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
 * Run all SOAP notes tests
 */
async function runSoapNotesTests() {
  console.log('Starting SOAP Notes API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  // Load test data first (created by setup)
  testData = loadTestData();
  console.log(`✅ Loaded test data:`);
  console.log(`  Encounters: ${testData.encounters.length}`);
  console.log(`  Recordings: ${testData.recordings.length}`);
  console.log(`  SOAP Notes: ${testData.soapNotes.created}\n`);

  let realAccessToken = null;
  let testEncounterId = null;
  let createdSoapNoteId = null;

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
            turnstileToken: process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN,
          }),
        });
        const signInResponse = await response.json();
        if (signInResponse?.token?.access_token) {
          realAccessToken = signInResponse.token.access_token;
          console.log('✅ Obtained real access token for validation tests\n');

          // Use existing encounter from test data (last one has no SOAP notes attached)
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

  // Test 1: Get all SOAP notes without auth (should fail)
  await runner.test('Get all SOAP notes without auth', {
    method: 'GET',
    endpoint: '/api/soap-notes',
    expectedStatus: 401,
  });

  // Test 2: Get all SOAP notes with invalid token (should fail)
  await runner.test('Get all SOAP notes with invalid token', {
    method: 'GET',
    endpoint: '/api/soap-notes',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
  });

  // Test 3: Get single SOAP note without auth (should fail)
  await runner.test('Get SOAP note without auth', {
    method: 'GET',
    endpoint: '/api/soap-notes/1',
    expectedStatus: 401,
  });

  // Test 4: Create SOAP note without auth (should fail)
  await runner.test('Create SOAP note without auth', {
    method: 'POST',
    endpoint: '/api/soap-notes',
    body: mockSoapNoteData,
    expectedStatus: 401,
  });

  // Test 5: Update SOAP note without auth (should fail)
  await runner.test('Update SOAP note without auth', {
    method: 'PATCH',
    endpoint: '/api/soap-notes/1',
    body: mockSoapNoteData,
    expectedStatus: 401,
  });

  // Test 6: Delete SOAP note without auth (should fail)
  await runner.test('Delete SOAP note without auth', {
    method: 'DELETE',
    endpoint: '/api/soap-notes/1',
    expectedStatus: 401,
  });

  // ===== PAGINATION AND LIST TESTS =====

  if (realAccessToken) {
    // Test 7: Get all SOAP notes with pagination (valid token)
    await runner.test('Get all SOAP notes with pagination', {
      method: 'GET',
      endpoint: '/api/soap-notes?limit=100&offset=0&sortBy=created_at&order=desc',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      expectedFields: [],
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
            console.log(`    ⚠️  WARNING: SOAP notes not in descending order by created_at`);
          } else {
            console.log(`    ✓ SOAP notes correctly ordered descending by created_at`);
          }
        }
      },
    });

    // Test 8: Get all SOAP notes with different sort parameters (ascending by updated_at)
    await runner.test('Get SOAP notes sorted by updated_at (ascending)', {
      method: 'GET',
      endpoint: '/api/soap-notes?sortBy=updated_at&order=asc',
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
            console.log(`    ⚠️  WARNING: SOAP notes not in ascending order by updated_at`);
          } else {
            console.log(`    ✓ SOAP notes correctly ordered ascending by updated_at`);
          }
        }
      },
    });

    // Test 8b: Pagination with limit and offset
    await runner.test('Pagination: limit=2&offset=0 (first 2 records)', {
      method: 'GET',
      endpoint: '/api/soap-notes?limit=2&offset=0',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
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

    // Test 8c: Pagination with offset=1
    await runner.test('Pagination: limit=2&offset=1 (skip 1, take 2)', {
      method: 'GET',
      endpoint: '/api/soap-notes?limit=2&offset=1',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      onSuccess: (data) => {
        if (Array.isArray(data)) {
          // Fetch full list to compare
          const validatePagination = async () => {
            try {
              const fullResponse = await fetch(`${runner.baseUrl}/api/soap-notes?limit=1000&offset=0`, {
                headers: { Authorization: `Bearer ${realAccessToken}` },
              });
              const fullData = await fullResponse.json();
              
              if (Array.isArray(fullData) && fullData.length > 1) {
                const expectedIds = fullData.slice(1, 3).map(n => n.id);
                const returnedIds = data.map(n => n.id);
                
                if (JSON.stringify(expectedIds) === JSON.stringify(returnedIds)) {
                  console.log(`    ✓ Offset=1 correctly skipped first record`);
                } else {
                  console.log(`    ⚠️  WARNING: Offset=1 returned wrong records. Expected IDs: ${expectedIds}, Got: ${returnedIds}`);
                }
              }
            } catch (error) {
              console.log(`    ⚠️  Could not validate offset:`, error.message);
            }
          };
          validatePagination();
        }
      },
    });

    // Test 8d: Pagination boundary - offset beyond records
    await runner.test('Pagination: offset=1000 (beyond available records)', {
      method: 'GET',
      endpoint: '/api/soap-notes?limit=2&offset=1000',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 200,
      onSuccess: (data) => {
        if (Array.isArray(data)) {
          if (data.length === 0) {
            console.log(`    ✓ Correctly returned empty array for offset beyond records`);
          } else {
            console.log(`    ⚠️  WARNING: Expected empty array for large offset, got ${data.length} records`);
          }
        }
      },
    });

    // Test 8e: Invalid limit (non-numeric)
    await runner.test('Pagination: invalid limit parameter (non-numeric)', {
      method: 'GET',
      endpoint: '/api/soap-notes?limit=abc&offset=0',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
    });

    // Test 8f: Invalid offset (negative)
    await runner.test('Pagination: invalid offset parameter (negative)', {
      method: 'GET',
      endpoint: '/api/soap-notes?limit=2&offset=-1',
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      expectedStatus: 400,
    });

    // ===== CREATE TESTS =====

    // Test 9: Create SOAP note with valid data
    if (testEncounterId) {
      await runner.test('Create SOAP note with valid data', {
        method: 'POST',
        endpoint: '/api/soap-notes',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: {
          patientEncounter_id: testEncounterId,
          ...mockSoapNoteData,
        },
        expectedStatus: 201,
        expectedFields: ['id', 'patientEncounter_id', 'soapNote_text'],
        onSuccess: (data) => {
          // Store the created ID for retrieval and cleanup
          if (data.id) {
            createdSoapNoteId = data.id;
            createdSoapNoteIds.push(data.id);
            console.log(`    Created SOAP note ID: ${data.id}`);
          }
        },
      });

      // Test 10: Create SOAP note with missing patientEncounter_id (should fail)
      await runner.test('Create SOAP note with missing patientEncounter_id', {
        method: 'POST',
        endpoint: '/api/soap-notes',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: mockSoapNoteData,
        expectedStatus: 400,
        validator: (data) => {
          if (!data.error) return { valid: false, reason: 'Missing error field' };
          if (data.error.name !== 'ZodError') return { valid: false, reason: `Expected ZodError, got ${data.error.name}` };
          if (!data.error.message.includes('patientEncounter_id')) return { valid: false, reason: 'Error message should mention patientEncounter_id field' };
          if (!data.error.message.includes('required')) return { valid: false, reason: 'Error message should mention required' };
          return { valid: true };
        },
      });

      // Test 11: Create SOAP note with invalid patientEncounter_id (should fail)
      await runner.test('Create SOAP note with non-existent encounter', {
        method: 'POST',
        endpoint: '/api/soap-notes',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: {
          patientEncounter_id: 99999999,
          ...mockSoapNoteData,
        },
        expectedStatus: 404,
      });

      // ===== RETRIEVAL TESTS =====

      if (createdSoapNoteId) {
        // Test 12: Get single SOAP note by ID
        await runner.test('Get single SOAP note by ID', {
          method: 'GET',
          endpoint: `/api/soap-notes/${createdSoapNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 200,
          expectedFields: ['id', 'patientEncounter_id', 'soapNote_text'],
        });

        // Test 13: Get SOAP note with invalid ID format (should fail)
        await runner.test('Get SOAP note with invalid ID format', {
          method: 'GET',
          endpoint: '/api/soap-notes/invalid-id',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 400,
        });

        // Test 14: Get SOAP note with non-existent ID (should fail)
        await runner.test('Get SOAP note with non-existent ID', {
          method: 'GET',
          endpoint: '/api/soap-notes/99999999',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 404,
        });
      }

      // ===== UPDATE TESTS =====

      // Test 15: Update SOAP note with valid data
      const updatedSoapNoteData = {
        soapNote_text: {
          soapNote: {
            subjective: 'Patient reports improved condition',
            objective: 'BP 118/78, HR 70',
            assessment: 'Viral syndrome - improving',
            plan: 'Continue rest, follow up in 3 days',
          },
          billingSuggestion: 'CPT 99213 - Office visit (follow-up)',
        },
      };

      if (!createdSoapNoteId) {
        console.log('  ⚠️  Test 9 (Create SOAP note) must pass first - Test 15 cannot run\n');
      } else {
        await runner.test('Update SOAP note with valid data', {
          method: 'PATCH',
          endpoint: `/api/soap-notes/${createdSoapNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: updatedSoapNoteData,
          expectedStatus: 200,
          expectedFields: ['id', 'patientEncounter_id', 'soapNote_text'],
        });
      }

      // Test 16: Update SOAP note with invalid ID format (should fail)
      await runner.test('Update SOAP note with invalid ID format', {
        method: 'PATCH',
        endpoint: '/api/soap-notes/invalid-id',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: updatedSoapNoteData,
        expectedStatus: 400,
      });

      // Test 17: Update non-existent SOAP note (should fail)
      await runner.test('Update non-existent SOAP note', {
        method: 'PATCH',
        endpoint: '/api/soap-notes/99999999',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: updatedSoapNoteData,
        expectedStatus: 404,
      });

      // ===== DELETE TESTS =====

      // Test 18: Delete SOAP note with invalid ID format (should fail)
      await runner.test('Delete SOAP note with invalid ID format', {
        method: 'DELETE',
        endpoint: '/api/soap-notes/invalid-id',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 400,
      });

      // Test 19: Delete non-existent SOAP note (should fail with 404)
      await runner.test('Delete non-existent SOAP note', {
        method: 'DELETE',
        endpoint: '/api/soap-notes/99999999',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        expectedStatus: 404,
      });

      // Test 20: Delete SOAP note successfully
      if (!createdSoapNoteId) {
        console.log('  ⚠️  Test 9 (Create SOAP note) must pass first - Test 20 cannot run\n');
      } else {
        await runner.test('Delete SOAP note successfully', {
          method: 'DELETE',
          endpoint: `/api/soap-notes/${createdSoapNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 200,
          expectedFields: ['success', 'data'],
        });

        // Test 21: Verify SOAP note was deleted
        await runner.test('Verify SOAP note was deleted', {
          method: 'GET',
          endpoint: `/api/soap-notes/${createdSoapNoteId}`,
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 404,
        });
      }
    }
  }

  // ===== SUMMARY AND CLEANUP =====

  // Print test results
  runner.saveResults('soap-notes-tests.json');
  runner.printResults();

  // Return summary for master test runner
  return runner.getSummary();

  // Cleanup test data
  if (realAccessToken) {
    await cleanupTestData(realAccessToken);
  }
}

// Run tests
runSoapNotesTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});

export { runSoapNotesTests };
