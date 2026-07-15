/**
 * Test Suite: Patient Encounters API
 * Tests all patient encounter endpoints: CRUD operations, batch, complete, filtering
 *
 * Test numbering (`testNumber`):
 * - Every `runner.test` sets `testNumber` to a single integer from 1 to 26, in execution order.
 * - Section banners (`// ===== TEST N: ... =====`) and the human-readable test name (`'Test N: …'`)
 *   use that same index so comments, JSON results, and code stay aligned.
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
import { isValidDownloadSignedUrl, downloadSignedUrlFormatLabel } from './recordingsStorageTestHelpers.js';
import { createClient } from '@supabase/supabase-js';

const runner = new TestRunner('Patient Encounters API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Load test data
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');
let testData = null;

function loadTestData() {
  if (!fs.existsSync(TEST_DATA_FILE)) {
    // Optional - not required for basic CRUD tests
    return null;
  }

  try {
    const data = fs.readFileSync(TEST_DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(`  ⚠️  Could not load testData.json: ${error.message}`);
    return null;
  }
}

/**
 * Helper: Fetch real recording files from Supabase storage
 * Returns the first available recording file path for use in tests
 */
async function getFirstRealRecordingFile(accessToken) {
  try {
    // Create authenticated Supabase client with the user's token
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false },
        global: {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      }
    );

    // Get the current user from Supabase auth
    const { data: { user } } = await supabase.auth.getUser();

    if (!user || !user.id) {
      console.warn('  ⚠️  Could not get user from token');
      return null;
    }

    // List files in the user's directory in the audio-files bucket
    const { data, error } = await supabase.storage
      .from('audio-files')
      .list(`${user.id}`, { limit: 100 });

    if (error) {
      console.warn(`  ⚠️  Error listing storage files: ${error.message}`);
      return null;
    }

    // Get the first audio file
    if (!data || data.length === 0) {
      console.warn('  ⚠️  No recording files found in Supabase storage');
      return null;
    }

    const firstFile = data[0];
    const recordingPath = `${user.id}/${firstFile.name}`;
    console.log(`  ✓ Using real recording file: ${recordingPath}`);
    return recordingPath;
  } catch (error) {
    console.warn(`  ⚠️  Error fetching real recording file: ${error.message}`);
    return null;
  }
}

// Track created test data for cleanup
const createdEncounterIds = [];

// Test data for creating encounters
// Only includes fields in the patientEncounter schema
const mockEncounterData = {
  name: 'Test Patient',
};

/**
 * Helper: Clean up test encounters after tests complete
 * Deletes all encounters created during the test run
 */
