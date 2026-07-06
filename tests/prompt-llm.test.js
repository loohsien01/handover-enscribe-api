/**
 * Test Suite: OpenAI Prompt-LLM API (SOAP Note Generation)
 * 
 * Tests the SOAP note and billing generation pipeline via job-based polling:
 * - Authentication validation
 * - Request validation (recording_file_path required)
 * - Job creation and asynchronous processing (test 4) - reused for dependent tests
 * - SOAP note structure validation
 * - Special character normalization
 * 
 * Architecture: POST /api/jobs/prompt-llm/generate-note (202) → GET /api/jobs/prompt-llm/:jobId (poll)
 * Polling: 10s initial, exponential backoff to 45s on HTTP error, 10min timeout
 * 
 * - Pre-visit summary enqueue validation (3a–3d, no Bedrock)
 * - Test 4 optionally passes pre_visit_summary_id through full Bedrock pipeline
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
import { getTestAccount, hasTestAccounts, checkRedisReachableForTests } from './testConfig.js';
import { getSupabasePostgresUrl } from '../src/utils/supabasePostgresUrl.js';
import {
  closeSupabasePostgresPool,
  querySupabasePostgres,
} from '../src/utils/supabasePostgresPool.js';

const runner = new TestRunner('OpenAI Prompt-LLM API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Skip Test 5 by default (run only when explicitly enabled), since it's identical to Test 4 just using  fallback template (don't pass noteTemplate_id)
const skipTest5 = true;

// Load test data
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');
let testData = null;
let cachedSoapResponse = null; // Cache SOAP response from test 4 (custom template) for reuse
let cachedFallbackResponse = null; // Cache SOAP response from test 5 (fallback template) for reuse

function loadTestData() {
  if (!fs.existsSync(TEST_DATA_FILE)) {
    console.error('\n❌ Test data file not found!');
    console.error('Run setup first: npm run test:setup\n');
    process.exit(1);
  }

  try {
    const data = fs.readFileSync(TEST_DATA_FILE, 'utf-8');
    testData = JSON.parse(data);
    
    if (!testData.recordings) {
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
 * Helper: Make HTTP request with simple JSON response
 */
