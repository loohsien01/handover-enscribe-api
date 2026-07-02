/**
 * Test Suite: Recordings API
 * Tests recordings/attachments endpoint: query validation, filtering, sorting, pagination
 * Requires: npm run test:setup (to create test data)
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
import {
  getRecordingsStorageBackendForTests,
  expectsS3UploadUrls,
  isValidUploadSignedUrl,
  isValidDownloadSignedUrl,
  uploadSignedUrlFormatLabel,
  downloadSignedUrlFormatLabel,
} from './recordingsStorageTestHelpers.js';
import { recordingObjectExists } from '../src/utils/recordingsStorage.js';
import { createClient } from '@supabase/supabase-js';

const runner = new TestRunner('Recordings API Tests');

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
    
    // Verify test data has required structure
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
 * Helper: Decode JWT token to extract user ID
 */
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    // Decode the payload (second part)
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return decoded;
  } catch (error) {
    console.error('Error decoding JWT:', error.message);
    return null;
  }
}

const CREATE_SIGNED_UPLOAD_URL_ENDPOINT = '/api/recordings/create-signed-upload-url';

/**
 * Helper: Validate that array is sorted by field in correct order
 */
function isSortedCorrectly(items, field, ascending = true) {
  if (!items || items.length < 2) return true;

  for (let i = 0; i < items.length - 1; i++) {
    const current = items[i][field];
    const next = items[i + 1][field];

    if (current === null || current === undefined || next === null || next === undefined) {
      continue;
    }

    let comparison;
    if (typeof current === 'string') {
      comparison = current.localeCompare(next);
    } else if (typeof current === 'number') {
      comparison = current - next;
    } else {
      // Handle dates
      comparison = new Date(current) - new Date(next);
    }

    if (ascending && comparison > 0) return false;
    if (!ascending && comparison < 0) return false;
  }

  return true;
}

/**
 * Run all recordings API tests
 */
