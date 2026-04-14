/**
 * Internal cleanup API — auth and validation (full 200 path only if INTERNAL_CLEANUP_SECRET is set).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner } from './testUtils.js';

const runner = new TestRunner('Internal cleanup API');
const secret = process.env.INTERNAL_CLEANUP_SECRET;
const hasSecret = typeof secret === 'string' && secret.length > 0;

export async function runInternalCleanupTests() {
  console.log('Starting internal cleanup API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  if (!hasSecret) {
    await runner.test('POST /api/internal/cleanup/run returns 503 when INTERNAL_CLEANUP_SECRET unset', {
      testNumber: 1,
      method: 'POST',
      endpoint: '/api/internal/cleanup/run',
      body: { tasks: ['unattached_storage'] },
      headers: {},
      expectedStatus: 503,
    });
    runner.printResults();
    runner.saveResults('internal-cleanup-tests.json');
    return runner.getSummary();
  }

  await runner.test('POST /api/internal/cleanup/run without Authorization', {
    testNumber: 1,
    method: 'POST',
    endpoint: '/api/internal/cleanup/run',
    body: { tasks: ['unattached_storage'] },
    headers: {},
    expectedStatus: 401,
  });

  await runner.test('POST /api/internal/cleanup/run with wrong Bearer token', {
    testNumber: 2,
    method: 'POST',
    endpoint: '/api/internal/cleanup/run',
    body: { tasks: ['unattached_storage'] },
    headers: { Authorization: 'Bearer definitely-not-the-real-secret' },
    expectedStatus: 401,
  });

  await runner.test('POST /api/internal/cleanup/run with empty tasks', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/internal/cleanup/run',
    body: { tasks: [] },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  await runner.test('POST /api/internal/cleanup/run with invalid task name', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/internal/cleanup/run',
    body: { tasks: ['nope'] },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  await runner.test('POST /api/internal/cleanup/run with valid secret returns 200', {
    testNumber: 5,
    method: 'POST',
    endpoint: '/api/internal/cleanup/run',
    body: { tasks: ['unattached_storage'] },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 200,
    customValidator: (body) => {
      if (!body || body.ok !== true || !body.results?.unattached_storage) {
        return { passed: false, message: 'Expected ok:true and results.unattached_storage' };
      }
      if (body.results.unattached_storage.status !== 'ok') {
        return {
          passed: false,
          message: `Expected status ok, got ${body.results.unattached_storage.status}`,
        };
      }
      return { passed: true };
    },
  });

  runner.printResults();
  runner.saveResults('internal-cleanup-tests.json');
  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runInternalCleanupTests()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
