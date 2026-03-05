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
 * Architecture: POST /api/jobs/prompt-llm (202) → GET /api/jobs/prompt-llm/:jobId (poll)
 * Polling: 10s initial, exponential backoff to 45s on HTTP error, 10min timeout
 * 
 * Note: Transcription and PHI masking are tested separately in Deepgram and AWS tests.
 * This test focuses only on the OpenAI LLM functionality.
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

const runner = new TestRunner('OpenAI Prompt-LLM API Tests');

// Mock token for invalid auth tests
const MOCK_TOKEN = 'invalid.token.here';

// Load test data
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');
let testData = null;
let cachedSoapResponse = null; // Cache SOAP response from test 4 for reuse

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

/**
 * Poll a job until completion or timeout
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
    endpoint: '/api/jobs/prompt-llm',
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
    endpoint: '/api/jobs/prompt-llm',
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
    endpoint: '/api/jobs/prompt-llm',
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

  // Test 4: REAL OpenAI call - Generate SOAP note via job-based polling (PRIMARY TEST)
  console.log('\n⏳ Test 4 will create a job and poll until complete (max 10 minutes)...\n');
  console.log('   Process: Audio → Transcribe (Deepgram) → Expand dot phrases → Mask PHI (AWS) → Generate SOAP (OpenAI o3)\n');
  
  // Create job
  const createResponse = await makeRequest('POST', '/api/jobs/prompt-llm',
    { recording_file_path: recording.path },
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
          test4Message = `Completed in ${pollResult.elapsed}s`;
        }
      }
    } else {
      test4Message = `Unexpected final status: ${pollResult.finalStatus}`;
    }
  }

  runner.results.push({
    name: 'Generate SOAP Note from Recording (Job-Based Polling)',
    passed: test4Passed,
    endpoint: '/api/jobs/prompt-llm',
    method: 'POST → GET (polling)',
    status: createResponse.status,
    expectedStatus: 202,
    body: createResponse.body,
    customMessage: test4Message,
    testNumber: 4,
    timestamp: new Date().toISOString(),
  });

  const test4Result = test4Passed ? '✅' : '❌';
  console.log(`\n${test4Result} Test 4: Generate SOAP Note from Recording (Job-Based Polling)`);
  console.log(`   ${test4Message}`);

  // Test 5: Validate SOAP Structure (inline validation - dependent on test 4)
  let test5Passed = false;
  let test5Message = '';
  if (!cachedSoapResponse) {
    test5Message = '⚠️  SKIPPED: Test 4 failed, cannot validate SOAP structure';
  } else {
    try {
      // Response.soap_note is already parsed by jobController using parseSoapNotes()
      if (!cachedSoapResponse.soap_note || typeof cachedSoapResponse.soap_note !== 'object') {
        test5Message = 'Missing or invalid soap_note object';
      } else {
        const sn = cachedSoapResponse.soap_note;
        
        // Check subjective with required fields
        if (!sn.subjective || typeof sn.subjective !== 'object') {
          test5Message = 'Missing or invalid subjective object';
        } else {
          const subjReq = ['Chief complaint', 'HPI', 'History', 'ROS', 'Medications', 'Allergies'];
          for (const key of subjReq) {
            if (!(key in sn.subjective) || typeof sn.subjective[key] !== 'string') {
              test5Message = `subjective missing or invalid: ${key}`;
              break;
            }
          }
        }
        
        // Check objective with required fields
        if (!test5Message && (!sn.objective || typeof sn.objective !== 'object')) {
          test5Message = 'Missing or invalid objective object';
        } else if (!test5Message) {
          const objReq = ['HEENT', 'General', 'Cardiovascular', 'Musculoskeletal', 'Other'];
          for (const key of objReq) {
            if (!(key in sn.objective) || typeof sn.objective[key] !== 'string') {
              test5Message = `objective missing or invalid: ${key}`;
              break;
            }
          }
        }
        
        // Check assessment and plan
        if (!test5Message && typeof sn.assessment !== 'string') {
          test5Message = 'assessment must be a string';
        } else if (!test5Message && typeof sn.plan !== 'string') {
          test5Message = 'plan must be a string';
        }
        
        // Check billing
        if (!test5Message && (!cachedSoapResponse.billing || typeof cachedSoapResponse.billing !== 'object')) {
          test5Message = 'Missing or invalid billing object';
        } else if (!test5Message) {
          const bill = cachedSoapResponse.billing;
          if (!Array.isArray(bill.icd10_codes) || bill.icd10_codes.length === 0) {
            test5Message = 'icd10_codes must be non-empty array';
          } else if (typeof bill.billing_code !== 'string' || !bill.billing_code.length) {
            test5Message = 'billing_code must be non-empty string';
          } else if (typeof bill.additional_inquiries !== 'string') {
            test5Message = 'additional_inquiries must be string';
          }
        }
        
        if (!test5Message) {
          test5Passed = true;
          test5Message = 'SOAP note structure is valid and matches schema';
        }
      }
    } catch (err) {
      test5Message = `Validation error: ${err.message}`;
    }
  }
  
  runner.results.push({
    name: 'Validate SOAP Note Structure (from cached response)',
    passed: test5Passed,
    endpoint: '/api/jobs/prompt-llm',
    method: 'GET (dependent on Test 4)',
    status: null,
    expectedStatus: null,
    body: cachedSoapResponse || {},
    customMessage: test5Message,
    testNumber: 5,
    timestamp: new Date().toISOString(),
  }); 
  
  const test5Result = test5Passed ? '✅' : '⚠️ ';
  console.log(`\n${test5Result} Test 5: Validate SOAP Note Structure`);
  console.log(`   ${test5Message}`);

  // Test 6: Verify Special Character Handling (inline validation - dependent on test 4)
  let test6Passed = false;
  let test6Message = '';
  if (!cachedSoapResponse) {
    test6Message = '⚠️  SKIPPED: Test 4 failed, cannot verify special character handling';
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
      test6Message = `Found unclean special characters: ${foundProblematic.slice(0, 3).join(', ')}${foundProblematic.length > 3 ? ` +${foundProblematic.length - 3} more` : ''}`;
    } else {
      test6Passed = true;
      test6Message = 'All special characters properly normalized by cleanRawText()';
    }
  }
  
  runner.results.push({
    name: 'Verify Special Character Normalization (from cached response)',
    passed: test6Passed,
    endpoint: '/api/jobs/prompt-llm',
    method: 'GET (dependent on Test 4)',
    status: null,
    expectedStatus: null,
    body: cachedSoapResponse || {},
    customMessage: test6Message,
    testNumber: 6,
    timestamp: new Date().toISOString(),
  });
  
  const test6Result = test6Passed ? '✅' : '⚠️ ';
  console.log(`\n${test6Result} Test 6: Verify Special Character Normalization`);
  console.log(`   ${test6Message}`);

  // Print and save results
  runner.printResults(6); // 6 total tests
  
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