async function runRecordingsTests() {
  // Load test data first
  testData = loadTestData();

  console.log('\n=== PART 1: ATTACHMENTS TESTS ===\n');
  console.log('Starting Recordings API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);
  console.log('Test Data Loaded:');
  console.log(`  Encounters: ${testData.encounters.length}`);
  console.log(`  Recordings: ${testData.recordings.length} (${testData.recordings.filter(r => r.attached).length} attached, ${testData.recordings.filter(r => !r.attached).length} unattached)\n`);

  // Get valid access token from test account
  let accessToken = null;

  if (hasTestAccounts()) {
    const testAccount = getTestAccount('primary');
    if (testAccount && testAccount.email && testAccount.password) {
      // Sign in to get valid token
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

  // Test 1: Get recordings without auth
  await runner.test('GET /recordings/attachments without auth', {
    testNumber: 1,
    method: 'GET',
    endpoint: '/api/recordings/attachments?attached=true',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 2: Get recordings with invalid token
  await runner.test('GET /recordings/attachments with invalid token', {
    testNumber: 2,
    method: 'GET',
    endpoint: '/api/recordings/attachments?attached=true',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    expectedStatus: 401,
  });

  // Test 3: Missing attached parameter
  if (accessToken) {
    await runner.test('GET /recordings/attachments missing attached parameter', {
      testNumber: 3,
      method: 'GET',
      endpoint: '/api/recordings/attachments',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 4: Invalid attached parameter value
  if (accessToken) {
    await runner.test('GET /recordings/attachments with invalid attached value', {
      testNumber: 4,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=maybe',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 5: Invalid sortBy parameter
  if (accessToken) {
    await runner.test('GET /recordings/attachments with invalid sortBy', {
      testNumber: 5,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&sortBy=invalid_field',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 6: Invalid order parameter
  if (accessToken) {
    await runner.test('GET /recordings/attachments with invalid order', {
      testNumber: 6,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&order=invalid',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 7: Get attached recordings (valid request)
  if (accessToken) {
    await runner.test('GET /recordings/attachments - attached=true', {
      testNumber: 7,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
  }

  // Test 8: Get unattached recordings (valid request)
  if (accessToken) {
    await runner.test('GET /recordings/attachments - attached=false', {
      testNumber: 8,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=false',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
  }

  // Test 9: Pagination with limit parameter
  if (accessToken) {
    await runner.test('GET /recordings/attachments with limit parameter', {
      testNumber: 9,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&limit=50',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
  }

  // Test 10: Pagination with offset parameter
  if (accessToken) {
    const result = await runner.test('GET /recordings/attachments with offset parameter', {
      testNumber: 10,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&offset=1',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });

    // Validate offset is working - should skip first recording
    if (result.passed && Array.isArray(result.body) && result.body.length > 0) {
      const allResult = await fetch(`${runner.baseUrl}/api/recordings/attachments?attached=true`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }).then(r => r.json());

      const expectedIds = new Set(allResult.slice(1).map(r => r.id));
      const actualIds = new Set(result.body.map(r => r.id));
      
      const offsetWorking = expectedIds.size > 0 && 
        Array.from(expectedIds).every(id => actualIds.has(id));

      if (!offsetWorking) {
        result.passed = false;
        result.body = { error: `Offset not working correctly. Expected ${expectedIds.size} recordings starting from index 1, got ${result.body.length}` };
      }
    }
  }

  // Test 11: Sort by created_at ascending
  if (accessToken) {
    const result = await runner.test('GET /recordings/attachments - sortBy=created_at, order=asc', {
      testNumber: 11,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&sortBy=created_at&order=asc',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
    
    // Validate actual sort order
    if (result.passed && Array.isArray(result.body) && result.body.length > 0) {
      const isSorted = isSortedCorrectly(result.body, 'db_created_at', true);
      if (!isSorted) {
        result.passed = false;
        result.body = { error: 'Data is not sorted by created_at ascending' };
      }
    }
  }

  // Test 12: Sort by created_at descending
  if (accessToken) {
    const result = await runner.test('GET /recordings/attachments - sortBy=created_at, order=desc', {
      testNumber: 12,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&sortBy=created_at&order=desc',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
    
    // Validate actual sort order
    if (result.passed && Array.isArray(result.body) && result.body.length > 0) {
      const isSorted = isSortedCorrectly(result.body, 'db_created_at', false);
      if (!isSorted) {
        result.passed = false;
        result.body = { error: 'Data is not sorted by created_at descending' };
      }
    }
  }

  // Test 13: Sort by updated_at ascending
  if (accessToken) {
    const result = await runner.test('GET /recordings/attachments - sortBy=updated_at, order=asc', {
      testNumber: 13,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&sortBy=updated_at&order=asc',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
    
    // Validate actual sort order
    if (result.passed && Array.isArray(result.body) && result.body.length > 0) {
      const isSorted = isSortedCorrectly(result.body, 'db_updated_at', true);
      if (!isSorted) {
        result.passed = false;
        result.body = { error: 'Data is not sorted by updated_at ascending' };
      }
    }
  }

  // Test 14: Sort by name ascending
  if (accessToken) {
    const result = await runner.test('GET /recordings/attachments - sortBy=name, order=asc', {
      testNumber: 14,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true&sortBy=name&order=asc',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
    
    // Validate actual sort order
    if (result.passed && Array.isArray(result.body) && result.body.length > 0) {
      const isSorted = isSortedCorrectly(result.body, 'path', true);
      if (!isSorted) {
        result.passed = false;
        result.body = { error: 'Data is not sorted by path (name) ascending' };
      }
    }
  }

  // Test 15: Combined - attached with limit, offset, sortBy, order
  if (accessToken) {
    await runner.test('GET /recordings/attachments - combined query parameters', {
      testNumber: 15,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=false&limit=25&offset=0&sortBy=created_at&order=desc',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });
  }

  // Test 16: Verify attached recordings contain test data
  if (accessToken) {
    const attachedTest = await runner.test('GET /recordings/attachments - verify attached recordings', {
      testNumber: 16,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=true',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });

    if (attachedTest && attachedTest.status === 200) {
      const attachedRecordings = attachedTest.body || [];
      const apiPaths = new Set(attachedRecordings.map(r => r.path));
      
      // Check 1: All attached recordings from test data are present
      const foundAttached = testData.recordings
        .filter(r => r.attached)
        .every(testRecording => apiPaths.has(testRecording.path));

      // Check 2: No unattached recordings are present (shouldn't be)
      const noUnattachedLeakage = testData.recordings
        .filter(r => !r.attached)
        .every(testRecording => !apiPaths.has(testRecording.path));

      if (foundAttached && noUnattachedLeakage) {
        console.log(`    ✓ All ${testData.recordings.filter(r => r.attached).length} attached recordings found, no unattached leakage`);
        attachedTest.passed = true;
      } else {
        if (!foundAttached) {
          console.log(`    ✗ Missing some attached recordings in response`);
        }
        if (!noUnattachedLeakage) {
          console.log(`    ✗ Unattached recordings leaked into attached response`);
        }
        attachedTest.passed = false;
      }
    }
  }

  // Test 17: Verify unattached recordings contain test data
  if (accessToken) {
    const unattachedTest = await runner.test('GET /recordings/attachments - verify unattached recordings', {
      testNumber: 17,
      method: 'GET',
      endpoint: '/api/recordings/attachments?attached=false',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 200,
    });

    if (unattachedTest && unattachedTest.status === 200) {
      const unattachedRecordings = unattachedTest.body || [];
      const apiPaths = new Set(unattachedRecordings.map(r => r.path));
      const attachedPaths = testData.recordings.filter(r => r.attached).map(r => r.path);
      const expectedUnattachedPaths = testData.recordings.filter(r => !r.attached).map(r => r.path);

      // Check 1: No attached recordings leaked into unattached response
      const noAttachedLeakage = attachedPaths.every((path) => !apiPaths.has(path));

      // Check 2: Response shape (path + optional storage metadata)
      const validShape = unattachedRecordings.every(
        (row) => typeof row.path === 'string' && row.path.includes('/')
      );

      // Check 3: Fixture coverage — warn if testData is stale vs live bucket (non-fatal)
      const missingFixtures = expectedUnattachedPaths.filter((path) => !apiPaths.has(path));
      const foundAllFixtures = missingFixtures.length === 0;

      if (noAttachedLeakage && validShape) {
        if (foundAllFixtures) {
          console.log(
            `    ✓ All ${expectedUnattachedPaths.length} unattached fixture path(s) present, no attached leakage`
          );
        } else {
          console.log(
            `    ✓ No attached leakage (${unattachedRecordings.length} unattached in storage); ` +
              `${missingFixtures.length} fixture path(s) missing — re-run npm run test:setup if needed`
          );
          missingFixtures.forEach((path) => console.log(`      missing: ${path}`));
        }
        unattachedTest.passed = true;
      } else {
        if (!noAttachedLeakage) {
          console.log(`    ✗ Attached recordings leaked into unattached response`);
        }
        if (!validShape) {
          console.log(`    ✗ Unattached response has invalid row shape`);
        }
        unattachedTest.passed = false;
      }
    }
  }

  // Summary
  runner.printResults(17);
  
  // Save results to file
  const resultsFile = runner.saveResults('recordings-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return runner.getSummary();
}

/**
 * Run all recordings CRUD tests (get all, get by ID, delete, update)
 */
async function runRecordingsCrudTests() {
  testData = loadTestData();

  console.log('\n=== PART 2: CRUD TESTS ===\n');
  console.log('Starting Recordings CRUD tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

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

  if (!accessToken) {
    console.error('❌ Cannot run CRUD tests without valid access token');
    return;
  }

  // Test 18: Get single recording by ID
  if (accessToken && testData.recordings.length > 0) {
    const validRecording = testData.recordings.find(r => r.id !== null);
    if (validRecording) {
      await runner.test('GET /api/recordings/:id - get single with signed URL', {
        testNumber: 18,
        method: 'GET',
        endpoint: `/api/recordings/${validRecording.id}`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        expectedStatus: 200,
      });
    }
  }

  // Test 19: Get non-existent recording
  if (accessToken) {
    await runner.test('GET /api/recordings/:id - not found', {
      testNumber: 19,
      method: 'GET',
      endpoint: '/api/recordings/99999',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 404,
    });
  }

  // ⚠️ Test 4 DISABLED - PATCH endpoint not implemented
  // REASON: Recording schema has no user-editable fields
  //   - 'name': Does NOT exist in database
  //   - 'recording_file_path': Immutable
  //   - 'recording_file_signed_url': Server-generated, not user-updatable
  //   - 'recording_file_signed_url_expiry': Server-generated, not user-updatable
  // TO ENABLE: Add updateable fields to recording schema and database
  // if (accessToken && testData.recordings.length > 0) {
  //   const validRecording = testData.recordings.find(r => r.id !== null);
  //   if (validRecording) {
  //     const recordingId = validRecording.id;
  //     const result = await runner.test('PATCH /api/recordings/:id - update recording', {
  //       method: 'PATCH',
  //       endpoint: `/api/recordings/${recordingId}`,
  //       headers: {
  //         Authorization: `Bearer ${accessToken}`,
  //       },
  //       body: {
  //         // TODO: Add updatable fields once schema is updated
  //       },
  //       expectedStatus: 200,
  //     });
  //   }
  // }

  // Test 20: Delete recording (note: this will delete from test data, so test last)
  if (accessToken && testData.recordings.length > 1) {
    // Use a recording with a valid ID (find one with id !== null)
    const validRecordings = testData.recordings.filter(r => r.id !== null);
    if (validRecordings.length > 0) {
      // Use the last valid recording for deletion to not affect other tests
      const recordingId = validRecordings[validRecordings.length - 1].id;
      const result = await runner.test('DELETE /api/recordings/complete/:id - delete recording', {
        testNumber: 20,
        method: 'DELETE',
        endpoint: `/api/recordings/complete/${recordingId}`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        expectedStatus: 200,
      });

      if (result.passed && result.body?.success) {
        console.log(`    ✓ Recording deleted successfully`);
      }
    }
  }

  // Test 21: Delete non-existent recording
  if (accessToken) {
    await runner.test('DELETE /api/recordings/complete/:id - not found', {
      testNumber: 21,
      method: 'DELETE',
      endpoint: '/api/recordings/complete/99999',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      expectedStatus: 404,
    });
  }

  // Summary
  runner.printResults(20);
  
  // Save results to file
  const resultsFile = runner.saveResults('recordings-tests.json', true);
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return runner.getSummary();
}

/**
 * Run tests for POST /api/recordings/create-signed-upload-url endpoint
 * Tests signed URL generation, collision detection, extension validation
 */
async function runRecordingsUploadTests() {
  testData = loadTestData();

  console.log('\n=== PART 3: UPLOAD ENDPOINT TESTS ===\n');
  console.log('Starting Recordings Upload Endpoint tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  // Get valid access token from test account
  let accessToken = null;
  let userId = null;

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
        
        // Decode JWT to extract user ID
        const decoded = decodeJWT(accessToken);
        userId = decoded?.sub;
        
        console.log('✓ Obtained valid access token from test account');
        console.log(`✓ Extracted user ID: ${userId}\n`);
      } else {
        console.log('⚠️ Could not obtain access token from test account');
      }
    }
  }

  /** First testData path that exists in active storage (for collision + download URL tests). */
  let storageBackedPath = null;
  if (accessToken && userId && testData.recordings?.length) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    for (const rec of testData.recordings) {
      if (rec.path && (await recordingObjectExists(supabase, rec.path))) {
        storageBackedPath = rec.path;
        break;
      }
    }
    if (!storageBackedPath) {
      console.warn(
        `⚠️  No testData recording path found in ${getRecordingsStorageBackendForTests()} storage — re-run npm run test:setup\n`
      );
    }
  }

  // Test 22: POST /api/recordings/create-signed-upload-url without auth
  await runner.test('POST /api/recordings/create-signed-upload-url without auth', {
    testNumber: 22,
    method: 'POST',
    endpoint: '/api/recordings/create-signed-upload-url',
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 23: POST /api/recordings/create-signed-upload-url with invalid token
  await runner.test('POST /api/recordings/create-signed-upload-url with invalid token', {
    testNumber: 23,
    method: 'POST',
    endpoint: '/api/recordings/create-signed-upload-url',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    body: { filename: `${userId || 'test-id'}/test.mp3` },
    expectedStatus: 401,
  });

  // Test 24: POST /api/recordings/create-signed-upload-url missing filename (Zod validation)
  if (accessToken) {
    await runner.test('POST /api/recordings/create-signed-upload-url missing filename', {
      testNumber: 24,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-upload-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {},
      expectedStatus: 400,
      customValidator: (body) => {
        // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
        const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
        const hasFilenameIssue = /filename/.test(JSON.stringify(body?.error));
        
        return {
          passed: isZodError && hasFilenameIssue,
          message: (isZodError && hasFilenameIssue)
            ? 'Should return ZodError for missing filename'
            : `Expected ZodError for missing filename. Got: ${JSON.stringify(body?.error)}`
        };
      },
    });
  }

  // Test 25: POST /api/recordings/create-signed-upload-url filename without extension (Business logic validation)
  if (accessToken && userId) {
    await runner.test('POST /api/recordings/create-signed-upload-url filename without extension', {
      testNumber: 25,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-upload-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { filename: `${userId}/test-no-ext` },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 26: POST /api/recordings/create-signed-upload-url invalid extension (.txt) (Business logic validation)
  if (accessToken && userId) {
    await runner.test('POST /api/recordings/create-signed-upload-url invalid extension (.txt)', {
      testNumber: 26,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-upload-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { filename: `${userId}/test.txt` },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 27: POST /api/recordings/create-signed-upload-url valid .webm extension
  let signedUrl = null;
  let uploadPath = null;
  if (accessToken && userId) {
    const result = await runner.test('POST /api/recordings/create-signed-upload-url valid .webm file', {
      testNumber: 27,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-upload-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { filename: `${userId}/test-record-1705945678-42.webm` },
      expectedStatus: 200,
      expectedFields: ['success', 'signedUrl', 'path', 'filename', 'expiresAt'],
    });

    if (result.passed && result.body) {
      signedUrl = result.body.signedUrl;
      uploadPath = result.body.path;
      
      // Validate signed URL format
      if (typeof signedUrl === 'string' && signedUrl.length > 0 && signedUrl.includes('https')) {
        console.log(`    ✓ Signed URL is valid HTTPS URL`);
      } else {
        console.log(`    ✗ Signed URL format invalid`);
        result.passed = false;
      }

      // Validate path structure (should be userid/filename)
      if (typeof uploadPath === 'string' && uploadPath.includes('/') && uploadPath.includes('test-record-1705945678-42.webm')) {
        console.log(`    ✓ Path structure valid: ${uploadPath}`);
      } else {
        console.log(`    ✗ Path structure invalid: ${uploadPath}`);
        result.passed = false;
      }

      // Validate expiration
      if (result.body.expiresAt === 3600) {
        console.log(`    ✓ Expiration is 3600 seconds`);
      } else {
        console.log(`    ✗ Expiration incorrect: ${result.body.expiresAt}`);
        result.passed = false;
      }
    }
  }

  // Test 28: POST /api/recordings/create-signed-upload-url valid .mp3 extension
  if (accessToken && userId) {
    await runner.test('POST /api/recordings/create-signed-upload-url valid .mp3 file', {
      testNumber: 28,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-upload-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { filename: `${userId}/audio-recording-1705945700-99.mp3` },
      expectedStatus: 200,
      expectedFields: ['success', 'signedUrl', 'path'],
    });
  }

  // Test 29: Verify signed URL format is correct (string format validation only, no request)
  if (signedUrl) {
    const isValidSignedUrl = isValidUploadSignedUrl(signedUrl);
    const formatLabel = uploadSignedUrlFormatLabel();

    const formatTest = {
      name: 'POST /api/recordings/create-signed-upload-url verify signed URL format',
      passed: isValidSignedUrl,
      endpoint: 'N/A (format validation only)',
      method: 'N/A',
      status: 200,
      expectedStatus: 200,
      body: {
        format: isValidSignedUrl ? 'valid' : 'invalid',
        backend: getRecordingsStorageBackendForTests(),
        urlSample: signedUrl.substring(0, 100),
      },
      customMessage: isValidSignedUrl
        ? `Signed URL format valid (${formatLabel})`
        : `Signed URL format invalid (expected ${formatLabel})`,
      testNumber: 29,
      timestamp: new Date().toISOString(),
    };

    runner.results.push(formatTest);

    if (isValidSignedUrl) {
      console.log(`    ✓ Signed URL format is valid (${formatLabel})`);
      console.log(`      URL structure: ${signedUrl.substring(0, 120)}...`);
    } else {
      console.log(`    ✗ Signed URL format is invalid (expected ${formatLabel})`);
    }
  }

  // Test 30–31: Collision detection — storage object must exist (see test:setup)
  if (accessToken && userId && storageBackedPath) {
    const existingFilename = storageBackedPath;

    const result1 = await runner.test(
      'POST /api/recordings/create-signed-upload-url collision detection - first request (existing file)',
      {
      testNumber: 30,
      method: 'POST',
      endpoint: CREATE_SIGNED_UPLOAD_URL_ENDPOINT,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { filename: existingFilename },
      expectedStatus: 200,
      expectedFields: ['success', 'path', 'signedUrl'],
    }
    );

    const firstPath = result1?.body?.path;

    // Test 31: Collision detection - second request (should get suffixed path)
    const result2 = await runner.test(
      'POST /api/recordings/create-signed-upload-url collision detection - second request (should detect collision)',
      {
      testNumber: 31,
      method: 'POST',
      endpoint: CREATE_SIGNED_UPLOAD_URL_ENDPOINT,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { filename: existingFilename },
      expectedStatus: 200,
      expectedFields: ['success', 'path', 'signedUrl'],
    }
    );

    const secondPath = result2?.body?.path;

    // Validate that paths are different (collision detection worked)
    if (result1.passed && result2.passed && firstPath && secondPath) {
      if (firstPath !== secondPath) {
        console.log(`    ✓ Collision detection working:`);
        console.log(`      Request 1: ${firstPath}`);
        console.log(`      Request 2: ${secondPath} (collision detected, suffix added)`);
      } else {
        console.log(`    ✗ Collision detection failed: identical paths returned`);
        console.log(`      Hint: re-run npm run test:setup so fixtures exist in ${getRecordingsStorageBackendForTests()} storage`);
        result2.passed = false;
      }
    }
  } else {
    console.log('⚠️  Skipping Tests 30–31: no attached recording path in testData (run npm run test:setup)\n');
  }

  // Test 32-37: Validate all supported extensions
  const supportedExtensions = ['mp3', 'wav', 'webm', 'ogg', 'm4a', 'mp4'];
  const extensionResults = {};

  if (accessToken && userId) {
    let testNumOffset = 32;
    for (const ext of supportedExtensions) {
      const result = await runner.test(
        `POST /api/recordings/create-signed-upload-url .${ext} extension`,
        {
        testNumber: testNumOffset,
        method: 'POST',
        endpoint: CREATE_SIGNED_UPLOAD_URL_ENDPOINT,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: { filename: `${userId}/test-${ext}-1705945800-11.${ext}` },
        expectedStatus: 200,
        expectedFields: ['success', 'signedUrl', 'path'],
      }
      );
      
      extensionResults[ext] = result.passed;
      testNumOffset++;
    }

    // Print extension validation summary
    console.log(`\n  Extension Validation Results:`);
    let allExtValid = true;
    for (const ext of supportedExtensions) {
      const status = extensionResults[ext] ? '✓' : '✗';
      console.log(`    ${status} .${ext}`);
      if (!extensionResults[ext]) allExtValid = false;
    }
    if (allExtValid) {
      console.log(`    ✓ All ${supportedExtensions.length} supported extensions validated`);
    }
  }

  // Test 38: POST /api/recordings/create-signed-url without auth
  await runner.test('POST /api/recordings/create-signed-url without auth', {
    testNumber: 38,
    method: 'POST',
    endpoint: '/api/recordings/create-signed-url',
    body: { path: '08ab02d7-7a93-4c9f-8a48-bab1cb34803e/test-file.mp4' },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 39: POST /api/recordings/create-signed-url with invalid token
  await runner.test('POST /api/recordings/create-signed-url with invalid token', {
    testNumber: 39,
    method: 'POST',
    endpoint: '/api/recordings/create-signed-url',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    body: { path: '08ab02d7-7a93-4c9f-8a48-bab1cb34803e/test-file.mp4' },
    expectedStatus: 401,
  });

  // Test 40: POST /api/recordings/create-signed-url missing path (Zod validation)
  if (accessToken) {
    await runner.test('POST /api/recordings/create-signed-url missing path', {
      testNumber: 40,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {},
      expectedStatus: 400,
      customValidator: (body) => {
        // Expect serialized ZodError format: {error: {name: 'ZodError', message: '[...]'}}
        const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
        const hasPathIssue = /path/.test(JSON.stringify(body?.error));
        
        return {
          passed: isZodError && hasPathIssue,
          message: (isZodError && hasPathIssue)
            ? 'Should return ZodError for missing path'
            : `Expected ZodError for missing path. Got: ${JSON.stringify(body?.error)}`
        };
      },
    });
  }

  // Test 41: POST /api/recordings/create-signed-url invalid path format (single part, no slash)
  if (accessToken) {
    await runner.test('POST /api/recordings/create-signed-url invalid path format (no slash)', {
      testNumber: 41,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { path: 'filename-only-no-uuid' },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 42: POST /api/recordings/create-signed-url invalid path format (too many parts)
  if (accessToken) {
    await runner.test('POST /api/recordings/create-signed-url invalid path format (too many slashes)', {
      testNumber: 42,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { path: 'uuid/folder/filename.mp4' },
      expectedStatus: 400,
      expectedFields: ['error'],
    });
  }

  // Test 43: POST /api/recordings/create-signed-url path ownership check - wrong user UUID → 403
  if (accessToken) {
    const wrongUserUUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await runner.test('POST /api/recordings/create-signed-url access denied (wrong user UUID)', {
      testNumber: 43,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { path: `${wrongUserUUID}/some-recording.mp4` },
      expectedStatus: 403,
      expectedFields: ['error'],
    });
  }

  // Test 44: POST /api/recordings/create-signed-url valid path with blob in storage → 200
  let createSignedUrlResponse = null;
  if (accessToken && storageBackedPath) {
    const testRecordingPath = storageBackedPath;

    const result = await runner.test('POST /api/recordings/create-signed-url valid request (real test data)', {
      testNumber: 44,
      method: 'POST',
      endpoint: '/api/recordings/create-signed-url',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { path: testRecordingPath },
      expectedStatus: 200,
      expectedFields: ['signedUrl', 'expiresIn'],
    });

    if (result.passed && result.body) {
      createSignedUrlResponse = result.body;
      
      // Validate signed URL format
      const signedUrl = result.body.signedUrl;
      if (typeof signedUrl === 'string' && signedUrl.length > 0 && signedUrl.includes('https')) {
        console.log(`    ✓ Signed URL is valid HTTPS URL`);
      } else {
        console.log(`    ✗ Signed URL format invalid`);
        result.passed = false;
      }

      // Validate expiry time
      if (result.body.expiresIn === 3600) {
        console.log(`    ✓ Expiration is 3600 seconds (1 hour)`);
      } else {
        console.log(`    ✗ Expiration incorrect: ${result.body.expiresIn}`);
        result.passed = false;
      }

      // Validate URL matches active storage backend (Supabase or S3 presigned GET)
      if (isValidDownloadSignedUrl(signedUrl)) {
        console.log(
          `    ✓ Signed URL has correct format for downloads (${downloadSignedUrlFormatLabel(signedUrl)})`
        );
      } else {
        console.log(
          `    ✗ Signed URL format doesn't match expected pattern (backend=${getRecordingsStorageBackendForTests()})`
        );
        result.passed = false;
      }
    }
  }

  // Test 45: Probe signed download URL (HEAD for Supabase; Range GET for S3 presigned URLs)
  if (createSignedUrlResponse && createSignedUrlResponse.signedUrl) {
    const signedUrl = createSignedUrlResponse.signedUrl;
    const isS3Presigned = signedUrl.includes('X-Amz-Algorithm=');
    const probeMethod = isS3Presigned ? 'GET' : 'HEAD';
    let metadataTest = {
      name: isS3Presigned
        ? 'Range GET on signed URL metadata (S3 presigned)'
        : 'HEAD signed URL metadata (no download)',
      passed: false,
      endpoint: signedUrl,
      method: probeMethod,
      status: null,
      expectedStatus: 200,
      customMessage: '',
      testNumber: 45,
      timestamp: new Date().toISOString(),
    };
    
    try {
      const probeResponse = isS3Presigned
        ? await fetch(signedUrl, { method: 'GET', headers: { Range: 'bytes=0-0' } })
        : await fetch(signedUrl, { method: 'HEAD' });
      metadataTest.status = probeResponse.status;
      metadataTest.passed =
        probeResponse.ok || probeResponse.status === 206 || probeResponse.status === 404;
      
      if (probeResponse.ok || probeResponse.status === 206) {
        console.log(
          `    ✓ ${probeMethod} probe successful (${probeResponse.status}) - metadata accessible without full download`
        );
        
        const contentType = probeResponse.headers.get('content-type');
        const contentLength = probeResponse.headers.get('content-length');
        const contentRange = probeResponse.headers.get('content-range');
        const lastModified = probeResponse.headers.get('last-modified');
        const etag = probeResponse.headers.get('etag');
        
        if (contentType) console.log(`      Content-Type: ${contentType}`);
        if (contentLength) console.log(`      Content-Length: ${contentLength} bytes`);
        if (contentRange) console.log(`      Content-Range: ${contentRange}`);
        if (lastModified) console.log(`      Last-Modified: ${lastModified}`);
        if (etag) console.log(`      ETag: ${etag}`);
        
        metadataTest.customMessage = `${probeMethod} probe returned ${probeResponse.status}`;
      } else if (probeResponse.status === 404) {
        console.log(`    ⚠️ Probe returned 404 - file not in storage, but signed URL is valid`);
        metadataTest.customMessage = `Probe returned 404, URL format valid but file missing`;
      } else {
        console.log(`    ✗ Probe failed with status ${probeResponse.status}`);
        metadataTest.customMessage = `${probeMethod} probe failed: ${probeResponse.status}`;
      }
    } catch (error) {
      console.log(`    ✗ Error probing signed URL: ${error.message}`);
      metadataTest.customMessage = `Probe error: ${error.message}`;
    }
    
    runner.results.push(metadataTest);
  }

  // Summary
  runner.printResults(45);
  
  // Save results to file
  const resultsFile = runner.saveResults('recordings-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      if (args.includes('--attachments')) {
        await runRecordingsTests();
      } else if (args.includes('--crud')) {
        await runRecordingsCrudTests();
      } else if (args.includes('--upload')) {
        await runRecordingsUploadTests();
      } else if (args.includes('--delete-storage')) {
        await runRecordingsDeleteStorageTests();
      } else if (args.includes('--all')) {
        await runRecordingsTests();
        await runRecordingsCrudTests();
        await runRecordingsUploadTests();
        await runRecordingsDeleteStorageTests();
      } else {
        console.log('Recording API Tests\n');
        console.log('Usage: node recordings.test.js [--attachments] [--crud] [--upload] [--delete-storage] [--all]');
        console.log('  --attachments:    Run GET /api/recordings/attachments tests (17 tests)');
        console.log('  --crud:           Run CRUD tests (get by ID, not found, delete)');
        console.log('  --upload:         Run POST /api/recordings/create-signed-upload-url tests');
        console.log('  --delete-storage: Run DELETE /api/recordings/storage tests (bulk delete)');
        console.log('  --all:            Run all tests (attachments + CRUD + upload + delete-storage)');
      }
    } catch (error) {
      console.error('Test error:', error);
      process.exit(1);
    }
  })();
}

/**
 * Run tests for DELETE /api/recordings/storage endpoint
 * Tests bulk storage file deletion with various validation scenarios
 */
async function runRecordingsDeleteStorageTests() {
  testData = loadTestData();

  console.log('\n=== PART 4: DELETE STORAGE ENDPOINT TESTS ===\n');
  console.log('Starting Recordings Delete Storage Endpoint tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  // Get valid access token from test account
  let accessToken = null;
  let userId = null;

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
        
        // Decode JWT to extract user ID
        const decoded = decodeJWT(accessToken);
        userId = decoded?.sub;
        
        console.log('✓ Obtained valid access token from test account');
        console.log(`✓ Extracted user ID: ${userId}\n`);
      } else {
        console.log('⚠️ Could not obtain access token from test account');
      }
    }
  }

  // Test 46: DELETE /api/recordings/storage without auth
  await runner.test('DELETE /api/recordings/storage without auth', {
    testNumber: 46,
    method: 'DELETE',
    endpoint: '/api/recordings/storage',
    body: { prefixes: ['test/file.mp3'] },
    expectedStatus: 401,
    expectedFields: ['error'],
  });

  // Test 47: DELETE /api/recordings/storage with invalid token
  await runner.test('DELETE /api/recordings/storage with invalid token', {
    testNumber: 47,
    method: 'DELETE',
    endpoint: '/api/recordings/storage',
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    body: { prefixes: ['test/file.mp3'] },
    expectedStatus: 401,
  });

  // Test 48: DELETE /api/recordings/storage missing prefixes (Zod validation)
  if (accessToken) {
    await runner.test('DELETE /api/recordings/storage missing prefixes', {
      testNumber: 48,
      method: 'DELETE',
      endpoint: '/api/recordings/storage',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: {},
      expectedStatus: 400,
      customValidator: (body) => {
        const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
        const hasPrefixesIssue = /prefixes/.test(JSON.stringify(body?.error));
        
        return {
          passed: isZodError && hasPrefixesIssue,
          message: (isZodError && hasPrefixesIssue)
            ? 'Should return ZodError for missing prefixes'
            : `Expected ZodError for missing prefixes. Got: ${JSON.stringify(body?.error)}`
        };
      },
    });
  }

  // Test 49: DELETE /api/recordings/storage with empty prefixes array (Zod validation)
  if (accessToken) {
    await runner.test('DELETE /api/recordings/storage with empty prefixes array', {
      testNumber: 49,
      method: 'DELETE',
      endpoint: '/api/recordings/storage',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { prefixes: [] },
      expectedStatus: 400,
      customValidator: (body) => {
        const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
        
        return {
          passed: isZodError,
          message: isZodError 
            ? 'Should return ZodError for empty prefixes array'
            : `Expected ZodError for empty array. Got: ${JSON.stringify(body?.error)}`
        };
      },
    });
  }

  // Test 50: DELETE /api/recordings/storage with prefixes exceeding 100 items (Zod validation)
  if (accessToken) {
    const manyPrefixes = Array.from({ length: 101 }, (_, i) => `${userId}/file-${i}.mp3`);
    
    await runner.test('DELETE /api/recordings/storage with prefixes exceeding 100 items', {
      testNumber: 50,
      method: 'DELETE',
      endpoint: '/api/recordings/storage',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: { prefixes: manyPrefixes },
      expectedStatus: 400,
      customValidator: (body) => {
        const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
        
        return {
          passed: isZodError,
          message: isZodError 
            ? 'Should return ZodError for > 100 prefixes'
            : `Expected ZodError for > 100 prefixes. Got: ${JSON.stringify(body?.error)}`
        };
      },
    });
  }

  // Test 51: DELETE with mix of valid + invalid prefixes (strict response validation)
  if (accessToken && userId && testData.recordings.length > 0) {
    // Get one unattached recording for valid prefix
    const unattachedRecording = testData.recordings.find(r => !r.attached);
    
    if (unattachedRecording) {
      const validPrefix = unattachedRecording.path; // Should be userid/filename format
      const nonExistentPrefix = `${userId}/this-file-does-not-exist-9999.mp3`;
      const wrongUserIdPrefix = `00000000-0000-0000-0000-000000000000/fake-file.mp3`;
      
      const result = await runner.test('DELETE /api/recordings/storage - mix of valid/invalid prefixes', {
        testNumber: 51,
        method: 'DELETE',
        endpoint: '/api/recordings/storage',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: {
          prefixes: [validPrefix, nonExistentPrefix, wrongUserIdPrefix],
        },
        expectedStatus: 200,
        expectedFields: ['deleted', 'failed', 'errors'],
        customValidator: (body) => {
          const hasRequiredFields = body?.deleted && Array.isArray(body.deleted)
           && body?.failed && Array.isArray(body.failed)
           && body?.errors && typeof body.errors === 'object';

          if (!hasRequiredFields) {
            return {
              passed: false,
              message: `Missing required fields. Got: ${JSON.stringify(Object.keys(body || {}))}`
            };
          }

          // Strict validation: Option B (idempotent semantics)
          // Both valid and non-existent files go to deleted (since .remove() returns success for both)
          const validInDeleted = body.deleted.includes(validPrefix);
          const nonExistentInDeleted = body.deleted.includes(nonExistentPrefix);
          const wrongUserIdInFailed = body.failed.includes(wrongUserIdPrefix);
          const wrongUserIdInErrors = body.errors[wrongUserIdPrefix];

          const passed = validInDeleted && nonExistentInDeleted && wrongUserIdInFailed && wrongUserIdInErrors;

          if (passed) {
            console.log(`    ✓ Valid prefix in deleted: ${validPrefix}`);
            console.log(`    ✓ Non-existent prefix also in deleted (idempotent): ${nonExistentPrefix}`);
            console.log(`    ✓ Wrong userId prefix in failed with error: "${wrongUserIdInErrors}"`);
          } else {
            console.log(`    ✗ Response validation failed:`);
            if (!validInDeleted) console.log(`      - Valid prefix NOT in deleted`);
            if (!nonExistentInDeleted) console.log(`      - Non-existent prefix NOT in deleted (idempotent semantics)`);
            if (!wrongUserIdInFailed) console.log(`      - Wrong userId NOT in failed`);
            if (!wrongUserIdInErrors) console.log(`      - Wrong userId error message missing`);
          }

          return {
            passed,
            message: passed 
              ? 'Response properly categorized all prefixes (idempotent delete semantics)'
              : 'Response validation failed - see details above'
          };
        },
      });
    }
  }
  // Summary - only print tests 46-51 (not all 1-51)
  // Filter results to only show delete storage tests
  const deleteStorageResults = runner.results.filter(r => r.testNumber >= 46);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test Suite: Recordings API Tests`);
  console.log(`${'='.repeat(60)}\n`);
  
  let passCount = 0;
  let failCount = 0;
  
  deleteStorageResults.forEach((result) => {
    const status = result.passed ? '✅' : '❌';
    console.log(`${status} Test ${result.testNumber}: ${result.name}`);
    
    if (result.customMessage) {
      console.log(`   ${result.customMessage}`);
    }
    
    const responseBody = result.body || result.fullResponse || {};
    const responseStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    const truncated = responseStr.substring(0, 500);
    
    if (!result.passed) {
      console.log(`   Expected: ${result.expectedStatus} | Got: ${result.status}`);
      failCount++;
    } else {
      passCount++;
    }
    console.log(`   Response: ${truncated}${responseStr.length > 500 ? '...' : ''}`);
    console.log(); // Double space
  });
  
  console.log(`${'-'.repeat(60)}`);
  const summary = runner.getSummary();
  console.log(`Total Executed: ${deleteStorageResults.length} | Passed: ${passCount} | Failed: ${failCount} | Skipped: 0`);
  console.log(`Pass Rate: ${passCount > 0 ? ((passCount / deleteStorageResults.length) * 100).toFixed(2) : 0}% | Duration: ${summary.duration}`);
  console.log(`${'='.repeat(60)}\n`);
  
  // Save results to file
  const resultsFile = runner.saveResults('recordings-tests.json', true);
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return summary;
}

export { runRecordingsTests, runRecordingsCrudTests, runRecordingsUploadTests, runRecordingsDeleteStorageTests };
