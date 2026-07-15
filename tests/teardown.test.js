/**
 * Test Teardown Script
 * Cleans up all test data created by setup.test.js:
 * - Deletes 3 test encounters
 * - Deletes 5 test recording files from storage
 * - Clears testData.json
 *
 * Run after all tests are complete:
 * npm run test:teardown
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { getTestAccount, hasTestAccounts, getApiBaseUrl } from './testConfig.js';
import { createClient } from '@supabase/supabase-js';

const RECORDINGS_BUCKET = 'audio-files';
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');

/**
 * Load test data from JSON file
 */
function loadTestData() {
  if (!fs.existsSync(TEST_DATA_FILE)) {
    console.log('⚠️  No test data file found. Nothing to clean up.');
    return null;
  }

  try {
    const data = fs.readFileSync(TEST_DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ Error reading test data file:', error.message);
    return null;
  }
}

/**
 * Main teardown function
 */
async function teardownTestData() {
  console.log('\n' + '='.repeat(70));
  console.log('RECORDINGS API TEST TEARDOWN');
  console.log('='.repeat(70) + '\n');

  // Load test data
  const testData = loadTestData();
  if (!testData) {
    process.exit(1);
  }

  // Check if test data has already been cleaned up
  if (!testData.createdAt || !testData.testAccount) {
    console.log('ℹ️  Test data has already been cleaned up.');
    console.log('Run: npm run test:setup to create new test data\n');
    process.exit(0);
  }

  console.log(`Test data created at: ${testData.createdAt}`);
  console.log(`Test account: ${testData.testAccount.email}\n`);

  // Check if server is running
  try {
    const response = await fetch(`${getApiBaseUrl()}/health`);
    if (!response.ok) throw new Error('Server not responding');
    console.log('✅ Server health check passed\n');
  } catch (error) {
    console.error('❌ Server is not running. Start the server with:');
    console.error('   npm run dev:fastify\n');
    process.exit(1);
  }

  // Get test account credentials
  if (!hasTestAccounts()) {
    console.error('❌ Test account not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local');
    process.exit(1);
  }

  const testAccount = getTestAccount('primary');
  if (!testAccount?.email || !testAccount?.password) {
    console.error('❌ Invalid test account credentials');
    process.exit(1);
  }

  try {
    // Step 1: Sign in to get access token
    console.log('Step 1: Authenticating...');
    const signInResponse = await fetch(`${getApiBaseUrl()}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign-in',
        email: testAccount.email,
        password: testAccount.password,
        turnstileToken: process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN,
      }),
    });

    if (!signInResponse.ok) {
      throw new Error('Failed to sign in. Check credentials in .env.local');
    }

    const authData = await signInResponse.json();
    const accessToken = authData.token.access_token;
    console.log('✓ Authenticated\n');

    // Step 2: Create Supabase client
    console.log('Step 2: Initializing Supabase client...');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      accessToken
    );
    console.log('✓ Supabase client ready\n');

    // Step 3: Delete test encounters
    console.log('Step 3: Deleting test encounters...');
    let deletedCount = 0;
    for (const encounter of testData.encounters) {
      const response = await fetch(`${getApiBaseUrl()}/api/patient-encounters/${encounter.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (response.ok || response.status === 404) {
        console.log(`✓ Deleted encounter ${encounter.id}`);
        deletedCount++;
      } else {
        console.log(`✗ Failed to delete encounter ${encounter.id}: ${response.status}`);
      }
    }
    console.log(`Deleted ${deletedCount} encounters\n`);

    // Step 4: Delete test recordings from storage
    console.log('Step 4: Deleting test files from storage...');
    let filesDeleted = 0;
    for (const recording of testData.recordings) {
      try {
        const { error } = await supabase.storage
          .from(RECORDINGS_BUCKET)
          .remove([recording.path]);

        if (error) {
          console.log(`✗ Failed to delete ${recording.path}: ${error.message}`);
        } else {
          console.log(`✓ Deleted ${recording.path}`);
          filesDeleted++;
        }
      } catch (error) {
        console.log(`✗ Error deleting ${recording.path}: ${error.message}`);
      }
    }
    console.log(`Deleted ${filesDeleted} files\n`);

    // Step 5: Clear test data file
    console.log('Step 5: Clearing test data file...');
    fs.writeFileSync(TEST_DATA_FILE, JSON.stringify({
      deletedAt: new Date().toISOString(),
      note: 'Test data has been cleaned up. Run npm run test:setup to create new test data.'
    }, null, 2));
    console.log('✓ Test data file cleared\n');

    // Summary
    console.log('='.repeat(70));
    console.log('TEARDOWN COMPLETE');
    console.log('='.repeat(70));
    console.log('\nCleaned up:');
    console.log(`  Encounters deleted: ${deletedCount}`);
    console.log(`  Files deleted: ${filesDeleted}`);
    console.log(`  Test data cleared: ${TEST_DATA_FILE}`);
    console.log('\nTo run tests again:');
    console.log('  npm run test:setup      - Create new test data');
    console.log('  npm run test:recordings - Run recording tests\n');

  } catch (error) {
    console.error('\n❌ Teardown failed:', error.message);
    process.exit(1);
  }
}

// Run teardown
teardownTestData().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
