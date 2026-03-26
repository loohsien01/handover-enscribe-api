/**
 * Test Suite: Extract Note Template API
 *
 * POST /api/extract-note-template (multipart/form-data, field: file)
 *
 * Test List:
 *   Test 1: POST without auth (401)
 *   Test 2: POST with invalid token (401)
 *   Test 3: POST with missing file (400)
 *   Test 4: POST with unsupported file type (400)
 *   Test 5: POST with empty file (400)
 *   Test 6: POST with valid fixture file (200 + sections array)
 * Mirrors project conventions from notes.test.js:
 * - Uses custom TestRunner
 * - Uses test account JWT from .env.local
 * - Saves output to test-results/
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

const runner = new TestRunner('Extract Note Template API Tests');
const MOCK_TOKEN = 'invalid.token.here';
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const PDF_FIXTURE = '2026-03-25____11-16-53-PM.pdf';

function getFixtureFile() {
  const pdfPath = path.join(FIXTURES_DIR, PDF_FIXTURE);
  if (fs.existsSync(pdfPath)) {
    return {
      filename: PDF_FIXTURE,
      contentType: 'application/pdf',
      buffer: fs.readFileSync(pdfPath),
    };
  }
  return null;
}

async function runExtractNoteTemplateTests() {
  console.log('Starting Extract Note Template API tests...');
  console.log(`Server: ${runner.baseUrl}`);
  console.log('Contract: multipart/form-data with "file" field\n');

  let realAccessToken = null;

  // Get token from test account
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
        const signInData = await response.json();
        realAccessToken =
          signInData?.token?.access_token ||
          signInData?.session?.access_token ||
          signInData?.access_token ||
          null;

        if (realAccessToken) {
          console.log('✅ Obtained real access token for authenticated tests\n');
        } else {
          console.log('⚠️  Could not parse token from sign-in response\n');
        }
      } catch (error) {
        console.log('⚠️  Could not get real token, running auth tests only\n');
      }
    }
  }

  const tinyTxt = {
    filename: 'tiny.txt',
    contentType: 'text/plain',
    buffer: Buffer.from('hello'),
  };

  // Test 1: No auth
  await runner.testMultipart('POST /extract-note-template without auth', {
    method: 'POST',
    endpoint: '/api/extract-note-template',
    testNumber: 1,
    expectedStatus: 401,
    filePart: tinyTxt,
  });

  // Test 2: Invalid token
  await runner.testMultipart('POST /extract-note-template with invalid token', {
    method: 'POST',
    endpoint: '/api/extract-note-template',
    testNumber: 2,
    expectedStatus: 401,
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
    },
    filePart: tinyTxt,
  });

  if (realAccessToken) {
    // Test 3: Missing file
    await runner.testMultipart('POST /extract-note-template missing file', {
      method: 'POST',
      endpoint: '/api/extract-note-template',
      testNumber: 3,
      expectedStatus: 400,
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
    });

    // Test 4: Unsupported file type
    await runner.testMultipart('POST /extract-note-template unsupported file type', {
      method: 'POST',
      endpoint: '/api/extract-note-template',
      testNumber: 4,
      expectedStatus: 400,
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      filePart: {
        filename: 'image.png',
        contentType: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });

    // Test 5: Empty file
    await runner.testMultipart('POST /extract-note-template empty file', {
      method: 'POST',
      endpoint: '/api/extract-note-template',
      testNumber: 5,
      expectedStatus: 400,
      headers: {
        Authorization: `Bearer ${realAccessToken}`,
      },
      filePart: {
        filename: 'empty.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.alloc(0),
      },
    });

    // Test 6: Valid fixture
    const fixture = getFixtureFile();
    if (!fixture) {
      console.log(`⚠️  Fixture missing: expected ${PDF_FIXTURE}`);
      console.log('    Test 6 will be marked skipped in printed output.\n');
    } else {
      await runner.testMultipart(`POST /extract-note-template valid fixture (${fixture.filename})`, {
        method: 'POST',
        endpoint: '/api/extract-note-template',
        testNumber: 6,
        expectedStatus: 200,
        headers: {
          Authorization: `Bearer ${realAccessToken}`,
        },
        filePart: fixture,
        customValidator: (body) => {
          const sections = body?.sections;
          const validLayouts = Array.isArray(sections) &&
            sections.every((s) => s?.layout === 'paragraph' || s?.layout === 'bullet points');
          const passed = Array.isArray(sections) && sections.length > 0 && validLayouts;
          return {
            passed,
            message: passed
              ? `Extracted ${sections.length} sections`
              : `Invalid sections response: ${JSON.stringify(body).substring(0, 200)}...`,
          };
        },
      });
    }
  } else {
    console.log('⚠️  Skipping Tests 3-6: no valid authenticated test token.\n');
  }

  // Save + print in project standard format
  runner.saveResults('extract-note-template-tests.json');
  runner.printResults(6);

  return runner.getSummary();
}

runExtractNoteTemplateTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});

export { runExtractNoteTemplateTests };
