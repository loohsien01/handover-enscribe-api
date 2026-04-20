/**
 * Internal archive-purge API — auth and validation (full 200 paths only if INTERNAL_CLEANUP_SECRET is set).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { TestRunner } from './testUtils.js';
import { PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES } from '../src/utils/encounterArchivePurge.js';

const runner = new TestRunner('Internal archive-purge API');
const secret = process.env.INTERNAL_CLEANUP_SECRET;
const hasSecret = typeof secret === 'string' && secret.length > 0;

/** Valid task for auth/body-only requests (avoid storage_* integration side effects). */
const SAMPLE_TASK = 'encounter_archive';

/**
 * JSON fetch against Fastify (same pattern as tests/prompt-llm.test.js).
 * @param {string} method
 * @param {string} endpoint path including leading /
 * @param {object | null} body
 * @param {Record<string, string>} [headers]
 */
async function archivePurgeFetch(method, endpoint, body = null, headers = {}) {
  const url = `${runner.baseUrl}${endpoint}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let jsonBody = {};
    try {
      jsonBody = text ? JSON.parse(text) : {};
    } catch {
      // leave empty
    }
    return {
      status: response.status,
      ok: response.ok,
      body: jsonBody,
      rawText: text,
      isNetworkError: false,
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      body: {},
      rawText: null,
      isNetworkError: true,
      error: /** @type {Error} */ (error).message,
    };
  }
}

/**
 * Poll GET /api/internal/archive-purge/jobs/:jobRunId until success | failed or timeout.
 * Logs each poll line and status transitions (mirrors prompt-llm polling style).
 *
 * @param {string} jobRunId
 * @param {string} internalBearerSecret
 * @param {number} [maxWaitMs]
 */
async function pollArchivePurgeJobUntilTerminal(jobRunId, internalBearerSecret, maxWaitMs = 600000) {
  const startTime = Date.now();
  let pollInterval = 10000;
  const backoffCap = 45000;
  let lastStatus = /** @type {string | null} */ (null);
  const auth = { Authorization: `Bearer ${internalBearerSecret}` };

  while (Date.now() - startTime < maxWaitMs) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const response = await archivePurgeFetch(
      'GET',
      `/api/internal/archive-purge/jobs/${jobRunId}`,
      null,
      auth
    );

    if (!response.ok) {
      if (response.isNetworkError || (response.status != null && response.status >= 500)) {
        pollInterval = Math.min(pollInterval * 2, backoffCap);
        console.log(
          `   [${elapsed}s] HTTP ${response.status ?? 'error'} — backoff ${pollInterval / 1000}s (${response.error || response.body?.error || 'server error'})`
        );
        await new Promise((r) => setTimeout(r, pollInterval));
        continue;
      }
      return {
        finalStatus: 'poll_http_error',
        error_message: `Poll failed: HTTP ${response.status}`,
        elapsed,
        lastJob: response.body?.job ?? null,
        pollingFailed: true,
      };
    }

    const job = response.body?.job;
    if (!job || typeof job.status !== 'string') {
      pollInterval = Math.min(pollInterval * 2, backoffCap);
      console.log(`   [${elapsed}s] Invalid poll response (missing job.status); backoff ${pollInterval / 1000}s`);
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    if (job.status !== lastStatus) {
      console.log(`   [${elapsed}s] ${lastStatus ?? '(start)'} → ${job.status}`);
      lastStatus = job.status;
      pollInterval = 10000;
    } else {
      console.log(`   [${elapsed}s] still ${job.status}`);
    }

    const rawResult = job.result && typeof job.result === 'object' ? { ...job.result } : job.result;
    /** @type {unknown} */
    let queueRowsByStatusForFullLog = null;
    if (rawResult && typeof rawResult === 'object' && 'queueRowsByStatus' in rawResult) {
      queueRowsByStatusForFullLog = /** @type {Record<string, unknown>} */ (rawResult).queueRowsByStatus;
      delete /** @type {Record<string, unknown>} */ (rawResult).queueRowsByStatus;
    }
    const snapshot = {
      id: job.id,
      status: job.status,
      error_message: job.error_message ?? null,
      result: rawResult ?? null,
      finished_at: job.finished_at ?? null,
    };
    const snapStr = JSON.stringify(snapshot);
    console.log(`   [${elapsed}s] poll snapshot: ${snapStr.slice(0, 800)}${snapStr.length > 800 ? '…' : ''}`);
    if (queueRowsByStatusForFullLog != null) {
      console.log(
        `   [${elapsed}s] queueRowsByStatus (full, encounter_archive poll):\n${JSON.stringify(queueRowsByStatusForFullLog, null, 2)}`
      );
    }

    if (job.status === 'success' || job.status === 'failed') {
      const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
      return {
        finalStatus: job.status,
        job,
        elapsed: finalElapsed,
      };
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
  return {
    finalStatus: 'timeout',
    error_message: `Job did not finish within ${maxWaitMs / 1000}s`,
    elapsed: finalElapsed,
    timedOut: true,
  };
}

/**
 * Strict happy-path checks after job.status === success (worker can still set success with
 * failedRows or pending work left for another run). `warningRows` (e.g. missing Storage recording
 * after a prior storage_archive) must not fail the job and may be non-empty.
 * @param {Record<string, unknown> | null | undefined} job
 */
function verifyEncounterArchiveAsyncJobFullySuccessful(job) {
  if (!job || typeof job !== 'object') {
    return { ok: false, message: 'Poll returned no job object' };
  }
  if (job.status !== 'success') {
    return { ok: false, message: `Expected job.status "success", got ${String(job.status)}` };
  }
  if (job.error_message != null && String(job.error_message).trim() !== '') {
    return { ok: false, message: `job.error_message must be empty on success, got: ${job.error_message}` };
  }
  const r = job.result;
  if (!r || typeof r !== 'object') {
    return { ok: false, message: 'job.result must be an object (worker final payload)' };
  }
  if (r.phase !== 'done') {
    return { ok: false, message: `result.phase must be "done", got ${String(r.phase)}` };
  }
  const fr = r.failedRows;
  if (!Array.isArray(fr)) {
    return { ok: false, message: 'result.failedRows must be an array' };
  }
  if (fr.length > 0) {
    return {
      ok: false,
      message: `result.failedRows must be empty (got ${fr.length}): ${JSON.stringify(fr).slice(0, 400)}`,
    };
  }
  const wr = r.warningRows;
  if (wr != null && !Array.isArray(wr)) {
    return { ok: false, message: 'result.warningRows must be an array when present' };
  }
  const qbs = r.queueRowsByStatus;
  if (!Array.isArray(qbs)) {
    return { ok: false, message: 'result.queueRowsByStatus must be an array' };
  }
  if (qbs.length !== PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES.length) {
    return {
      ok: false,
      message: `result.queueRowsByStatus must have ${PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES.length} entries (one per status), got ${qbs.length}`,
    };
  }
  for (let i = 0; i < PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES.length; i++) {
    const expected = PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES[i];
    const slot = qbs[i];
    if (!slot || typeof slot !== 'object') {
      return { ok: false, message: `queueRowsByStatus[${i}] must be an object` };
    }
    const st = /** @type {{ status?: unknown }} */ (slot).status;
    if (st !== expected) {
      return {
        ok: false,
        message: `queueRowsByStatus[${i}].status expected "${expected}", got ${String(st)}`,
      };
    }
    const qids = /** @type {{ queueIds?: unknown }} */ (slot).queueIds;
    if (!Array.isArray(qids) || !qids.every((x) => typeof x === 'string')) {
      return { ok: false, message: `queueRowsByStatus[${i}].queueIds must be an array of strings` };
    }
  }
  if (r.pendingRemaining !== false) {
    return {
      ok: false,
      message: `result.pendingRemaining must be false (all pending rows for this job_run drained). Got: ${String(r.pendingRemaining)}`,
    };
  }
  const nd = r.queueRowsNotDbDeleted;
  if (typeof nd === 'number' && nd !== 0) {
    return {
      ok: false,
      message: `result.queueRowsNotDbDeleted must be 0 when job succeeded, got ${nd}`,
    };
  }
  return { ok: true, message: '' };
}

export async function runArchivePurgeTests() {
  console.log('Starting internal archive-purge API tests...');
  console.log(`Server: ${runner.baseUrl}\n`);

  if (!hasSecret) {
    await runner.test('POST /api/internal/archive-purge/run returns 503 when INTERNAL_CLEANUP_SECRET unset', {
      testNumber: 1,
      method: 'POST',
      endpoint: '/api/internal/archive-purge/run',
      body: { tasks: [SAMPLE_TASK] },
      headers: {},
      expectedStatus: 503,
    });
    runner.printResults();
    runner.saveResults('archive-purge-tests.json');
    return runner.getSummary();
  }

  await runner.test('POST /api/internal/archive-purge/run without Authorization', {
    testNumber: 1,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: [SAMPLE_TASK] },
    headers: {},
    expectedStatus: 401,
  });

  await runner.test('POST /api/internal/archive-purge/run with wrong Bearer token', {
    testNumber: 2,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: [SAMPLE_TASK] },
    headers: { Authorization: 'Bearer definitely-not-the-real-secret' },
    expectedStatus: 401,
  });

  await runner.test('POST /api/internal/archive-purge/run with empty tasks', {
    testNumber: 3,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: [] },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  await runner.test('POST /api/internal/archive-purge/run with invalid task name', {
    testNumber: 4,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: ['nope'] },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  /*
  // Commented out: storage_manifest mutates archive.storage_objects / Storage listing — interferes with encounter_archive testing.
  await runner.test('POST /api/internal/archive-purge/run storage_manifest returns 200', {
    testNumber: 5,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: ['storage_manifest'] },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 200,
    onBeforeRequest: ({ url, method }) => {
      console.log(
        `[archive-purge test 5] ${new Date().toISOString()} → ${method} ${url} (storage_manifest can take 2+ minutes; waiting for response…)`,
      );
    },
    customValidator: (body) => {
      if (!body || body.ok !== true || !body.results?.storage_manifest) {
        return { passed: false, message: 'Expected ok:true and results.storage_manifest' };
      }
      if (body.results.storage_manifest.status !== 'ok') {
        return {
          passed: false,
          message: `Expected status ok, got ${body.results.storage_manifest.status}: ${body.results.storage_manifest.message || ''}`,
        };
      }
      return { passed: true };
    },
    onSuccess: () => {
      console.log(`[archive-purge test 5] ${new Date().toISOString()} → finished OK`);
    },
  });

  const archiveBucket = process.env.AWS_ARCHIVE_S3_BUCKET;
  if (typeof archiveBucket === 'string' && archiveBucket.trim().length > 0) {
    await runner.test('POST /api/internal/archive-purge/run storage_archive returns 200', {
      testNumber: 6,
      method: 'POST',
      endpoint: '/api/internal/archive-purge/run',
      body: { tasks: ['storage_archive'] },
      headers: { Authorization: `Bearer ${secret}` },
      expectedStatus: 200,
      onBeforeRequest: ({ url, method }) => {
        console.log(
          `[archive-purge test 6] ${new Date().toISOString()} → ${method} ${url} (storage_archive; waiting for response…)`,
        );
      },
      customValidator: (body) => {
        if (!body || body.ok !== true || !body.results?.storage_archive) {
          return { passed: false, message: 'Expected ok:true and results.storage_archive' };
        }
        if (body.results.storage_archive.status !== 'ok') {
          return {
            passed: false,
            message: `Expected status ok, got ${body.results.storage_archive.status}: ${body.results.storage_archive.message || ''}`,
          };
        }
        return { passed: true };
      },
      onSuccess: () => {
        console.log(`[archive-purge test 6] ${new Date().toISOString()} → finished OK`);
      },
    });
  } else {
    console.log(
      '\n  (Skipped test 6: set AWS_ARCHIVE_S3_BUCKET in .env.local to run storage_archive integration test.)\n'
    );
  }
  */

  // --- Test 5: async encounter_archive happy path (202 + poll until success) ---
  const archiveBucket = process.env.AWS_ARCHIVE_S3_BUCKET;
  const hasArchiveBucket = typeof archiveBucket === 'string' && archiveBucket.trim().length > 0;

  if (!hasArchiveBucket) {
    console.log(
      '\n⏭️  Test 5 SKIPPED: set AWS_ARCHIVE_S3_BUCKET (and Supabase archive migrations) to run encounter_archive async integration + polling.\n'
    );
    runner.results.push({
      name: 'POST encounter_archive async=true → poll job until success (happy path)',
      passed: true,
      skipped: true,
      endpoint: '/api/internal/archive-purge/run → GET …/jobs/:jobRunId',
      method: 'POST → GET (polling)',
      status: null,
      expectedStatus: null,
      body: {},
      customMessage: 'Skipped: AWS_ARCHIVE_S3_BUCKET not set',
      testNumber: 5,
      timestamp: new Date().toISOString(),
    });
  } else {
    console.log(
      '\n⏳ Test 5: POST encounter_archive with async=true (202), then poll GET /jobs/:jobRunId (10s interval, backoff to 45s on 5xx; max 10 min)…\n'
    );

    const accept = await archivePurgeFetch(
      'POST',
      '/api/internal/archive-purge/run',
      {
        tasks: ['encounter_archive'],
        async: true,
        maxEnqueue: 10,
        maxProcessPerJob: null,
      },
      { Authorization: `Bearer ${secret}` }
    );

    let test5Passed = false;
    let test5Message = '';
    let jobRunId = /** @type {string | null} */ (null);
    /** @type {Awaited<ReturnType<typeof pollArchivePurgeJobUntilTerminal>> | null} */
    let pollOutcome = null;

    if (!accept.ok || accept.status !== 202) {
      test5Message = `Expected 202 Accepted, got HTTP ${accept.status}: ${accept.rawText?.slice(0, 200) || ''}`;
    } else if (!accept.body?.ok || !accept.body?.jobRunId) {
      test5Message = '202 response missing ok:true or jobRunId';
    } else {
      jobRunId = String(accept.body.jobRunId);
      console.log(`✅ Accepted async job: jobRunId=${jobRunId}`);
      if (accept.body.pollPath) {
        console.log(`   pollPath: ${accept.body.pollPath}`);
      }

      pollOutcome = await pollArchivePurgeJobUntilTerminal(jobRunId, secret);

      if (pollOutcome.timedOut) {
        test5Message = pollOutcome.error_message || 'Polling timed out';
      } else if (pollOutcome.pollingFailed) {
        test5Message = pollOutcome.error_message || 'Polling failed';
      } else if (pollOutcome.finalStatus === 'failed') {
        const err =
          pollOutcome.job?.error_message ||
          pollOutcome.job?.result?.message ||
          'job status failed';
        test5Message = `Job failed: ${err}`;
      } else if (pollOutcome.finalStatus === 'success') {
        const v = verifyEncounterArchiveAsyncJobFullySuccessful(pollOutcome.job);
        if (!v.ok) {
          test5Passed = false;
          test5Message = `Job status success but incomplete: ${v.message} (elapsed ${pollOutcome.elapsed}s)`;
        } else {
          test5Passed = true;
          const wn = Array.isArray(pollOutcome.job?.result?.warningRows)
            ? pollOutcome.job.result.warningRows.length
            : 0;
          test5Message = `Verified in ${pollOutcome.elapsed}s: status=success, phase=done, failedRows=[], warningRows=${wn}, pendingRemaining=false`;
        }
      } else {
        test5Message = `Unexpected terminal state: ${pollOutcome.finalStatus}`;
      }
    }

    const finalJob = pollOutcome?.job ?? null;

    runner.results.push({
      name: 'POST encounter_archive async=true → poll job until success (happy path)',
      passed: test5Passed,
      endpoint: '/api/internal/archive-purge/run',
      method: 'POST → GET (polling)',
      status: accept.status,
      expectedStatus: 202,
      body: {
        accept202: accept.body,
        finalPoll: finalJob != null ? { ok: true, job: finalJob } : null,
      },
      requestBody: {
        tasks: ['encounter_archive'],
        async: true,
        maxEnqueue: 10,
        maxProcessPerJob: null,
      },
      customMessage: test5Message,
      testNumber: 5,
      timestamp: new Date().toISOString(),
    });

    const mark = test5Passed ? '✅' : '❌';
    console.log(`\n${mark} Test 5: encounter_archive async happy path`);
    console.log(`   ${test5Message}\n`);
  }

  await runner.test('POST async=true rejects multiple tasks', {
    testNumber: 6,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: ['encounter_archive', 'storage_archive'], async: true },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  await runner.test('POST async=true rejects non-encounter_archive task', {
    testNumber: 7,
    method: 'POST',
    endpoint: '/api/internal/archive-purge/run',
    body: { tasks: ['storage_archive'], async: true },
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  await runner.test('GET /api/internal/archive-purge/jobs/:jobRunId without Authorization', {
    testNumber: 8,
    method: 'GET',
    endpoint: '/api/internal/archive-purge/jobs/00000000-0000-4000-8000-000000000001',
    headers: {},
    expectedStatus: 401,
  });

  await runner.test('GET /api/internal/archive-purge/jobs/:jobRunId invalid uuid', {
    testNumber: 9,
    method: 'GET',
    endpoint: '/api/internal/archive-purge/jobs/not-a-uuid',
    headers: { Authorization: `Bearer ${secret}` },
    expectedStatus: 400,
  });

  runner.printResults(9);
  runner.saveResults('archive-purge-tests.json');
  return runner.getSummary();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runArchivePurgeTests()
    .then((summary) => process.exit(summary.failed > 0 ? 1 : 0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