async function makeRequest(method, endpoint, body, headers = {}) {
  const url = `${runner.baseUrl}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : null,
    });

    const text = await response.text();
    let jsonBody = {};
    try {
      jsonBody = text ? JSON.parse(text) : {};
    } catch {
      // Keep empty if not JSON
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers || []),
      body: jsonBody,
      ok: response.ok,
      rawText: text,
    };
  } catch (error) {
    return {
      status: null,
      headers: {},
      body: {},
      ok: false,
      rawText: null,
      error: error.message,
      isNetworkError: true,
    };
  }
}

const UNKNOWN_PRE_VISIT_SUMMARY_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function hasPostgresForTests() {
  try {
    return Boolean(getSupabasePostgresUrl());
  } catch {
    return false;
  }
}

/**
 * @param {string} accessToken
 * @param {string} text
 * @param {string} [title]
 */
async function createNovaChatAndPreVisitSummary(accessToken, text, title) {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const chatRes = await makeRequest('POST', '/api/nova/chat-sessions', {}, authHeaders);
  if (!chatRes.ok || chatRes.status !== 201 || !chatRes.body?.chatId) {
    return { ok: false, error: `Nova chat create failed: HTTP ${chatRes.status}` };
  }

  const body = { chat_id: chatRes.body.chatId, text };
  if (title) body.title = title;

  const summaryRes = await makeRequest('POST', '/api/pre-visit-summaries', body, authHeaders);
  if (!summaryRes.ok || summaryRes.status !== 201 || !summaryRes.body?.id) {
    return { ok: false, error: `Pre-visit summary create failed: HTTP ${summaryRes.status}` };
  }

  return {
    ok: true,
    chatId: chatRes.body.chatId,
    preVisitSummaryId: summaryRes.body.id,
    preVisitSummary: summaryRes.body,
  };
}

/**
 * Returns: { jobId, finalStatus, transcript_text, soap_note_text, soap_note, error_message, elapsed }
 */
async function pollJobUntilComplete(jobId, accessToken, maxWaitMs = 600000) {
  const startTime = Date.now();
  let pollInterval = 10000; // Start at 10s
  const backoffCap = 45000; // Cap at 45s
  let lastStatus = null;
  const statusTransitions = [];

  while (Date.now() - startTime < maxWaitMs) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    
    // Poll for status
    const response = await makeRequest('GET', `/api/jobs/prompt-llm/${jobId}`, null, {
      Authorization: `Bearer ${accessToken}`,
    });

    if (!response.ok) {
      // HTTP error - use exponential backoff
      if (response.isNetworkError || response.status >= 500) {
        pollInterval = Math.min(pollInterval * 2, backoffCap);
        console.log(`   [${elapsed}s] HTTP ${response.status || 'error'} - backing off to ${pollInterval / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      } else {
        // Client error (4xx) - fail immediately
        return {
          jobId,
          finalStatus: 'error',
          error_message: `Poll failed: HTTP ${response.status}`,
          elapsed,
          pollingFailed: true,
        };
      }
    }

    const job = response.body;
    if (!job || !job.status) {
      console.log(`   [${elapsed}s] Invalid response structure`);
      pollInterval = Math.min(pollInterval * 2, backoffCap);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      continue;
    }

    // Log status transition
    if (job.status !== lastStatus) {
      statusTransitions.push({ status: job.status, elapsed });
      console.log(`   [${elapsed}s] ${lastStatus || 'pending'} → ${job.status}`);
      lastStatus = job.status;
      pollInterval = 10000; // Reset to 10s on status change
    }

    // Check if done
    if (job.status === 'complete') {
      // Fetch full result with parsed SOAP
      const resultResponse = await makeRequest('GET', `/api/jobs/prompt-llm/${jobId}?includeResult=true`, null, {
        Authorization: `Bearer ${accessToken}`,
      });

      if (!resultResponse.ok) {
        const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
        return {
          jobId,
          finalStatus: 'complete',
          error_message: `Failed to fetch result: HTTP ${resultResponse.status}`,
          elapsed: finalElapsed,
          resultFetchFailed: true,
        };
      }

      const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
      return {
        jobId,
        finalStatus: 'complete',
        transcript_text: resultResponse.body.transcript_text,
        soap_note_text: resultResponse.body.soap_note_text,
        soap_note: resultResponse.body.soap_note,
        pre_visit_summary_id: resultResponse.body.pre_visit_summary_id ?? null,
        elapsed: finalElapsed,
        statusTransitions,
      };
    } else if (job.status === 'error') {
      const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
      return {
        jobId,
        finalStatus: 'error',
        error_message: job.error_message || 'Unknown error',
        elapsed: finalElapsed,
        statusTransitions,
      };
    }

    // Still pending/processing - wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  // Timeout
  const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
  return {
    jobId,
    finalStatus: 'timeout',
    error_message: `Job did not complete within ${maxWaitMs / 1000}s`,
    elapsed: finalElapsed,
    statusTransitions,
    timedOut: true,
  };
}

/**
 * Validate SOAP note structure
 */
function validateSoapStructure(soapResponse) {
  const requiredSubjective = ["Chief complaint", "HPI", "History", "ROS", "Medications", "Allergies"];
  const requiredObjective = ["HEENT", "General", "Cardiovascular", "Musculoskeletal", "Other"];
  
  if (!soapResponse?.soap_note) {
    return { valid: false, message: 'Missing soap_note object' };
  }
  
  const sn = soapResponse.soap_note;
  
  // Check subjective
  if (!sn.subjective || typeof sn.subjective !== 'object') {
    return { valid: false, message: 'Invalid or missing subjective object' };
  }
  
  for (const key of requiredSubjective) {
    if (typeof sn.subjective[key] !== 'string') {
      return { valid: false, message: `Missing or invalid subjective.${key}` };
    }
  }
  
  // Check objective
  if (!sn.objective || typeof sn.objective !== 'object') {
    return { valid: false, message: 'Invalid or missing objective object' };
  }
  
  for (const key of requiredObjective) {
    if (typeof sn.objective[key] !== 'string') {
      return { valid: false, message: `Missing or invalid objective.${key}` };
    }
  }
  
  // Check assessment and plan
  if (typeof sn.assessment !== 'string') {
    return { valid: false, message: 'Missing or invalid assessment' };
  }
  
  if (typeof sn.plan !== 'string') {
    return { valid: false, message: 'Missing or invalid plan' };
  }
  
  // Check billing
  if (!soapResponse?.billing || typeof soapResponse.billing !== 'object') {
    return { valid: false, message: 'Missing or invalid billing object' };
  }
  
  const bill = soapResponse.billing;
  if (!Array.isArray(bill.icd10_codes) || bill.icd10_codes.length === 0) {
    return { valid: false, message: 'Invalid or missing icd10_codes' };
  }
  
  if (typeof bill.billing_code !== 'string' || !bill.billing_code.length) {
    return { valid: false, message: 'Missing or invalid billing_code' };
  }
  
  if (typeof bill.additional_inquiries !== 'string') {
    return { valid: false, message: 'Missing or invalid additional_inquiries' };
  }
  
  return { valid: true, message: 'SOAP structure is valid' };
}

