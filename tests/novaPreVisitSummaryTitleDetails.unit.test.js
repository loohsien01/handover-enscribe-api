import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VISIT_PREP_UNKNOWN_PATIENT,
  VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA,
  postProcessVisitPrepTitleDetails,
} from '../src/utils/novaVisitPrepTitleDetails.js';
import { getNovaVisitPrepTitleDetailsRequestBody } from '../src/utils/claudeRequestBody.js';
import { extractVisitPrepTitleDetailsWithModel } from '../src/utils/novaVisitPrepTitleDetailsService.js';
import {
  enrichNovaCompletionPollWithVisitPrepTitleDetails,
  visitPrepTitleDetailsRedisKey,
  writeVisitPrepTitleDetails,
} from '../src/utils/novaVisitPrepTitleDetailsCache.js';

test('VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA restricts visit_kind to F/U and NP', () => {
  assert.deepEqual(VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA.properties.visit_kind.enum, ['F/U', 'NP']);
});

test('postProcessVisitPrepTitleDetails normalizes valid JSON object', () => {
  const out = postProcessVisitPrepTitleDetails({
    patient_display_name: 'Jane Doe',
    visit_kind: 'F/U',
  });
  assert.deepEqual(out, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'F/U',
  });
});

test('postProcessVisitPrepTitleDetails parses JSON string', () => {
  const out = postProcessVisitPrepTitleDetails(
    JSON.stringify({ patient_display_name: 'Carl Tard', visit_kind: 'NP' })
  );
  assert.deepEqual(out, {
    patient_display_name: 'Carl Tard',
    visit_kind: 'NP',
  });
});

test('postProcessVisitPrepTitleDetails uses Unknown Patient for empty name', () => {
  const out = postProcessVisitPrepTitleDetails({
    patient_display_name: '   ',
    visit_kind: 'NP',
  });
  assert.equal(out?.patient_display_name, VISIT_PREP_UNKNOWN_PATIENT);
});

test('postProcessVisitPrepTitleDetails rejects invalid visit_kind', () => {
  assert.equal(
    postProcessVisitPrepTitleDetails({ patient_display_name: 'X', visit_kind: 'follow_up' }),
    null
  );
});

test('getNovaVisitPrepTitleDetailsRequestBody includes output_config.format json_schema', () => {
  const body = getNovaVisitPrepTitleDetailsRequestBody({
    modelId: 'haiku-test',
    userMessage: 'Patient Jane Doe follow-up',
    assistantMessage: 'Prep doc',
    outputSchema: VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA,
  });
  assert.equal(body.modelId, 'haiku-test');
  assert.equal(body.output_config?.format?.type, 'json_schema');
  assert.deepEqual(body.output_config?.format?.schema, VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA);
  assert.ok(String(body.messages[0].content).includes('Jane Doe'));
});

test('extractVisitPrepTitleDetailsWithModel uses injectable invokeModel', async () => {
  const details = await extractVisitPrepTitleDetailsWithModel(
    'charts for Jane Doe return visit',
    'assistant',
    async () => ({
      text: JSON.stringify({ patient_display_name: 'Jane Doe', visit_kind: 'F/U' }),
    })
  );
  assert.deepEqual(details, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'F/U',
  });
});

test('enrichNovaCompletionPollWithVisitPrepTitleDetails attaches cached details on complete', async () => {
  /** @type {Record<string, string>} */
  const store = {};
  const redis = {
    async get(key) {
      return store[key] ?? null;
    },
    async set(key, value, _opts) {
      store[key] = value;
    },
  };

  const jobId = 'job-123';
  await writeVisitPrepTitleDetails(redis, jobId, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'NP',
  });
  assert.ok(store[visitPrepTitleDetailsRedisKey(jobId)]);

  const payload = await enrichNovaCompletionPollWithVisitPrepTitleDetails(redis, {
    id: jobId,
    status: 'complete',
  }, { id: jobId, status: 'complete' });

  assert.deepEqual(payload.visit_prep_title_details, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'NP',
  });
});

test('enrichNovaCompletionPollWithVisitPrepTitleDetails attaches on VISIT_PREP_PERSIST_FAILED', async () => {
  /** @type {Record<string, string>} */
  const store = {};
  const redis = {
    async get(key) {
      return store[key] ?? null;
    },
    async set(key, value) {
      store[key] = value;
    },
  };

  const jobId = 'job-fail';
  await writeVisitPrepTitleDetails(redis, jobId, {
    patient_display_name: VISIT_PREP_UNKNOWN_PATIENT,
    visit_kind: 'F/U',
  });

  const payload = await enrichNovaCompletionPollWithVisitPrepTitleDetails(
    redis,
    { id: jobId, status: 'failed', error_code: 'VISIT_PREP_PERSIST_FAILED' },
    { id: jobId, status: 'failed' }
  );

  assert.equal(payload.visit_prep_title_details?.visit_kind, 'F/U');
});

test('enrichNovaCompletionPollWithVisitPrepTitleDetails skips pending jobs', async () => {
  const redis = {
    async get() {
      return null;
    },
  };
  const payload = await enrichNovaCompletionPollWithVisitPrepTitleDetails(
    redis,
    { id: 'x', status: 'running' },
    { id: 'x', status: 'running' }
  );
  assert.equal(payload.visit_prep_title_details, undefined);
});