async function cleanupTestEncounters(accessToken) {
  if (createdEncounterIds.length === 0) return;

  console.log(`\n  [Cleanup] Deleting ${createdEncounterIds.length} created test encounters...`);

  let successCount = 0;
  let failedIds = [];

  for (const id of createdEncounterIds) {
    try {
      const response = await fetch(`${runner.baseUrl}/api/patient-encounters/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.log(`  ⚠️  Failed to delete encounter ${id}: ${response.status} ${response.statusText}`);
        if (errorData.error) console.log(`       Error: ${errorData.error}`);
        failedIds.push(id);
      } else {
        successCount++;
      }
    } catch (error) {
      console.log(`  ⚠️  Could not delete encounter ${id}:`, error.message);
      failedIds.push(id);
    }
  }

  if (failedIds.length === 0) {
    console.log(`  ✅ Cleanup complete - all ${successCount} encounters deleted\n`);
  } else {
    console.log(`  ⚠️  Cleanup partial - deleted ${successCount}, failed ${failedIds.length}\n`);
  }
}

/**
 * Run all patient encounter tests
 */
async function runPatientEncounterTests() {
  console.log('Starting Patient Encounters API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);
  // testNumber runs 1–26 (see file header). Dependencies: e.g. tests 10–13 require test 8; test 15 requires 14.

  // Track suite-level count for cleanup verification
  let suiteCountBefore = null;
  let realAccessToken = null;
  let createdEncounterId = null;  // Current encounter ID for dependent tests
  let createdEncounterIds = [];   // Array of all created IDs for cleanup

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
        }
      } catch (error) {
        console.log('⚠️  Could not get real token, using mock tests only\n');
      }
    }
  }

  // ===== TEST 1: Get patient encounters without auth =====
  await runner.test('Test 1: Get patient encounters without auth', {
    testNumber: 1,
    method: 'GET',
    endpoint: '/api/patient-encounters',
    expectedStatus: 401,
  });

  // ===== TEST 2: Get patient encounters with invalid token =====
  await runner.test('Test 2: Get patient encounters with invalid token', {
    testNumber: 2,
    method: 'GET',
    endpoint: '/api/patient-encounters',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
  });

  // ===== TEST 3: Create patient encounter without auth =====
  await runner.test('Test 3: Create patient encounter without auth', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/patient-encounters',
    body: mockEncounterData,
    expectedStatus: 401,
  });

  // ===== TEST 4: Create patient encounter with invalid token =====
  await runner.test('Test 4: Create patient encounter with invalid token', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/patient-encounters',
    body: mockEncounterData,
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
  });

  // ===== TEST 5: Create patient encounter with missing required name field =====
  await runner.test('Test 5: Create patient encounter with missing required name field', {
    testNumber: 5,
    method: 'POST',
    endpoint: '/api/patient-encounters',
    body: {},
    headers: {
      Authorization: realAccessToken ? `Bearer ${realAccessToken}` : `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: realAccessToken ? 400 : 401,
    validator: realAccessToken ? (data) => {
      if (!data.error) return { valid: false, reason: 'Missing error field' };
      if (data.error.name !== 'ZodError') return { valid: false, reason: `Expected ZodError, got ${data.error.name}` };
      if (!data.error.message.includes('name')) return { valid: false, reason: 'Error message should mention name field' };
      return { valid: true };
    } : undefined,
  });

  // ===== TEST 6: Get specific encounter without auth =====
  await runner.test('Test 6: Get specific encounter without auth', {
    testNumber: 6,
    method: 'GET',
    endpoint: '/api/patient-encounters/test-id',
    expectedStatus: 401,
  });

  if (hasTestAccounts()) {
    const testAccount = getTestAccount('primary');

    if (testAccount && testAccount.email && testAccount.password) {
      console.log(`\n📝 Running real account tests with: ${testAccount.email.split('@')[0]}@****\n`);

      // First: Sign-in to get access token
      console.log('  [Setup] Signing in to get access token...\n');
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

        if (signInResponse && signInResponse.token && signInResponse.token.access_token) {
          realAccessToken = signInResponse.token.access_token;
          console.log('  ✅ Successfully obtained access token\n');

          // Get initial count before any tests create data
          try {
            const getCountResponse = await fetch(`${runner.baseUrl}/api/patient-encounters`, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${realAccessToken}`,
              },
            });
            const countData = await getCountResponse.json();
            suiteCountBefore = Array.isArray(countData) ? countData.length : 0;
            console.log(`  📊 Suite initial encounter count: ${suiteCountBefore}\n`);
          } catch (error) {
            console.log(`  ⚠️  Could not get initial count: ${error.message}\n`);
          }
        } else {
          console.log('  ⚠️  Could not extract access token from sign-in response\n');
        }
      } catch (error) {
        console.log('  ⚠️  Sign-in failed:', error.message, '\n');
      }

      if (realAccessToken) {
        // ===== TEST 7: Get patient encounters (authenticated user) =====
        await runner.test('Test 7: Get patient encounters (authenticated user)', {
          testNumber: 7,
          method: 'GET',
          endpoint: '/api/patient-encounters',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 200,
        });

        // ===== TEST 8: Create patient encounter (authenticated user) =====
        await runner.test('Test 8: Create patient encounter (authenticated user)', {
          testNumber: 8,
          method: 'POST',
          endpoint: '/api/patient-encounters',
          body: {
            name: 'Integration Test Patient',
          },
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 201,
          expectedFields: ['id', 'name', 'created_at', 'updated_at', 'user_id'],
          onSuccess: (data) => {
            // Store the created encounter ID for dependent tests
            if (data.id) {
              createdEncounterId = data.id;
              createdEncounterIds.push(data.id);
              console.log(`    Created encounter ID: ${data.id}`);
            }
          },
        });

        // ===== TEST 9: Get patient encounters with query params =====
        await runner.test('Test 9: Get patient encounters with query params', {
          testNumber: 9,
          method: 'GET',
          endpoint: '/api/patient-encounters?limit=5&offset=0',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 200,
        });

        // ===== TEST 10–13: decryptName list/GET behavior (depends on test 8) =====
        if (createdEncounterId) {
          await runner.test('Test 10: List encounters without decryptName (no name or ciphertext)', {
            testNumber: 10,
            method: 'GET',
            endpoint: '/api/patient-encounters',
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 200,
            customValidator: (data) => {
              if (!Array.isArray(data)) return { passed: false, message: 'Expected array' };
              const row = data.find((e) => String(e.id) === String(createdEncounterId));
              if (!row) return { passed: false, message: 'Created encounter not in list' };
              if ('name' in row && row.name !== undefined) {
                return { passed: false, message: 'name should be omitted when decryptName is false' };
              }
              const bad = ['encrypted_name', 'encrypted_aes_key', 'iv'].filter((k) => k in row);
              if (bad.length > 0) {
                return { passed: false, message: `Should not expose encryption fields: ${bad.join(', ')}` };
              }
              return { passed: true };
            },
          });

          await runner.test('Test 11: List encounters with decryptName=true includes name', {
            testNumber: 11,
            method: 'GET',
            endpoint: '/api/patient-encounters?decryptName=true',
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 200,
            customValidator: (data) => {
              if (!Array.isArray(data)) return { passed: false, message: 'Expected array' };
              const row = data.find((e) => String(e.id) === String(createdEncounterId));
              if (!row) return { passed: false, message: 'Created encounter not in list' };
              if (row.name !== 'Integration Test Patient') {
                return { passed: false, message: `Expected name "Integration Test Patient", got ${row.name}` };
              }
              return { passed: true };
            },
          });

          await runner.test('Test 12: GET encounter by id without decryptName', {
            testNumber: 12,
            method: 'GET',
            endpoint: `/api/patient-encounters/${createdEncounterId}`,
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 200,
            customValidator: (data) => {
              if ('name' in data && data.name !== undefined) {
                return { passed: false, message: 'name should be omitted when decryptName is false' };
              }
              const bad = ['encrypted_name', 'encrypted_aes_key', 'iv'].filter((k) => k in data);
              if (bad.length > 0) {
                return { passed: false, message: `Should not expose encryption fields: ${bad.join(', ')}` };
              }
              return { passed: true };
            },
          });

          await runner.test('Test 13: GET encounter by id with decryptName=true', {
            testNumber: 13,
            method: 'GET',
            endpoint: `/api/patient-encounters/${createdEncounterId}?decryptName=true`,
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 200,
            customValidator: (data) => {
              if (data.name !== 'Integration Test Patient') {
                return { passed: false, message: `Expected name "Integration Test Patient", got ${data.name}` };
              }
              return { passed: true };
            },
          });
        } else {
          console.log('⊘ Tests 10–13: SKIPPED (test 8 dependency failed - no encounter created)\n');
        }

        // ===== TEST 14: PATCH encounter (depends on test 8) =====
        let test14PatchPassed = false;
        if (createdEncounterId) {
          await runner.test('Test 14: PATCH encounter to update name (depends on test 8)', {
            testNumber: 14,
            method: 'PATCH',
            endpoint: `/api/patient-encounters/${createdEncounterId}`,
            body: {
              name: 'Updated Integration Test Patient',
            },
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 200,
            expectedFields: ['id', 'name', 'updated_at'],
            onSuccess: () => {
              test14PatchPassed = true;
            },
          });
        } else {
          console.log('⊘ Test 14: SKIPPED (test 8 dependency failed - no encounter created)\n');
        }

        // ===== TEST 15: DELETE encounter (depends on test 14) =====
        if (createdEncounterId && test14PatchPassed) {
          await runner.test('Test 15: DELETE encounter (depends on test 14)', {
            testNumber: 15,
            method: 'DELETE',
            endpoint: `/api/patient-encounters/${createdEncounterId}`,
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 200,
          });
        } else {
          console.log('⊘ Test 15: SKIPPED (test 14 dependency failed)\n');
        }

        // ===== TEST 16: Get encounter with invalid ID format =====
        await runner.test('Test 16: Get encounter with invalid ID format', {
          testNumber: 16,
          method: 'GET',
          endpoint: '/api/patient-encounters/invalid-id-format',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 400,
          validator: (data) => {
            if (!data.error) return { valid: false, reason: 'Missing error field' };
            if (!data.error.includes('Invalid ID format')) return { valid: false, reason: 'Error should indicate invalid ID format' };
            return { valid: true };
          },
        });

        // ===== TEST 17: Get non-existent encounter =====
        await runner.test('Test 17: Get non-existent encounter', {
          testNumber: 17,
          method: 'GET',
          endpoint: '/api/patient-encounters/999999999999',
          headers: {
            Authorization: `Bearer ${realAccessToken}`,
          },
          expectedStatus: 404,
        });



        // ===== TEST 18: Create complete patient encounter bundle (with recording and note) =====
        // This test creates a new encounter with recording and note in one request
        // First, fetch a real recording file from Supabase storage
        let realRecordingPath = null;
        if (realAccessToken) {
          realRecordingPath = await getFirstRealRecordingFile(realAccessToken);
        }

        // Default bundle for tests that don't need real recording files (e.g., auth tests)
        let completeBundle = {
          patientEncounter: {
            name: 'Complete Bundle Test Patient',
          },
          recording: {
            recording_file_name: 'default-recording.wav',
            recording_duration: 300,
            recording_file_size: 2400000,
            recording_file_path: '/test-recordings/default.wav',
          },
          note_text: 'This is a test note for the complete bundle test. Patient is doing well.',
          transcript: {
            transcript_text: 'Complete bundle test transcript line one. Line two.',
          },
        };

        if (!realRecordingPath) {
          console.log('⊘ Test 18: SKIPPED (No real recording files found in Supabase storage)\n');
        } else {
          // Update completeBundle with the real recording file for test 18
          completeBundle = {
            patientEncounter: {
              name: 'Complete Bundle Test Patient',
            },
            recording: {
              recording_file_name: realRecordingPath.split('/').pop(),
              recording_duration: 300,
              recording_file_size: 2400000,
              recording_file_path: realRecordingPath,
            },
            note_text: 'This is a test note for the complete bundle test. Patient is doing well.',
            transcript: {
              transcript_text: 'Complete bundle test transcript line one. Line two.',
            },
          };

          let completeBundleEncounterId = null;
          await runner.test('Test 18: Create complete patient encounter bundle (POST)', {
            testNumber: 18,
            method: 'POST',
            endpoint: '/api/patient-encounters/complete',
            body: completeBundle,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 201,
            expectedFields: ['patientEncounter', 'recording', 'note', 'transcript'],
            onSuccess: (data) => {
              // Extract and track the created encounter ID for dependent tests
              if (data.patientEncounter && data.patientEncounter.id) {
                completeBundleEncounterId = data.patientEncounter.id;
                createdEncounterIds.push(completeBundleEncounterId);
                console.log(`    Created complete bundle encounter ID: ${completeBundleEncounterId}`);
              }

              // Validate note was created and has proper fields
              if (!data.note) {
                console.log(`    ⚠️  Warning: POST response missing note field`);
              } else {
                console.log(`    ✅ POST response includes note with ID: ${data.note.id}`);
                console.log(`    📝 Note text: "${data.note.text}"`);
                console.log(`    🔗 Note linked to encounter ID: ${data.note.patientEncounter_id}`);

                // Check note doesn't have encryption fields (should be decrypted)
                const noteEncryptedFields = Object.keys(data.note).filter(k =>
                  k.includes('encrypted') || k.includes('iv')
                );
                if (noteEncryptedFields.length > 0) {
                  console.log(`    ⚠️  Note has encryption fields that should be cleaned: ${noteEncryptedFields.join(', ')}`);
                } else {
                  console.log(`    ✅ Note encryption fields properly cleaned`);
                }
              }

              if (!data.transcript) {
                console.log(`    ⚠️  Warning: POST response missing transcript field`);
              } else if (
                data.transcript.transcript_text !== 'Complete bundle test transcript line one. Line two.'
              ) {
                console.log(`    ⚠️  Transcript text mismatch after decrypt`);
              } else {
                console.log(`    ✅ POST response includes decrypted transcript`);
              }
            },
          });

          // ===== TEST 19: Get the created complete bundle (GET) =====
          if (completeBundleEncounterId) {
            await runner.test('Test 19: Get complete patient encounter bundle (verify creation)', {
              testNumber: 19,
              method: 'GET',
              endpoint: `/api/patient-encounters/complete/${completeBundleEncounterId}`,
              headers: {
                Authorization: `Bearer ${realAccessToken}`,
              },
              expectedStatus: 200,
              expectedFields: ['patientEncounter', 'recording', 'transcript', 'notes'],
              customValidator: (data) => {
                // Print full response for debugging
                console.log(`\n    📋 Full test 19 response:\n${JSON.stringify(data, null, 2)}\n`);

                // Check for encryption fields that should be cleaned
                if (data.patientEncounter) {
                  const encryptedFields = Object.keys(data.patientEncounter).filter(k =>
                    k.includes('encrypted') || k.includes('iv')
                  );
                  if (encryptedFields.length > 0) {
                    return { passed: false, message: `Patient encounter has encryption fields that should be cleaned: ${encryptedFields.join(', ')}` };
                  }
                }

                // Check for proper field names
                if (data.patientEncounter && !data.patientEncounter.name && data.patientEncounter.encrypted_name) {
                  return { passed: false, message: 'Found encrypted_name instead of name - decryption failed' };
                }

                // Validate notes array exists and contains the note we created
                if (!data.notes) {
                  return { passed: false, message: 'Missing notes array in response' };
                }

                if (!Array.isArray(data.notes)) {
                  return { passed: false, message: 'notes should be an array' };
                }

                // Should have at least one note (the one we created in test 18)
                if (data.notes.length === 0) {
                  return { passed: false, message: 'Expected at least one note in notes array (created in test 18)' };
                }

                // Check the first note has expected fields
                const firstNote = data.notes[0];
                if (!firstNote.text) {
                  return { passed: false, message: 'Note missing text field - decryption may have failed' };
                }

                if (firstNote.text !== 'This is a test note for the complete bundle test. Patient is doing well.') {
                  return { passed: false, message: `Note text mismatch. Expected: "This is a test note for the complete bundle test. Patient is doing well." Got: "${firstNote.text}"` };
                }

                // Check note encryption fields are cleaned
                if (firstNote.encrypted_text || firstNote.text_iv) {
                  return { passed: false, message: 'Note has encryption fields that should be cleaned' };
                }

                console.log(`    ✅ Found ${data.notes.length} note(s) with decrypted text`);

                if (!data.transcript) {
                  return { passed: false, message: 'Missing transcript in GET complete bundle' };
                }
                if (data.transcript.transcript_text !== 'Complete bundle test transcript line one. Line two.') {
                  return {
                    passed: false,
                    message: `Transcript text mismatch. Expected complete bundle test string, got: "${data.transcript.transcript_text}"`,
                  };
                }
                if (data.transcript.encrypted_transcript_text || data.transcript.iv) {
                  return { passed: false, message: 'Transcript should not expose ciphertext fields' };
                }

                // ===== STRICT VALIDATION: Signed URL Generation =====
                // Validate that the signed URL was generated and refreshed
                if (!data.recording) {
                  return { passed: false, message: 'Missing recording object' };
                }

                const recording = data.recording;

                // Check signed URL exists (should be auto-generated in Step 1.5)
                if (!recording.recording_file_signed_url) {
                  return { passed: false, message: 'Recording missing recording_file_signed_url (should be auto-generated in getCompletePatientEncounter)' };
                }

                // Check signed URL is valid for active storage backend (S3 or Supabase)
                if (!isValidDownloadSignedUrl(recording.recording_file_signed_url)) {
                  return {
                    passed: false,
                    message: `Signed URL does not match expected ${downloadSignedUrlFormatLabel(recording.recording_file_signed_url)} format (RECORDINGS_STORAGE_BACKEND=${process.env.RECORDINGS_STORAGE_BACKEND || 'supabase'})`,
                  };
                }

                // Check signed URL expiry exists and is valid
                if (!recording.recording_file_signed_url_expiry) {
                  return { passed: false, message: 'Recording missing recording_file_signed_url_expiry' };
                }

                // Check expiry is a valid ISO datetime
                const expiryDate = new Date(recording.recording_file_signed_url_expiry);
                if (isNaN(expiryDate.getTime())) {
                  return { passed: false, message: 'recording_file_signed_url_expiry is not a valid datetime' };
                }

                // Check expiry is in the future (allow 5 minute buffer for clock skew)
                const now = new Date();
                const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
                if (expiryDate < fiveMinutesAgo) {
                  return { passed: false, message: 'Signed URL expiry is too far in the past' };
                }

                console.log(`    ✅ Recording has valid signed URL and expiry (Step 1.5 working correctly)`);
                return { passed: true, message: 'All validations passed' };
              },
            });
          } else {
            console.log('⊘ Test 19: SKIPPED (test 18 dependency failed - no complete bundle encounter created)\n');
          }

          // ===== TEST 20: DELETE complete encounter (depends on test 19) =====
          if (completeBundleEncounterId) {
            await runner.test('Test 20: DELETE complete encounter (depends on test 19)', {
              testNumber: 20,
              method: 'DELETE',
              endpoint: `/api/patient-encounters/${completeBundleEncounterId}`,
              headers: {
                Authorization: `Bearer ${realAccessToken}`,
              },
              expectedStatus: 200,
            });
          } else {
            console.log('⊘ Test 20: SKIPPED (test 19 dependency failed - no complete bundle encounter created)\n');
          }

          // ===== TEST 21: Missing required field validation =====
          // Attempts to create bundle without patient name (required field)
          await runner.test('Test 21: Create complete encounter with missing patientEncounter.name (should fail)', {
            testNumber: 21,
            method: 'POST',
            endpoint: '/api/patient-encounters/complete',
            body: {
              patientEncounter: {
                // Missing required 'name' field
              },
              recording: {
                recording_file_name: 'test.wav',
                recording_duration: 300,
                recording_file_size: 2400000,
                recording_file_path: '/test-recordings/test.wav',
              },
              note_text: 'Test note text',
            },
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 400,
            validator: (data) => {
              if (!data.error) return { valid: false, reason: 'Missing error field' };
              // Check for error message about missing name
              const errorStr = JSON.stringify(data.error);
              if (!errorStr.includes('name')) return { valid: false, reason: 'Error message should mention name field' };
              return { valid: true };
            },
          });

          // ===== TEST 22: Missing note_text field =====
          // Attempts to create bundle without note_text field
          await runner.test('Test 22: Create complete encounter with missing note_text (should fail)', {
            testNumber: 22,
            method: 'POST',
            endpoint: '/api/patient-encounters/complete',
            body: {
              patientEncounter: {
                name: 'Missing Note Text Test',
              },
              recording: {
                recording_file_name: 'test.wav',
                recording_duration: 300,
                recording_file_size: 2400000,
                recording_file_path: '/test-recordings/test.wav',
              },
              // Missing note_text field
            },
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 400,
            validator: (data) => {
              if (!data.error) return { valid: false, reason: 'Missing error field' };
              // Check for error message about missing note_text
              const errorStr = JSON.stringify(data.error);
              if (!errorStr.includes('note_text')) return { valid: false, reason: 'Error message should mention note_text field' };
              return { valid: true };
            },
          });

          // ===== TEST 23: Auth required for POST =====
          // Attempts to create bundle without JWT token
          await runner.test('Test 23: Create complete encounter without auth (should fail)', {
            testNumber: 23,
            method: 'POST',
            endpoint: '/api/patient-encounters/complete',
            body: completeBundle,
            expectedStatus: 401,
          });

          // ===== TEST 24: Invalid ID format on GET =====
          await runner.test('Test 24: Get complete patient encounter (invalid ID format)', {
            testNumber: 24,
            method: 'GET',
            endpoint: '/api/patient-encounters/complete/invalid-format',
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 400,
            validator: (data) => {
              if (!data.error) return { valid: false, reason: 'Missing error field' };
              if (!data.error.includes('Invalid ID format')) return { valid: false, reason: 'Error should indicate invalid ID format' };
              return { valid: true };
            },
          });

          // ===== TEST 25: Non-existent encounter on GET =====
          await runner.test('Test 25: Get complete patient encounter (non-existent)', {
            testNumber: 25,
            method: 'GET',
            endpoint: '/api/patient-encounters/complete/999999999999',
            headers: {
              Authorization: `Bearer ${realAccessToken}`,
            },
            expectedStatus: 404,
          });

          // ===== TEST 26: Auth required for GET =====
          await runner.test('Test 26: Get complete patient encounter (no auth)', {
            testNumber: 26,
            method: 'GET',
            endpoint: '/api/patient-encounters/complete/test-id',
            expectedStatus: 401,
          });
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🧹 Test Suite Cleanup');
  console.log('═══════════════════════════════════════════════════════\n');

  if (realAccessToken && createdEncounterIds.length > 0) {
    await cleanupTestEncounters(realAccessToken);

    // Verify cleanup worked by checking final count
    try {
      const getFinalResponse = await fetch(`${runner.baseUrl}/api/patient-encounters`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
      });
      const finalCountData = await getFinalResponse.json();
      const suiteCountAfter = Array.isArray(finalCountData) ? finalCountData.length : 0;

      if (suiteCountBefore !== null) {
        console.log('  📊 Suite Encounter Count Verification:');
        console.log(`     Before suite: ${suiteCountBefore}`);
        console.log(`     After suite:  ${suiteCountAfter}`);
        if (suiteCountAfter === suiteCountBefore) {
          console.log('     ✅ Cleanup successful - count restored to original\n');
        } else {
          const orphanedCount = suiteCountAfter - suiteCountBefore;
          console.log(`     ❌ Cleanup FAILED - ${orphanedCount} test encounters still in database\n`);
          console.log('  🔧 Manually delete these test encounter IDs:\n');
          for (const id of createdEncounterIds) {
            console.log(`     - ${id}`);
          }
          console.log('\n  You can delete them by running:');
          console.log(`  curl -X DELETE http://localhost:3001/api/patient-encounters/{id} \\`);
          console.log(`    -H "Authorization: Bearer <access_token>"\n`);
        }
      }
    } catch (error) {
      console.log(`  ❌ Could not verify cleanup: ${error.message}\n`);
      console.log('  🔧 Manually delete these test encounter IDs:\n');
      for (const id of createdEncounterIds) {
        console.log(`     - ${id}`);
      }
      console.log('\n  You can delete them by running:');
      console.log(`  curl -X DELETE http://localhost:3001/api/patient-encounters/{id} \\`);
      console.log(`    -H "Authorization: Bearer <access_token>"\n`);
    }
  } else if (createdEncounterIds.length === 0) {
    console.log('  ℹ️  No test encounters to clean up\n');
  }

  // Print results
  runner.printResults();

  // Save results to file
  const resultsFile = runner.saveResults('patient-encounters-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);

  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runPatientEncounterTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

export { runPatientEncounterTests };