/**
 * Run all prompt-llm tests
 */
async function runAllPromptLlmTests() {
  testData = loadTestData();

  console.log('Starting OpenAI Prompt-LLM API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  // Get real access token if test account is configured
  let accessToken = null;
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
          accessToken = signInResponse.token.access_token;
          console.log(`✅ Obtained real access token from test account: ${testAccount.email}\n`);
        } else {
          console.error('❌ Sign-in response missing access token:', signInResponse);
        }
      } catch (error) {
        console.error('❌ Could not get real token:', error.message, '\n');
      }
    } else {
      console.error('❌ Test account missing email or password');
    }
  } else {
    console.error('❌ Test credentials not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
  }

  if (!accessToken) {
    console.error('❌ No access token available. Cannot run tests.\n');
    process.exit(1);
  }

  // Get a recording to test with
  // Recording index 2 is attached to patient encounter "Charlie" (created during setup)
  const recordingIndex = 2; // Recording 3 (0-indexed) - attached to Charlie
  const recording = testData.recordings[recordingIndex];
  if (!recording) {
    console.error(`❌ No recording at index ${recordingIndex} in test data.\n`);
    process.exit(1);
  }

  console.log(`Test Recording: ${recording.path} (${recording.attached ? `attached to encounter ${recording.encounterId}` : 'unattached'})\n`);

  // Test 1: Missing authentication
  await runner.test('Missing Authentication Header', {
    method: 'POST',
    endpoint: '/api/jobs/prompt-llm/generate-note',
    body: { recording_file_path: recording.path },
    expectedStatus: 401,
    customValidator: (body) => {
      // Auth errors caught by middleware, handled by global error handler
      return {
        passed: body?.error !== undefined && body.error.includes('JWT'),
        message: body?.error || 'Should return 401 without auth token'
      };
    },
    testNumber: 1,
  });

  // Test 2: Invalid authentication token
  await runner.test('Invalid Authentication Token', {
    method: 'POST',
    endpoint: '/api/jobs/prompt-llm/generate-note',
    body: { recording_file_path: recording.path },
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    expectedStatus: 401,
    customValidator: (body) => {
      // Auth errors caught by middleware, handled by global error handler
      return {
        passed: body?.error !== undefined && body.error.includes('token'),
        message: body?.error || 'Should return 401 with invalid token'
      };
    },
    testNumber: 2,
  });

  // Test 3: Missing recording_file_path
  await runner.test('Missing recording_file_path Parameter', {
    method: 'POST',
    endpoint: '/api/jobs/prompt-llm/generate-note',
    body: {},
    headers: { Authorization: `Bearer ${accessToken}` },
    expectedStatus: 400,
    customValidator: (body) => {
      // Expect Zod error object in body.error
      const isZodError = body?.error?.name === 'ZodError' && body?.error?.message;
      // Check message contains both "invalid_type" and "recording_file_path" (handles newlines)
      const message = body?.error?.message || '';
      const hasRecordingPathIssue = message.includes('invalid_type') && message.includes('recording_file_path');
      
      return {
        passed: isZodError && hasRecordingPathIssue,
        message: (isZodError && hasRecordingPathIssue)
          ? 'Should return ZodError for missing recording_file_path'
          : `Invalid error format. Got: ${JSON.stringify(body?.error)}`
      };
    },
    testNumber: 3,
  });

  // --- Pre-visit summary + generate-note (no Bedrock) ---
  const redisCheck = await checkRedisReachableForTests();
  if (!redisCheck.ok) {
    console.warn(`\n⚠️  Skipping Tests 3a–3d (pre-visit enqueue): ${redisCheck.message}\n`);
  } else {

    await runner.test('Invalid pre_visit_summary_id format', {
      method: 'POST',
      endpoint: '/api/jobs/prompt-llm/generate-note',
      body: { recording_file_path: recording.path, pre_visit_summary_id: 'not-a-uuid' },
      headers: { Authorization: `Bearer ${accessToken}` },
      expectedStatus: 400,
      customValidator: (body) => ({
        passed: body?.error?.name === 'ZodError',
        message: body?.error?.name === 'ZodError' ? '' : 'expected ZodError for invalid UUID',
      }),
      testNumber: '3a',
    });

    await runner.test('Unknown pre_visit_summary_id returns 404', {
      method: 'POST',
      endpoint: '/api/jobs/prompt-llm/generate-note',
      body: {
        recording_file_path: recording.path,
        pre_visit_summary_id: UNKNOWN_PRE_VISIT_SUMMARY_ID,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
      expectedStatus: 404,
      customValidator: (body) => ({
        passed: body?.code === 'PRE_VISIT_SUMMARY_NOT_FOUND',
        message:
          body?.code === 'PRE_VISIT_SUMMARY_NOT_FOUND'
            ? ''
            : `expected PRE_VISIT_SUMMARY_NOT_FOUND, got ${body?.code}`,
      }),
      testNumber: '3b',
    });

    const prepForEnqueue = await createNovaChatAndPreVisitSummary(
      accessToken,
      'Enqueue test: metformin 500mg, patient Jane Doe.',
      'Jane Doe F/U'
    );

    if (!prepForEnqueue.ok) {
      runner.results.push({
        name: 'Create job with pre_visit_summary_id echoes id on poll (pending)',
        passed: false,
        endpoint: '/api/jobs/prompt-llm/generate-note',
        method: 'POST → GET',
        status: null,
        expectedStatus: 202,
        body: {},
        customMessage: prepForEnqueue.error,
        testNumber: '3c',
        timestamp: new Date().toISOString(),
      });
      console.log(`\n❌ Test 3c: skipped — ${prepForEnqueue.error}`);
    } else {
      const createWithPrep = await makeRequest(
        'POST',
        '/api/jobs/prompt-llm/generate-note',
        {
          recording_file_path: recording.path,
          pre_visit_summary_id: prepForEnqueue.preVisitSummaryId,
        },
        { Authorization: `Bearer ${accessToken}` }
      );

      let test3cPassed = false;
      let test3cMessage = '';
      if (createWithPrep.status !== 202 || !createWithPrep.body?.id) {
        test3cMessage = `Expected 202 with job id, got HTTP ${createWithPrep.status}`;
      } else {
        const pollRes = await makeRequest(
          'GET',
          `/api/jobs/prompt-llm/${createWithPrep.body.id}`,
          null,
          { Authorization: `Bearer ${accessToken}` }
        );
        if (
          pollRes.ok &&
          pollRes.body?.pre_visit_summary_id === prepForEnqueue.preVisitSummaryId
        ) {
          test3cPassed = true;
          test3cMessage = 'Job poll includes pre_visit_summary_id while still pending/running';
        } else {
          test3cMessage = `Poll missing pre_visit_summary_id (got ${pollRes.body?.pre_visit_summary_id})`;
        }
      }

      runner.results.push({
        name: 'Create job with pre_visit_summary_id echoes id on poll (pending)',
        passed: test3cPassed,
        endpoint: '/api/jobs/prompt-llm/generate-note',
        method: 'POST → GET',
        status: createWithPrep.status,
        expectedStatus: 202,
        body: createWithPrep.body,
        customMessage: test3cMessage,
        testNumber: '3c',
        timestamp: new Date().toISOString(),
      });
      console.log(`\n${test3cPassed ? '✅' : '❌'} Test 3c: ${test3cMessage}`);
    }

    if (!hasPostgresForTests()) {
      console.warn('\n⚠️  Skipping Test 3d (409 already linked): Postgres URL not configured\n');
      runner.results.push({
        name: 'Already-linked pre_visit_summary_id returns 409',
        passed: true,
        endpoint: '/api/jobs/prompt-llm/generate-note',
        method: 'POST',
        status: null,
        expectedStatus: 409,
        body: {},
        customMessage: 'SKIPPED: no Postgres URL for seeding patientEncounter_id',
        testNumber: '3d',
        timestamp: new Date().toISOString(),
      });
    } else if (!recording.encounterId) {
      console.warn('\n⚠️  Skipping Test 3d: test recording has no encounterId\n');
    } else {
      const prepLinked = await createNovaChatAndPreVisitSummary(
        accessToken,
        'Already linked prep row.',
        'Linked Prep'
      );
      let test3dPassed = false;
      let test3dMessage = '';
      if (!prepLinked.ok) {
        test3dMessage = prepLinked.error;
      } else {
        try {
          await querySupabasePostgres(
            `UPDATE public.pre_visit_summaries
                SET "patientEncounter_id" = $1, updated_at = NOW()
              WHERE id = $2`,
            [recording.encounterId, prepLinked.preVisitSummaryId]
          );
          const conflictRes = await makeRequest(
            'POST',
            '/api/jobs/prompt-llm/generate-note',
            {
              recording_file_path: recording.path,
              pre_visit_summary_id: prepLinked.preVisitSummaryId,
            },
            { Authorization: `Bearer ${accessToken}` }
          );
          if (
            conflictRes.status === 409 &&
            conflictRes.body?.code === 'PRE_VISIT_SUMMARY_ALREADY_LINKED'
          ) {
            test3dPassed = true;
            test3dMessage = '409 PRE_VISIT_SUMMARY_ALREADY_LINKED when patientEncounter_id set';
          } else {
            test3dMessage = `Expected 409 PRE_VISIT_SUMMARY_ALREADY_LINKED, got HTTP ${conflictRes.status} code=${conflictRes.body?.code}`;
          }
        } catch (err) {
          test3dMessage = `Postgres seed failed: ${err?.message || err}`;
        } finally {
          await closeSupabasePostgresPool().catch(() => {});
        }
      }
      runner.results.push({
        name: 'Already-linked pre_visit_summary_id returns 409',
        passed: test3dPassed,
        endpoint: '/api/jobs/prompt-llm/generate-note',
        method: 'POST',
        status: null,
        expectedStatus: 409,
        body: {},
        customMessage: test3dMessage,
        testNumber: '3d',
        timestamp: new Date().toISOString(),
      });
      console.log(`\n${test3dPassed ? '✅' : '❌'} Test 3d: ${test3dMessage}`);
    }
  }

  // Pre-visit summary for Test 4 Bedrock E2E (reuse transcript dedup from 3c job if any)
  let test4PreVisitSummaryId = null;
  if (redisCheck.ok) {
    const prepE2e = await createNovaChatAndPreVisitSummary(
      accessToken,
      'E2E prep: Patient Jane Doe, metformin 500mg, lisinopril 10mg. F/U hypertension.',
      'Jane Doe F/U E2E'
    );
    if (prepE2e.ok) {
      test4PreVisitSummaryId = prepE2e.preVisitSummaryId;
      console.log(`\n✓ Test 4 will use pre_visit_summary_id=${test4PreVisitSummaryId}\n`);
    } else {
      console.warn(`\n⚠️  Test 4 will run without pre_visit_summary_id: ${prepE2e.error}\n`);
    }
  }

  // Test 4: REAL call - Generate SOAP note via job-based polling with standard note template (PRIMARY TEST)
  console.log('\n⏳ Test 4 will create a job with standard note template (ID: 33) and poll until complete (max 10 minutes)...\n');
  console.log('   Process: Audio → Transcribe (Deepgram) → Expand dot phrases → Mask PHI (AWS) → Fetch Template → LLM Generate note\n');
  
  // Create job with noteTemplate_id parameter (+ optional pre_visit_summary_id for E2E)
  const test4RequestBody = {
    recording_file_path: recording.path,
    noteTemplate_id: '33',
  };
  if (test4PreVisitSummaryId) {
    test4RequestBody.pre_visit_summary_id = test4PreVisitSummaryId;
  }

  const createResponse = await makeRequest(
    'POST',
    '/api/jobs/prompt-llm/generate-note',
    test4RequestBody,
    { Authorization: `Bearer ${accessToken}` }
  );

  let test4Passed = false;
  let test4Message = '';
  let jobId = null;

  if (!createResponse.ok || createResponse.status !== 202) {
    test4Message = `Failed to create job: HTTP ${createResponse.status}`;
  } else if (!createResponse.body?.id) {
    test4Message = 'Job creation response missing job ID';
  } else {
    jobId = createResponse.body.id;
    console.log(`✅ Job created: ${jobId}`);
    console.log('⏳ Polling (10s initial interval, exponential backoff to 45s cap)...');

    // Poll until complete
    const pollResult = await pollJobUntilComplete(jobId, accessToken);

    if (pollResult.timedOut) {
      test4Message = `Job polling timed out after ${pollResult.elapsed}s`;
    } else if (pollResult.pollingFailed || pollResult.resultFetchFailed) {
      test4Message = pollResult.error_message;
    } else if (pollResult.finalStatus === 'error') {
      test4Message = `Job failed: ${pollResult.error_message}`;
    } else if (pollResult.finalStatus === 'complete') {
      if (!pollResult.soap_note) {
        test4Message = 'Job completed but parsed SOAP note is missing';
      } else if (
        test4PreVisitSummaryId &&
        pollResult.pre_visit_summary_id !== test4PreVisitSummaryId
      ) {
        test4Message = `Expected pre_visit_summary_id=${test4PreVisitSummaryId} on poll, got ${pollResult.pre_visit_summary_id}`;
      } else {
        // Parse soap_note if it's a string
        let parsedSoapNote = pollResult.soap_note;
        if (typeof pollResult.soap_note === 'string') {
          try {
            parsedSoapNote = JSON.parse(pollResult.soap_note);
          } catch (err) {
            test4Message = `Failed to parse SOAP note JSON: ${err.message}`;
          }
        }
        
        if (!test4Message) {
          cachedSoapResponse = {
            soap_note: parsedSoapNote.soap_note,
            transcript_text: pollResult.transcript_text,
            soap_note_text: pollResult.soap_note_text,
            billing: parsedSoapNote.billing,
          };
          test4Passed = true;
          const prepNote = test4PreVisitSummaryId
            ? `; pre_visit_summary_id=${test4PreVisitSummaryId} on poll`
            : '';
          test4Message = `Completed in ${pollResult.elapsed}s${prepNote}`;
        }
      }
    } else {
      test4Message = `Unexpected final status: ${pollResult.finalStatus}`;
    }
  }

  runner.results.push({
    name: 'Generate SOAP Note from Recording with Custom Note Template (Job-Based Polling)',
    passed: test4Passed,
    endpoint: '/api/jobs/prompt-llm/generate-note',
    method: 'POST → GET (polling)',
    status: createResponse.status,
    expectedStatus: 202,
    body: createResponse.body,
    requestBody: test4RequestBody,
    customMessage: test4Message,
    testNumber: 4,
    timestamp: new Date().toISOString(),
  });

  const test4Result = test4Passed ? '✅' : '❌';
  console.log(`\n${test4Result} Test 4: Generate SOAP Note from Recording with Custom Note Template (Job-Based Polling)`);
  console.log(`   ${test4Message}`);

  // Test 5: Generate SOAP note via job-based polling WITHOUT noteTemplate_id (uses fallback schema) - SKIPPED BY DEFAULT
  if (!skipTest5) {
    console.log('\n⏳ Test 5 will create a job WITHOUT noteTemplate_id (fallback schema) and poll until complete (max 10 minutes)...\n');
    console.log('   Process: Audio → Transcribe (Deepgram) → Expand dot phrases → Mask PHI (AWS) → LLM Generate note (fixed schema)\n');
    
    // Create job WITHOUT noteTemplate_id parameter
    const createResponse5 = await makeRequest('POST', '/api/jobs/prompt-llm/generate-note',
      { recording_file_path: recording.path },
      { Authorization: `Bearer ${accessToken}` }
    );

    let test5Passed = false;
    let test5Message = '';
    let jobId5 = null;

    if (!createResponse5.ok || createResponse5.status !== 202) {
      test5Message = `Failed to create job: HTTP ${createResponse5.status}`;
    } else if (!createResponse5.body?.id) {
      test5Message = 'Job creation response missing job ID';
    } else {
      jobId5 = createResponse5.body.id;
      console.log(`✅ Job created: ${jobId5}`);
      console.log('⏳ Polling (10s initial interval, exponential backoff to 45s cap)...');

      // Poll until complete
      const pollResult5 = await pollJobUntilComplete(jobId5, accessToken);

      if (pollResult5.timedOut) {
        test5Message = `Job polling timed out after ${pollResult5.elapsed}s`;
      } else if (pollResult5.pollingFailed || pollResult5.resultFetchFailed) {
        test5Message = pollResult5.error_message;
      } else if (pollResult5.finalStatus === 'error') {
        test5Message = `Job failed: ${pollResult5.error_message}`;
      } else if (pollResult5.finalStatus === 'complete') {
        if (!pollResult5.soap_note) {
          test5Message = 'Job completed but parsed SOAP note is missing';
        } else {
          // Parse soap_note if it's a string
          let parsedSoapNote5 = pollResult5.soap_note;
          if (typeof pollResult5.soap_note === 'string') {
            try {
              parsedSoapNote5 = JSON.parse(pollResult5.soap_note);
            } catch (err) {
              test5Message = `Failed to parse SOAP note JSON: ${err.message}`;
            }
          }
          
          if (!test5Message) {
            cachedFallbackResponse = {
              soap_note: parsedSoapNote5.soap_note,
              transcript_text: pollResult5.transcript_text,
              soap_note_text: pollResult5.soap_note_text,
              billing: parsedSoapNote5.billing,
            };
            test5Passed = true;
            test5Message = `Completed in ${pollResult5.elapsed}s`;
          }
        }
      } else {
        test5Message = `Unexpected final status: ${pollResult5.finalStatus}`;
      }
    }

    runner.results.push({
      name: 'Generate SOAP Note from Recording with Fallback Schema (Job-Based Polling)',
      passed: test5Passed,
      endpoint: '/api/jobs/prompt-llm/generate-note',
      method: 'POST → GET (polling)',
      status: createResponse5.status,
      expectedStatus: 202,
      body: createResponse5.body,
      requestBody: { recording_file_path: recording.path },
      customMessage: test5Message,
      testNumber: 5,
      timestamp: new Date().toISOString(),
    });

    const test5Result = test5Passed ? '✅' : '❌';
    console.log(`\n${test5Result} Test 5: Generate SOAP Note from Recording with Fallback Schema (Job-Based Polling)`);
    console.log(`   ${test5Message}`);
  } else {
    console.log('\n⏭️  Test 5: SKIPPED BY DEFAULT (set skipTest5 = false to enable)');
  }

  // Test 6: Validate SOAP Structure (inline validation - dependent on test 5)
  let test6Passed = false;
  let test6Message = '';
  if (!cachedFallbackResponse) {
    test6Message = '⚠️  SKIPPED: Test 5 failed or was skipped, cannot validate SOAP structure';
  } else {
    try {
      // Response.soap_note is already parsed by jobController using parseSoapNotes()
      if (!cachedFallbackResponse.soap_note || typeof cachedFallbackResponse.soap_note !== 'object') {
        test6Message = 'Missing or invalid soap_note object';
      } else {
        const sn = cachedFallbackResponse.soap_note;
        
        // Check subjective with required fields
        if (!sn.subjective || typeof sn.subjective !== 'object') {
          test6Message = 'Missing or invalid subjective object';
        } else {
          const subjReq = ['Chief complaint', 'HPI', 'History', 'ROS', 'Medications', 'Allergies'];
          for (const key of subjReq) {
            if (!(key in sn.subjective) || typeof sn.subjective[key] !== 'string') {
              test6Message = `subjective missing or invalid: ${key}`;
              break;
            }
          }
        }
        
        // Check objective with required fields
        if (!test6Message && (!sn.objective || typeof sn.objective !== 'object')) {
          test6Message = 'Missing or invalid objective object';
        } else if (!test6Message) {
          const objReq = ['HEENT', 'General', 'Cardiovascular', 'Musculoskeletal', 'Other'];
          for (const key of objReq) {
            if (!(key in sn.objective) || typeof sn.objective[key] !== 'string') {
              test6Message = `objective missing or invalid: ${key}`;
              break;
            }
          }
        }
        
        // Check assessment and plan
        if (!test6Message && typeof sn.assessment !== 'string') {
          test6Message = 'assessment must be a string';
        } else if (!test6Message && typeof sn.plan !== 'string') {
          test6Message = 'plan must be a string';
        }
        
        // Check billing
        if (!test6Message && (!cachedFallbackResponse.billing || typeof cachedFallbackResponse.billing !== 'object')) {
          test6Message = 'Missing or invalid billing object';
        } else if (!test6Message) {
          const bill = cachedFallbackResponse.billing;
          if (!Array.isArray(bill.icd10_codes) || bill.icd10_codes.length === 0) {
            test6Message = 'icd10_codes must be non-empty array';
          } else if (typeof bill.billing_code !== 'string' || !bill.billing_code.length) {
            test6Message = 'billing_code must be non-empty string';
          } else if (typeof bill.additional_inquiries !== 'string') {
            test6Message = 'additional_inquiries must be string';
          }
        }
        
        if (!test6Message) {
          test6Passed = true;
          test6Message = 'SOAP note structure is valid and matches schema';
        }
      }
    } catch (err) {
      test6Message = `Validation error: ${err.message}`;
    }
  }
  
  // Only run Test 6 if Test 5 was actually executed
  if (!skipTest5) {
    runner.results.push({
      name: 'Validate SOAP Note Structure (from cached response)',
      passed: test6Passed,
      endpoint: '/api/jobs/prompt-llm/generate-note',
      method: 'GET (dependent on Test 5)',
      status: null,
      expectedStatus: null,
      body: cachedFallbackResponse || {},
      customMessage: test6Message,
      testNumber: 6,
      timestamp: new Date().toISOString(),
    }); 
    
    const test6Result = test6Passed ? '✅' : '⚠️ ';
    console.log(`\n${test6Result} Test 6: Validate SOAP Note Structure`);
    console.log(`   ${test6Message}`);
  }

  // Test 7: Verify Special Character Handling (inline validation - dependent on test 4)
  let test7Passed = false;
  let test7Message = '';
  if (!cachedSoapResponse) {
    test7Message = '⚠️  SKIPPED: Test 4 failed, cannot verify special character handling';
  } else {
    const soapText = JSON.stringify(cachedSoapResponse);
    
    // These are the problematic characters that cleanRawText should have replaced
    const problematicChars = {
      '\u2022': 'bullet (U+2022)',
      '\u2023': 'triangular bullet (U+2023)',
      '\u25E6': 'white bullet (U+25E6)',
      '\u2043': 'hyphen bullet (U+2043)',
      '\u2026': 'ellipsis (U+2026)',
      '\u22EF': 'midline ellipsis (U+22EF)',
      '\u22EE': 'vertical ellipsis (U+22EE)',
      '\u00A0': 'non-breaking space (U+00A0)',
      '–': 'en-dash',
      '—': 'em-dash',
      '≤': 'less than or equal',
      '≥': 'greater than or equal',
      '×': 'multiplication sign',
      '½': 'fraction one-half',
      '⅓': 'fraction one-third',
      '⅔': 'fraction two-thirds',
      '¼': 'fraction one-quarter',
      '¾': 'fraction three-quarters',
      '⅕': 'fraction one-fifth',
      '⅖': 'fraction two-fifths',
      '⅗': 'fraction three-fifths',
      '⅘': 'fraction four-fifths',
      '⅙': 'fraction one-sixth',
      '⅚': 'fraction five-sixths',
      '²': 'superscript 2',
      '³': 'superscript 3',
      '⁰': 'superscript 0',
      '¹': 'superscript 1',
      '⁴': 'superscript 4',
      '⁵': 'superscript 5',
      '⁶': 'superscript 6',
      '⁷': 'superscript 7',
      '⁸': 'superscript 8',
      '⁹': 'superscript 9',
      '→': 'rightwards arrow',
      '←': 'leftwards arrow',
      '↑': 'upwards arrow',
      '↓': 'downwards arrow',
      '∞': 'infinity symbol',
      '≈': 'approximately equals',
    };
    
    const foundProblematic = [];
    for (const [char, desc] of Object.entries(problematicChars)) {
      if (soapText.includes(char)) {
        foundProblematic.push(`${desc} (${char})`);
      }
    }
    
    if (foundProblematic.length > 0) {
      test7Message = `Found unclean special characters: ${foundProblematic.slice(0, 3).join(', ')}${foundProblematic.length > 3 ? ` +${foundProblematic.length - 3} more` : ''}`;
    } else {
      test7Passed = true;
      test7Message = 'All special characters properly normalized by cleanRawText()';
    }
  }
  
  runner.results.push({
    name: 'Verify Special Character Normalization (from cached response)',
    passed: test7Passed,
    endpoint: '/api/jobs/prompt-llm/generate-note',
    method: 'GET (dependent on Test 4)',
    status: null,
    expectedStatus: null,
    body: cachedSoapResponse || {},
    customMessage: test7Message,
    testNumber: 7,
    timestamp: new Date().toISOString(),
  });
  
  const test7Result = test7Passed ? '✅' : '⚠️ ';
  console.log(`\n${test7Result} Test 7: Verify Special Character Normalization`);
  console.log(`   ${test7Message}`);

  // Print and save results
  runner.printResults();
  
  const resultsPath = runner.saveResults('prompt-llm-tests.json');
  console.log(`✅ Detailed results saved to: ${resultsPath}`);

  const summary = runner.getSummary();
  return summary;
}

/**
 * Export for runAll.js
 */
export async function runPromptLlmTests() {
  return await runAllPromptLlmTests();
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllPromptLlmTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
