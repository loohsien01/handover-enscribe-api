/**
 * Test Suite: Transcripts API
 * Tests all transcript CRUD operations: GET, POST, DELETE (PATCH disabled)
 * Requires: npm run test:setup (to create test data with recordings)
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

const runner = new TestRunner('Transcripts API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Load test data
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

    if (!testData.encounters || !testData.recordings) {
      throw new Error('Invalid test data structure');
    }

    return testData;
  } catch (error) {
    console.error('\n❌ Error reading test data:', error.message);
    console.error('Run setup first: npm run test:setup\n');
    process.exit(1);
  }
}

/**
 * Run all transcript CRUD tests
 */
async function runTranscriptsTests() {
  // Load test data first
  testData = loadTestData();

  // Track graceful error handling
  let gracefullyHandledCount = 0;
  const gracefullyHandledTests = [];

  console.log('Starting Transcripts API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);
  console.log('Test Data Loaded:');
  console.log(`  Encounters: ${testData.encounters.length}`);
  console.log(`  Recordings: ${testData.recordings.length}\n`);

  // Get valid access token from test account
  let accessToken = null;

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
        console.log('⚠️ Could not obtain access token from test account');
      }
    }
  }

  // Test 1: GET /transcripts without auth
  await runner.test('GET /api/transcripts without auth', {
    method: 'GET',
    endpoint: '/api/transcripts',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 2: GET /transcripts with invalid token
  await runner.test('GET /api/transcripts with invalid token', {
    method: 'GET',
    endpoint: '/api/transcripts',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
  });

  // Test 3: POST /transcripts without auth
  await runner.test('POST /api/transcripts without auth', {
    method: 'POST',
    endpoint: '/api/transcripts',
    body: {
      transcript_text: 'Test transcript',
      recording_id: 1,
    },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 4: POST /transcripts with invalid token
  await runner.test('POST /api/transcripts with invalid token', {
    method: 'POST',
    endpoint: '/api/transcripts',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    body: {
      transcript_text: 'Test transcript',
      recording_id: 1,
    },
    expectedStatus: 401,
  });

  // Test 5: POST /transcripts with missing fields
  if (accessToken) {
    await runner.test('POST /api/transcripts - missing transcript_text', {
      method: 'POST',
      endpoint: '/api/transcripts',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {
        recording_id: 1,
      },
      expectedStatus: 400,
      expectedFields: ['error'],
      validator: (data) => {
        if (!data.error) return { valid: false, reason: 'Missing error field' };
        if (data.error.name !== 'ZodError') return { valid: false, reason: `Expected ZodError, got ${data.error.name}` };
        if (!data.error.message.includes('transcript_text')) return { valid: false, reason: 'Error message should mention transcript_text field' };
        if (!data.error.message.includes('required')) return { valid: false, reason: 'Error message should mention required' };
        return { valid: true };
      },
    });
  }

  // Test 6: POST /transcripts with missing recording_id
  if (accessToken) {
    await runner.test('POST /api/transcripts - missing recording_id', {
      method: 'POST',
      endpoint: '/api/transcripts',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {
        transcript_text: 'Test transcript',
      },
      expectedStatus: 400,
      expectedFields: ['error'],
      validator: (data) => {
        if (!data.error) return { valid: false, reason: 'Missing error field' };
        if (data.error.name !== 'ZodError') return { valid: false, reason: `Expected ZodError, got ${data.error.name}` };
        if (!data.error.message.includes('recording_id')) return { valid: false, reason: 'Error message should mention recording_id field' };
        if (!data.error.message.includes('required')) return { valid: false, reason: 'Error message should mention required' };
        return { valid: true };
      },
    });
  }

  // Test 7: POST /transcripts with valid data (create for a recording without transcript)
  // Prefer live API state over testData.json IDs (recordings can be deleted between setup runs).
  let createdTranscriptId = null;
  let test7Passed = false;
  let test7Message = '';

  async function findRecordingWithoutTranscript(token) {
    const headers = { Authorization: `Bearer ${token}` };
    const [recordingsRes, transcriptsRes] = await Promise.all([
      fetch(`${runner.baseUrl}/api/recordings`, { headers }),
      fetch(`${runner.baseUrl}/api/transcripts`, { headers }),
    ]);
    if (!recordingsRes.ok || !transcriptsRes.ok) return null;

    const recordings = await recordingsRes.json();
    const transcripts = await transcriptsRes.json();
    const recordingIdsWithTranscript = new Set(
      transcripts.map((t) => Number(t.recording_id)).filter((id) => !Number.isNaN(id))
    );

    const attached = recordings
      .filter((r) => r.patientEncounter_id != null && r.id != null)
      .sort((a, b) => Number(b.id) - Number(a.id));

    return attached.find((r) => !recordingIdsWithTranscript.has(Number(r.id))) ?? null;
  }

  async function createAttachedRecordingForTranscript(token) {
    const encounter = testData.encounters?.find((e) => e.id != null);
    const unattached = testData.recordings?.find((r) => r.id == null && r.path);
    if (!encounter?.id || !unattached?.path) return null;

    const response = await fetch(`${runner.baseUrl}/api/recordings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        patientEncounter_id: Number(encounter.id),
        recording_file_path: unattached.path,
      }),
    });

    if (!response.ok) return null;
    const body = await response.json();
    const id = Number(body.id ?? body.data?.id);
    return Number.isNaN(id) ? null : { id };
  }

  if (accessToken && testData.recordings.length > 0) {
    let targetRecording = await findRecordingWithoutTranscript(accessToken);
    if (!targetRecording) {
      targetRecording = await createAttachedRecordingForTranscript(accessToken);
    }

    if (targetRecording?.id != null) {
      const result = await runner.test('POST /api/transcripts - create transcript', {
        method: 'POST',
        endpoint: '/api/transcripts',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: {
          transcript_text: 'This is a test transcript for the recording.',
          recording_id: Number(targetRecording.id),
        },
        expectedStatus: 201,
      });

      if (result.passed && result.body?.id) {
        createdTranscriptId = result.body.id;
        test7Passed = true;
        test7Message = `Created transcript with ID: ${createdTranscriptId}`;
        console.log(`    ✓ ${test7Message}`);
      } else {
        test7Message = `Expected 201, got ${result.status || 'unknown'}`;
      }
    } else {
      test7Message = 'No attached recording available without an existing transcript';
    }
  } else {
    test7Message = `Insufficient recordings in test data: have ${testData.recordings?.length ?? 0}`;
  }

  // Test 8: GET /transcripts/:id - get single transcript
  if (accessToken && createdTranscriptId) {
    const result = await runner.test('GET /api/transcripts/:id - get single transcript', {
      method: 'GET',
      endpoint: `/api/transcripts/${createdTranscriptId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });

    if (result.passed && result.body?.id === createdTranscriptId) {
      console.log(`    ✓ Retrieved transcript ${createdTranscriptId}`);
    }
  }

  // Test 9: GET /transcripts/:id - not found
  if (accessToken) {
    await runner.test('GET /api/transcripts/:id - not found', {
      method: 'GET',
      endpoint: '/api/transcripts/99999',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 404,
    });
  }

  // Test 10: GET /transcripts - list all
  if (accessToken) {
    const result = await runner.test('GET /api/transcripts - list all', {
      method: 'GET',
      endpoint: '/api/transcripts',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });

    if (result.passed && Array.isArray(result.body)) {
      console.log(`    ✓ Retrieved ${result.body.length} transcripts`);
    }
  }

  // PATCH tests - Transcripts can now be updated
  // Requires createdTranscriptId from Test 7 (POST /create transcript)
  // If Test 7 fails or is skipped, PATCH tests will be skipped as well

  // Test 11: PATCH /transcripts/:id without auth
  await runner.test('PATCH /api/transcripts/:id without auth', {
    method: 'PATCH',
    endpoint: '/api/transcripts/1',
    body: {
      transcript_text: 'Updated transcript text',
    },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 12: PATCH /transcripts/:id with invalid token
  await runner.test('PATCH /api/transcripts/:id with invalid token', {
    method: 'PATCH',
    endpoint: '/api/transcripts/1',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    body: {
      transcript_text: 'Updated transcript text',
    },
    expectedStatus: 401,
  });

  // Test 13: PATCH /transcripts/:id - missing transcript_text
  if (accessToken) {
    await runner.test('PATCH /api/transcripts/:id - missing transcript_text', {
      method: 'PATCH',
      endpoint: '/api/transcripts/1',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {},
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 14: PATCH /transcripts/:id - update transcript (DEPENDENT ON TEST 7)
  let test14Passed = false;
  let test14Message = '';
  if (!createdTranscriptId) {
    test14Message = '⚠️  SKIPPED: Test 7 failed, cannot test PATCH with real transcript';
  } else {
    const result = await runner.test('PATCH /api/transcripts/:id - update transcript', {
      method: 'PATCH',
      endpoint: `/api/transcripts/${createdTranscriptId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {
        transcript_text: 'Updated transcript text with more details.',
      },
      expectedStatus: 200,
    });

    if (result.passed && result.body?.id === createdTranscriptId) {
      test14Passed = true;
      test14Message = `Updated transcript ${createdTranscriptId}`;
    } else {
      test14Message = `Expected 200, got ${result.status || 'unknown'}`;
    }
  }

  runner.results.push({
    name: 'PATCH /api/transcripts/:id - update transcript',
    passed: test14Passed,
    endpoint: `/api/transcripts/${createdTranscriptId || '[id]'}`,
    method: 'PATCH',
    status: test14Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test14Message,
    testNumber: 14,
    timestamp: new Date().toISOString(),
  });

  const test14Result = test14Passed ? '✅' : (test14Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test14Result} Test 14: PATCH /api/transcripts/:id - update transcript`);
  console.log(`   ${test14Message}`);

  // Test 15: PATCH /transcripts/:id - not found
  if (accessToken) {
    await runner.test('PATCH /api/transcripts/:id - not found', {
      method: 'PATCH',
      endpoint: '/api/transcripts/99999',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {
        transcript_text: 'Update text',
      },
      expectedStatus: 404,
    });
  } else {
    runner.results.push({
      name: 'PATCH /api/transcripts/:id - not found',
      passed: false,
      endpoint: '/api/transcripts/99999',
      method: 'PATCH',
      status: null,
      expectedStatus: 404,
      body: {},
      customMessage: '⚠️  SKIPPED: Missing auth token',
      testNumber: 15,
      timestamp: new Date().toISOString(),
    });
    console.log('\n⚠️  Test 15: PATCH /api/transcripts/:id - not found');
    console.log('    ⚠️  SKIPPED: Missing auth token');
  }

  // Test 16: DELETE /transcripts/:id without auth
  if (createdTranscriptId) {
    await runner.test('DELETE /api/transcripts/:id without auth', {
      method: 'DELETE',
      endpoint: `/api/transcripts/${createdTranscriptId}`,
      expectedStatus: 401,
      expectedFields: ['error'],
    });
  }

  // Test 17: DELETE /transcripts/:id with invalid token
  if (createdTranscriptId) {
    await runner.test('DELETE /api/transcripts/:id with invalid token', {
      method: 'DELETE',
      endpoint: `/api/transcripts/${createdTranscriptId}`,
      headers: {
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
      expectedStatus: 401,
    });
  }

  // Test 18: DELETE /transcripts/:id - not found
  if (accessToken) {
    await runner.test('DELETE /api/transcripts/:id - not found', {
      method: 'DELETE',
      endpoint: '/api/transcripts/99999',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 404,
    });
  }

  // Test 19: DELETE /transcripts/:id - delete transcript (DEPENDENT ON TEST 7)
  let test19Passed = false;
  let test19Message = '';
  if (!createdTranscriptId) {
    test19Message = '⚠️  SKIPPED: Test 7 failed, cannot test DELETE with real transcript';
  } else {
    const result = await runner.test('DELETE /api/transcripts/:id - delete transcript', {
      method: 'DELETE',
      endpoint: `/api/transcripts/${createdTranscriptId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });

    if (result.passed && result.body?.success) {
      test19Passed = true;
      test19Message = `Deleted transcript ${createdTranscriptId}`;
    } else {
      test19Message = `Expected 200, got ${result.status || 'unknown'}`;
    }
  }

  runner.results.push({
    name: 'DELETE /api/transcripts/:id - delete transcript',
    passed: test19Passed,
    endpoint: `/api/transcripts/${createdTranscriptId || '[id]'}`,
    method: 'DELETE',
    status: test19Passed ? 200 : null,
    expectedStatus: 200,
    customMessage: test19Message,
    testNumber: 19,
    timestamp: new Date().toISOString(),
  });

  const test19Result = test19Passed ? '✅' : (test19Message.includes('SKIPPED') ? '⚠️ ' : '❌');
  console.log(`${test19Result} Test 19: DELETE /api/transcripts/:id - delete transcript`);
  console.log(`   ${test19Message}`);

  // Test 20: Verify deleted transcript is gone
  if (accessToken && createdTranscriptId) {
    await runner.test('GET /api/transcripts/:id - verify deleted', {
      method: 'GET',
      endpoint: `/api/transcripts/${createdTranscriptId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 404,
    });
  }

  // Print graceful error handling summary
  if (gracefullyHandledCount > 0) {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         GRACEFUL ERROR HANDLING SUMMARY                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`  Tests with graceful handling: ${gracefullyHandledCount}`);
    gracefullyHandledTests.forEach(test => {
      console.log(`    • ${test} - Recovered from duplicate key constraint`);
    });
    console.log('  Status: Subsequent tests continue with existing transcript\n');
  }

  // Summary
  runner.saveResults('transcripts-tests.json');
  runner.printResults();
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await runTranscriptsTests();
    } catch (error) {
      console.error('Test error:', error);
      process.exit(1);
    }
  })();
}

export { runTranscriptsTests };
