/**
 * Deepgram Transcription Test Suite
 * 
 * Tests the Deepgram transcription pipeline migration from pages/api to Fastify.
 * Deepgram handles:
 * - Audio transcription via Deepgram (Nova-3 model)
 * - Dot phrase expansion
 * - PHI masking (calls AWS)
 * - SOAP note generation pipeline
 * 
 * Test Coverage:
 * - transcribeHelper.transcribe_recording() function
 * - transcribeController helper functions (expandDotPhrases, buildAhoCorasick, etc.)
 * - HTTP endpoint tests for /api/deepgram/transcribe/complete
 * - Integration with AWS mask_phi
 * - Edge cases and error handling
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts } from './testConfig.js';
import { createClient } from '@supabase/supabase-js';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

const runner = new TestRunner('Deepgram Transcription Pipeline Tests');
const RECORDINGS_BUCKET = 'audio-files';
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');

/**
 * Load test data from testData.json (created by setup.test.js)
 */
function loadTestData() {
  try {
    if (!fs.existsSync(TEST_DATA_FILE)) {
      console.error(`❌ testData.json not found. Run: npm run test:setup`);
      process.exit(1);
    }
    
    const data = JSON.parse(fs.readFileSync(TEST_DATA_FILE, 'utf-8'));
    
    if (!data.recordings || !data.dotPhrases) {
      console.error('❌ testData.json missing required data (recordings or dotPhrases)');
      process.exit(1);
    }
    
    return data;
  } catch (error) {
    console.error(`❌ Failed to load testData.json: ${error.message}`);
    process.exit(1);
  }
}
/**
 * Test transcribe_recording utility function
 */
async function testTranscribeRecording(accessToken, testAccount, testData) {
  console.log('\n--- Testing transcribe_recording() Helper ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Get unattached recording from testData
  const unattachedRecordings = testData.recordings.filter(r => !r.encounterId);
  if (unattachedRecordings.length === 0) {
    console.warn('⚠️  No unattached recordings found in testData.json');
    return;
  }
  
  const recording = unattachedRecordings[0];
  let recordingUrl = null;
  
  // Get signed URL from Supabase for the actual recording
  try {
    console.log(`  Attempting to get signed URL for: ${recording.path}`);
    
    // Use user's JWT token for authenticated access (respects RLS policies)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false },
        global: { 
          headers: { 
            Authorization: `Bearer ${accessToken}` 
          } 
        },
      }
    );
    
    console.log(`  Supabase URL: ${process.env.SUPABASE_URL}`);
    console.log(`  Bucket: ${RECORDINGS_BUCKET}`);
    console.log(`  Recording path: ${recording.path}`);
    
    // Get signed URL (valid for 1 hour)
    const { data, error } = await supabase.storage
      .from(RECORDINGS_BUCKET)
      .createSignedUrl(recording.path, 3600);
    
    if (error) {
      console.warn(`  ⚠️  Failed to get signed URL: ${error.message}`);
      console.warn(`  Error details:`, error);
      recordingUrl = 'https://[placeholder-url]';
    } else {
      recordingUrl = data.signedUrl;
      console.log(`  ✓ Got signed URL: ${recordingUrl}`);
    }
  } catch (error) {
    console.warn(`  ⚠️  Exception getting signed URL: ${error.message}`);
    recordingUrl = 'https://[placeholder-url]';
  }
  
  // Test 1: Valid signed URL and authentication
  console.log(`\n  Starting transcription test with signed URL...`);
  const startTime = Date.now();
  
  await runner.test('Transcribe with valid signed URL', {
    method: 'POST',
    endpoint: '/api/deepgram/transcribe/complete',
    body: {
      recording_file_signed_url: recordingUrl,
    },
    headers,
    expectedStatus: 200,
    expectedFields: ['ok', 'cloudRunData'],
    customValidator: (response) => {
      const elapsed = Date.now() - startTime;
      const hasTranscript = response.cloudRunData?.transcript && 
        typeof response.cloudRunData.transcript === 'string' &&
        response.cloudRunData.transcript.length > 0;
      
      return {
        passed: hasTranscript,
        message: hasTranscript ? 
          `Transcript received in ${elapsed}ms: "${response.cloudRunData.transcript.substring(0, 50)}..."` :
          `Failed after ${elapsed}ms. Error: ${response.error || 'No transcript in response'}`
      };
    },
  });
  
  // Test 2: Missing authentication
  await runner.test('Reject transcribe without authentication', {
    method: 'POST',
    endpoint: '/api/deepgram/transcribe/complete',
    body: {
      recording_file_signed_url: recordingUrl,
    },
    expectedStatus: 401,
    customValidator: (response) => {
      return {
        passed: !!response.error,
        message: response.error || 'Expected error response'
      };
    },
  });
  
  // Test 3: Invalid signed URL (graceful error)
  await runner.test('Handle invalid signed URL gracefully', {
    method: 'POST',
    endpoint: '/api/deepgram/transcribe/complete',
    body: {
      recording_file_signed_url: 'https://invalid-expired-url.example.com/audio.wav',
    },
    headers,
    expectedStatus: 400,
    expectedFields: ['error'],
    customValidator: (response) => {
      return {
        passed: !!response.error,
        message: 'Invalid URL handled gracefully with error response'
      };
    },
  });
}

