/**
 * AWS Migration Test Suite
 * 
 * Tests the AWS Comprehend Medical integration for PHI masking/unmasking.
 * Validates both utility functions and Fastify route endpoints.
 * 
 * Test Coverage:
 * - HTTP endpoint tests for mask-phi and unmask-phi
 * - Edge cases and error handling
 * - Authentication validation
 * - Large transcript handling
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { TestRunner } from './testUtils.js';
import { getTestAccount, hasTestAccounts } from './testConfig.js';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

const runner = new TestRunner('AWS PHI Masking API Tests');

/**
 * End-to-End test: Mask -> Unmask with entity tracking
 */
async function testE2EMaskUnmask(accessToken) {
  console.log('\n--- E2E Test: Mask & Unmask with Entity Tracking ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Use a text with clear PHI that's easy to verify
  const e2eText = 'Patient John Smith, DOB 05/20/1990, SSN 123-45-6789 was seen by Dr. Elizabeth Johnson on 12/15/2024. Call 555-123-4567 for follow-up.';
  console.log(`  E2E test body: ${e2eText.substring(0, 200)}`);
  
  // Step 1: Mask the text
  const maskResponse = await fetch(`${runner.baseUrl}/api/aws/mask-phi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ text: e2eText }),
  });
  
  const maskData = await maskResponse.json();
  const { maskedText, entities, tokens } = maskData;
  
  if (!maskedText || !entities) {
    console.log('⚠️  Warning: Mask response missing required fields');
    console.log('  Response:', maskData);
    return;
  }
  
  console.log(`  ✓ Masked text: ${maskedText.substring(0, 150)}...`);
  console.log(`  ✓ Entities detected: ${entities.length}`);
  console.log(`  ✓ Tokens received: ${JSON.stringify(tokens).substring(0, 200)}`);
  
  // Verify tokens exist
  if (!tokens || Object.keys(tokens).length === 0) {
    console.log('⚠️  WARNING: No tokens in mask response! Tokens object is empty.');
    console.log('  Full response:', maskData);
  }
  
  // Step 2: Unmask the text
  console.log(`  Unmasking with tokens:`, JSON.stringify(tokens).substring(0, 200));
  const unmaskResponse = await fetch(`${runner.baseUrl}/api/aws/unmask-phi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ text: maskedText, tokens }),
  });
  
  const unmaskData = await unmaskResponse.json();
  const { unmaskedText } = unmaskData;
  
  if (!unmaskedText) {
    console.log('⚠️  Warning: Unmask response missing unmaskedText field');
    console.log('  Response:', unmaskData);
    return;
  }
  
  console.log(`  ✓ Unmasked text: ${unmaskedText.substring(0, 150)}...`);
  
  // Step 3: Entity-level verification
  let correctlyUnmasked = 0;
  let totalEntities = entities.length;
  
  console.log('\n  Entity-by-entity verification:');
  for (const entity of entities) {
    const tokenKey = `${entity.Type}_${entity.Id}`;
    const originalText = entity.Text;
    const tokenValue = tokens[tokenKey];
    
    // Check if the original text appears in the unmasked text
    const isPresent = unmaskedText.includes(originalText);
    const status = isPresent ? '✓' : '✗';
    
    if (isPresent) {
      correctlyUnmasked++;
    }
    
    console.log(`    ${status} ${entity.Type}_${entity.Id}: "${originalText}" -> token "${tokenKey}"`);
  }
  
  // Calculate accuracy
  const accuracy = totalEntities > 0 ? (correctlyUnmasked / totalEntities) * 100 : 0;
  const accuracyFraction = `${correctlyUnmasked}/${totalEntities}`;
  
  console.log(`\n  Entity Unmasking Accuracy: ${accuracyFraction} (${accuracy.toFixed(1)}%)`);
  
  // Test result
  const testPassed = correctlyUnmasked === totalEntities;
  await runner.test('Test 8: E2E - All masked PHI correctly unmasked', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: { text: e2eText },
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
    customValidator: () => {
      return {
        passed: testPassed,
        message: `Entity accuracy: ${accuracyFraction} (${accuracy.toFixed(1)}%) - ${correctlyUnmasked === totalEntities ? 'All entities correctly restored' : `${totalEntities - correctlyUnmasked} entities not found in unmasked text`}`,
      };
    },
  });
}

/**
 * Test PHI masking endpoint
 */