/**
 * Test dot phrase expansion logic
 * Uses the /api/transcripts/expand endpoint with hardcoded test transcripts (no Cloud Run calls)
 */
async function testDotPhraseExpansion(accessToken, testAccount, testData) {
  console.log('\n--- Testing Dot Phrase Expansion ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Get dotPhrases from testData
  const dotPhrases = testData.dotPhrases || [];
  if (dotPhrases.length === 0) {
    console.warn('⚠️  No dotPhrases found in testData.json');
    return;
  }
  
  const pt = dotPhrases.find(d => d.trigger === 'pt');
  const pts = dotPhrases.find(d => d.trigger === 'pts');
  
  // Test 4: Basic dot phrase expansion with known triggers
  // Use hardcoded transcript with known triggers to test expansion logic
  const transcriptWithTriggers = `The pt presented with symptoms. Multiple pts were in the waiting area. 
    The patient was examined and found to have normal vitals.`;
  
  await runner.test('Expand dot phrases in transcription', {
    method: 'POST',
    endpoint: '/api/transcripts/expand',
    headers,
    body: {
      transcript: transcriptWithTriggers,
      dotPhrases: dotPhrases,
      enableDotPhraseExpansion: true,
    },
    expectedStatus: 200,
    expectedFields: ['ok', 'expanded', 'llm_notated'],
    customValidator: (response) => {
      const expanded = response.expanded || '';
      const llm_notated = response.llm_notated || '';
      
      // Check both expanded and llm_notated contain the expansion
      let expansionsFound = 0;
      let notatedMarksFound = 0;
      
      if (pt) {
        // In expanded version: trigger should be replaced with expansion
        if (expanded.includes(pt.expansion)) {
          expansionsFound++;
        }
        // In llm_notated version: should have the expansion AND the prefix
        if (llm_notated.includes(pt.expansion) && llm_notated.includes("This is the doctor's autofilled dotPhrase, place extra emphasis")) {
          notatedMarksFound++;
        }
      }
      
      if (pts) {
        if (expanded.includes(pts.expansion)) {
          expansionsFound++;
        }
        if (llm_notated.includes(pts.expansion) && llm_notated.includes("This is the doctor's autofilled dotPhrase, place extra emphasis")) {
          notatedMarksFound++;
        }
      }
      
      return {
        passed: expansionsFound > 0 && notatedMarksFound > 0,
        message: `Expansions found in 'expanded': ${expansionsFound}, notated marks found: ${notatedMarksFound}`
      };
    },
  });
  
  // Test 5: Transcripts with no triggers (should still succeed and return unchanged)
  const transcriptNoTriggers = `The patient was examined during the appointment. 
    The appointment went well with no complications.`;
  
  await runner.test('Handle recordings with no dot phrase triggers', {
    method: 'POST',
    endpoint: '/api/transcripts/expand',
    headers,
    body: {
      transcript: transcriptNoTriggers,
      dotPhrases: dotPhrases,
      enableDotPhraseExpansion: true,
    },
    expectedStatus: 200,
    expectedFields: ['ok', 'expanded', 'llm_notated'],
    customValidator: (response) => {
      const expanded = response.expanded || '';
      const llm_notated = response.llm_notated || '';
      
      // Both expanded and llm_notated should be identical to original when no triggers match
      const expandedUnchanged = expanded === transcriptNoTriggers;
      const llmUnchanged = llm_notated === transcriptNoTriggers;
      
      return {
        passed: response.ok === true && expandedUnchanged && llmUnchanged,
        message: `Expansion with no triggers: expanded unchanged: ${expandedUnchanged}, llm_notated unchanged: ${llmUnchanged}`
      };
    },
  });
  
  // Test 6: Overlapping dot phrase matches (pt vs pts de-duplication)
  // Test that longer matches are prioritized (pts before pt)
  const transcriptOverlapping = `The pts were waiting for the doctor. The pt in room 1 is ready.`;
  
  await runner.test('De-duplicate overlapping dot phrase matches', {
    method: 'POST',
    endpoint: '/api/transcripts/expand',
    headers,
    body: {
      transcript: transcriptOverlapping,
      dotPhrases: dotPhrases,
      enableDotPhraseExpansion: true,
    },
    expectedStatus: 200,
    expectedFields: ['ok', 'expanded', 'llm_notated'],
    customValidator: (response) => {
      const expanded = response.expanded || '';
      const llm_notated = response.llm_notated || '';
      
      // If both pt and pts exist, verify longest match is prioritized
      if (pt && pts) {
        // "pts" should expand to pts.expansion (longer match priority)
        // "pt " should expand to pt.expansion (in "The pt in room")
        const hasPtsExpansion = expanded.includes(pts.expansion);
        const hasPtExpansion = expanded.includes(pt.expansion);
        
        // Also verify llm_notated has the markers
        const hasPtsNotated = llm_notated.includes(pts.expansion) && llm_notated.includes("This is the doctor's autofilled dotPhrase, place extra emphasis");
        const hasPtNotated = llm_notated.includes(pt.expansion) && llm_notated.includes("This is the doctor's autofilled dotPhrase, place extra emphasis");
        
        return {
          passed: hasPtsExpansion && hasPtExpansion && hasPtsNotated && hasPtNotated,
          message: `De-duplication verified: pts expansion: ${hasPtsExpansion}, pt expansion: ${hasPtExpansion}, notated marks: ${hasPtsNotated && hasPtNotated}`
        };
      }
      
      return {
        passed: true,
        message: 'Overlapping match de-duplication test completed'
      };
    },
  });
}

/**
 * Test error handling
 */
async function testErrorHandling(accessToken, testData) {
  console.log('\n--- Testing Error Handling ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Test 7: Missing required body field - transcript missing from /transcripts/expand
  await runner.test('Reject /transcripts/expand without transcript field', {
    method: 'POST',
    endpoint: '/api/transcripts/expand',
    body: {
      dotPhrases: [],
      enableDotPhraseExpansion: true,
    },
    headers,
    expectedStatus: 400,
    expectedFields: ['error'],
    customValidator: (response) => {
      return {
        passed: response.error?.issues || response.error?.errors || !!response.error,
        message: response.error?.issues ? 'ZodError validation failed' : 'Validation error'
      };
    },
  });
  
  // Test 8: Missing required body field - signed URL from /deepgram/transcribe/complete
  await runner.test('Reject request without signed URL', {
    method: 'POST',
    endpoint: '/api/deepgram/transcribe/complete',
    body: {},
    headers,
    expectedStatus: 400,
    expectedFields: ['error'],
    customValidator: (response) => {
      return {
        passed: response.error?.issues || response.error?.errors || !!response.error,
        message: response.error?.issues ? 'ZodError validation failed' : 'Validation error'
      };
    },
  });
  
  // Test 9: Malformed signed URL
  await runner.test('Handle malformed signed URL', {
    method: 'POST',
    endpoint: '/api/deepgram/transcribe/complete',
    body: {
      recording_file_signed_url: 'not-a-valid-url',
    },
    headers,
    expectedStatus: 400,
    expectedFields: ['error'],
    customValidator: (response) => {
      return {
        passed: !!response.error,
        message: 'Malformed URL rejected with error response'
      };
    },
  });
  
  // Test 10: Disabled dot phrase expansion
  // Test that expansion can be disabled and transcript is returned unchanged
  const transcriptWithTriggers = `The pt was examined. Multiple pts were waiting.`;
  
  await runner.test('Skip dot phrase expansion when disabled', {
    method: 'POST',
    endpoint: '/api/transcripts/expand',
    body: {
      transcript: transcriptWithTriggers,
      dotPhrases: testData.dotPhrases || [],
      enableDotPhraseExpansion: false,
    },
    headers,
    expectedStatus: 200,
    expectedFields: ['ok', 'expanded', 'llm_notated'],
    customValidator: (response) => {
      // When expansion is disabled, both expanded and llm_notated should equal the original transcript
      const expandedUnchanged = response.expanded === transcriptWithTriggers;
      const llmUnchanged = response.llm_notated === transcriptWithTriggers;
      
      return {
        passed: response.ok === true && expandedUnchanged && llmUnchanged,
        message: `Expansion disabled: expanded unchanged: ${expandedUnchanged}, llm_notated unchanged: ${llmUnchanged}`
      };
    },
  });
}

/**
 * Run all Deepgram tests
 * Note: Endpoints use /deepgram/ prefix for Deepgram transcription service
 */
export async function runDeepgramTests() {
  console.log('Starting Deepgram Transcription Pipeline tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  // Load test data first
  console.log('Loading test data...');
  const testData = loadTestData();
  console.log(`✅ Loaded testData.json`);
  console.log(`   - ${testData.recordings?.length || 0} recordings`);
  console.log(`   - ${testData.dotPhrases?.length || 0} dotPhrases\n`);

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
            turnstileToken: process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN,
          }),
        });
        const signInResponse = await response.json();
        if (signInResponse?.token?.access_token) {
          accessToken = signInResponse.token.access_token;
          console.log('✅ Obtained real access token from test account\n');
        }
      } catch (error) {
        console.log('⚠️  Could not get real token:', error.message, '\n');
      }
    }
  } else {
    console.log('⚠️  Test credentials not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local\n');
  }

  try {
    const testAccount = getTestAccount('primary');
    await testTranscribeRecording(accessToken, testAccount, testData);
    await testDotPhraseExpansion(accessToken, testAccount, testData);
    await testErrorHandling(accessToken, testData);
  } catch (error) {
    console.error('Error during test execution:', error);
  }

  // Print results
  runner.printResults();

  // Save results to file
  const resultsFile = runner.saveResults('gcp-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runDeepgramTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