async function testMaskPhi(accessToken) {
  console.log('\n--- Testing PHI Masking ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Test 1: Basic PHI masking
  const test1Body = { text: 'Patient John Doe, DOB 01/15/1985, SSN 123-45-6789' };
  console.log(`  Test 1 body: ${JSON.stringify(test1Body).substring(0, 200)}`);
  await runner.test('Mask basic medical text with PHI', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test1Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
  });

  // Test 2: Text without PHI
  const test2Body = { text: 'The patient presented with general fatigue and discussed treatment options.' };
  console.log(`  Test 2 body: ${JSON.stringify(test2Body).substring(0, 200)}`);
  await runner.test('Handle text without PHI', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test2Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
  });

  // Test 3: Complex medical text
  const test3Body = {
    text: `All right, so who we got here? What's the name? Carl, I think. Carl Tard. Oh, my goodness, 17-year-old. So Carl was seen as a new patient in October. She's 16 with years of constipation, or usually worse, around the summer, required an in-office flush in August, was on Mirralax, then regular stool softeners. After Mirralax, it becomes very constipated.  gets abdominal pain, heart abdomen, nausea, no fecal incontinence, sometimes heartburned and nausea. Okay, past medical history, there's a couple of bone fractures, family history, both parents seem healthy. Mother has osteoporosis after cancer treatment. At the time in October, she was 11th grade, played soccer.  So, constipated, bloated, prior bone fractures. Oh, she's got a setup for osteoporosis herself. She takes Mirralax, occasional nexium. Her BMI percentile was 32.52%, which is fine. So, constipation treatment. Maybe bloating due to lactose intolerance. We did the Miralax, one or one  or 1.5 catfools every day, weekly clean out with 10 catfools and 80 ounces of sports train a couple of times to see whether we really needed that. There's some labs, thyroid functions, celiac, serum calcium. I try to get a Dexas scan to see what's going on. You answer a lactose breath test. And also talked about some mole surveillance because she must have had some moles there. Electro's breath test was completely normal, surprisingly. And any other  any other labs, phosphorus, CMP, magnesium, 25 hydroxy vitamin D, and a dexter scan. All right. So let's see what the labs showed. The labs showed vitamin D to be normal, CMP, normal. Testin was high, 5.3, but I think that's probably due to, you know, flow issues, magnesium's normal,  phosphorus is normal. Fine. We're good with that. And then diagnostic imaging had a dexas scan done in October 22nd. And indication pathological fractures. And so the patient Z score is within the expected range for age. So it's fine. So her Z score is minus 1.7, but for her age it seems to be okay.`,
  };
  console.log(`  Test 3 body: ${JSON.stringify(test3Body).substring(0, 200)}`);
  await runner.test('Mask complex medical encounter text', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test3Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
  });

  // Test 3b: Verify Test 3 identified >5 PHI entities
  const test3Response = await fetch(`${runner.baseUrl}/api/aws/mask-phi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(test3Body),
  });
  const test3Data = await test3Response.json();
  const entityCount = test3Data.entities?.length || 0;
  
  await runner.test('Verify complex text identified >5 PHI entities', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test3Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
    customValidator: () => {
      if (entityCount > 5) {
        return { passed: true, message: `Found ${entityCount} PHI entities (expected >5)` };
      }
      return { passed: false, message: `Found only ${entityCount} PHI entities, expected >5` };
    },
  });

  // Test 4: Missing authentication
  const test4Body = { text: 'Patient: John Doe' };
  console.log(`  Test 4 body: ${JSON.stringify(test4Body).substring(0, 200)}`);
  await runner.test('Reject request without authentication', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test4Body,
    expectedStatus: 401,
  });
}

/**
 * Test PHI unmasking endpoint
 */
async function testUnmaskPhi(accessToken) {
  console.log('\n--- Testing PHI Unmasking ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // First, mask some text to get tokens
  const maskBody = { text: 'Patient John Doe, DOB 01/15/1985, has been referred to Dr. Smith.' };
  console.log(`  Pre-unmask fetch body: ${JSON.stringify(maskBody).substring(0, 200)}`);
  
  const maskResponse = await fetch(`${runner.baseUrl}/api/aws/mask-phi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(maskBody),
  });

  const maskData = await maskResponse.json();
  
  // Verify we got valid mask response
  if (!maskData.maskedText) {
    console.log('⚠️  Warning: Mask response missing maskedText field');
    console.log('  Response:', maskData);
  }
  
  const { tokens } = maskData;

  // Test 5: Unmask previously masked text
  const test5Body = { text: maskData.maskedText, tokens };
  console.log(`  Test 5 body: ${JSON.stringify(test5Body).substring(0, 200)}`);
  await runner.test('Unmask previously masked PHI', {
    method: 'POST',
    endpoint: '/api/aws/unmask-phi',
    body: test5Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['unmaskedText'],
  });

  // Test 6: Unmask with empty tokens (should return masked text unchanged)
  const test6Body = {
    text: 'Some text with {{NAME_1}} and {{PROFESSION_2}}.',
    tokens: {},
  };
  console.log(`  Test 6 body: ${JSON.stringify(test6Body).substring(0, 200)}`);
  await runner.test('Handle unmask with empty tokens (tokens not found)', {
    method: 'POST',
    endpoint: '/api/aws/unmask-phi',
    body: test6Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['unmaskedText'],
    customValidator: (response) => {
      // When tokens are empty, masked tokens should remain unchanged
      if (!response.unmaskedText) {
        return {
          passed: false,
          message: `Expected unmaskedText field but got: ${JSON.stringify(response)}`
        };
      }
      return {
        passed: response.unmaskedText.includes('{{NAME_1}}'),
        message: 'Tokens not found should remain masked'
      };
    },
  });

  // Test 7: Missing tokens field in unmask request
  const test7Body = { text: 'Some {{NAME_1}} text' };
  console.log(`  Test 7 body: ${JSON.stringify(test7Body).substring(0, 200)}`);
  await runner.test('Reject unmask without tokens field', {
    method: 'POST',
    endpoint: '/api/aws/unmask-phi',
    body: test7Body,
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

  // Test 8: Missing authentication on unmask
  const test8Body = { 
    text: 'Patient {{NAME_1}} with {{PROFESSION_2}}', 
    tokens: {
      'NAME_1': 'John Smith',
      'PROFESSION_2': 'accountant'
    }
  };
  console.log(`  Test 8 body: ${JSON.stringify(test8Body).substring(0, 200)}`);
  await runner.test('Reject unmask without authentication', {
    method: 'POST',
    endpoint: '/api/aws/unmask-phi',
    body: test8Body,
    expectedStatus: 401,
  });
}

/**
 * Test large transcript handling
 */
async function testLargeTranscripts(accessToken) {
  console.log('\n--- Testing Large Transcript Handling ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Generate a large transcript with multiple medical encounters
  const largeText = Array(5)
    .fill(null)
    .map(
      (_, i) => `
Encounter ${i + 1}:
Patient: Michael Johnson (DOB: 7/12/1970), SSN: 456-78-9012
Provider: Dr. Elizabeth Wilson, MD - Cardiology
Date: ${new Date(2024, 0, i + 1).toLocaleDateString()}
Phone: 555-${String(1000 + i).padStart(4, '0')}
Chief Complaint: Hypertension follow-up
Assessment: Blood pressure controlled on current medications.
Plan: Continue current regimen, recheck in 3 months.
`
    )
    .join('\n');

  // Test 8: Large transcript chunking
  const test8Body = { text: largeText };
  console.log(`  Test 8 body: ${JSON.stringify(test8Body).substring(0, 200)}`);
  await runner.test('Test 9: Handle large transcript with multiple PHI instances', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test8Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
  });
}

/**
 * Test edge cases
 */
async function testEdgeCases(accessToken) {
  console.log('\n--- Testing Edge Cases ---');
  
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  
  // Test 9: Empty text
  const test9Body = { text: '' };
  console.log(`  Test 9 body: ${JSON.stringify(test9Body).substring(0, 200)}`);
  await runner.test('Test 10: Handle empty text', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test9Body,
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

  // Test 10: Special characters and unusual formatting
  const test10Body = {
    text: 'Patient: Dr. O\'Brien-Smith, Jr., DOB: 12/31/1960 | Contact: (555) 123-4567',
  };
  console.log(`  Test 10 body: ${JSON.stringify(test10Body).substring(0, 200)}`);
  await runner.test('Test 11: Handle text with special characters', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test10Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText', 'entities'],
  });

  // Test 11: Very short text
  const test11Body = { text: 'John' };
  console.log(`  Test 11 body: ${JSON.stringify(test11Body).substring(0, 200)}`);
  await runner.test('Test 12: Handle very short text', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test11Body,
    headers,
    expectedStatus: 200,
    expectedFields: ['maskedText'],
  });

  // Test 12: Invalid request body
  const test12Body = { invalid: 'field' };
  console.log(`  Test 12 body: ${JSON.stringify(test12Body).substring(0, 200)}`);
  await runner.test('Test 13: Reject invalid request body', {
    method: 'POST',
    endpoint: '/api/aws/mask-phi',
    body: test12Body,
    headers,
    expectedStatus: 400,
    customValidator: (response) => {
      return {
        passed: response.error?.issues || response.error?.errors || !!response.error,
        message: response.error?.issues ? 'ZodError validation failed' : 'Validation error'
      };
    },
  });
}

/**
 * Run all AWS tests
 */
export async function runAwsTests() {
  console.log('Starting AWS PHI Masking API tests...');
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
    await testMaskPhi(accessToken);
    await testUnmaskPhi(accessToken);
    await testE2EMaskUnmask(accessToken);
    await testLargeTranscripts(accessToken);
    await testEdgeCases(accessToken);
  } catch (error) {
    console.error('Error during test execution:', error);
  }

  // Print results
  runner.printResults();

  // Save results to file
  const resultsFile = runner.saveResults('aws-tests.json');
  console.log(`✅ Test results saved to: ${resultsFile}\n`);
  
  // Return summary for master test runner
  return runner.getSummary();
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runAwsTests();
    process.exit(0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}
