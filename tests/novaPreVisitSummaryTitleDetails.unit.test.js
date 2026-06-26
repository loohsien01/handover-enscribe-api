import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRE_VISIT_SUMMARY_UNKNOWN_PATIENT,
  PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA,
  postProcessPreVisitSummaryTitleDetails,
} from '../src/utils/novaPreVisitSummaryTitleDetails.js';
import { getNovaPreVisitSummaryTitleDetailsRequestBody } from '../src/utils/claudeRequestBody.js';
import { extractPreVisitSummaryTitleDetailsWithModel } from '../src/utils/novaPreVisitSummaryTitleDetailsService.js';
import {
  enrichNovaCompletionPollWithPreVisitSummaryTitleDetails,
  preVisitSummaryTitleDetailsRedisKey,
  writePreVisitSummaryTitleDetails,
} from '../src/utils/novaPreVisitSummaryTitleDetailsCache.js';

test('PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA restricts visit_kind to F/U and NP', () => {
  assert.deepEqual(PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA.properties.visit_kind.enum, ['F/U', 'NP']);
});

test('postProcessPreVisitSummaryTitleDetails normalizes valid JSON object', () => {
  const out = postProcessPreVisitSummaryTitleDetails({
    patient_display_name: 'Jane Doe',
    visit_kind: 'F/U',
  });
  assert.deepEqual(out, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'F/U',
  });
});

test('postProcessPreVisitSummaryTitleDetails parses JSON string', () => {
  const out = postProcessPreVisitSummaryTitleDetails(
    JSON.stringify({ patient_display_name: 'Carl Tard', visit_kind: 'NP' })
  );
  assert.deepEqual(out, {
    patient_display_name: 'Carl Tard',
    visit_kind: 'NP',
  });
});

test('postProcessPreVisitSummaryTitleDetails uses Unknown Patient for empty name', () => {
  const out = postProcessPreVisitSummaryTitleDetails({
    patient_display_name: '   ',
    visit_kind: 'NP',
  });
  assert.equal(out?.patient_display_name, PRE_VISIT_SUMMARY_UNKNOWN_PATIENT);
});

test('postProcessPreVisitSummaryTitleDetails rejects invalid visit_kind', () => {
  assert.equal(
    postProcessPreVisitSummaryTitleDetails({ patient_display_name: 'X', visit_kind: 'follow_up' }),
    null
  );
});

test('getNovaPreVisitSummaryTitleDetailsRequestBody includes output_config.format json_schema', () => {
  const body = getNovaPreVisitSummaryTitleDetailsRequestBody({
    modelId: 'haiku-test',
    userMessage: 'Patient Jane Doe follow-up',
    assistantMessage: 'Prep doc',
    outputSchema: PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA,
  });
  assert.equal(body.modelId, 'haiku-test');
  assert.equal(body.output_config?.format?.type, 'json_schema');
  assert.deepEqual(body.output_config?.format?.schema, PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA);
  assert.ok(String(body.messages[0].content).includes('Jane Doe'));
});

test('extractPreVisitSummaryTitleDetailsWithModel uses injectable invokeModel', async () => {
  const details = await extractPreVisitSummaryTitleDetailsWithModel(
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

test('enrichNovaCompletionPollWithPreVisitSummaryTitleDetails attaches cached details on complete', async () => {
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
  await writePreVisitSummaryTitleDetails(redis, jobId, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'NP',
  });
  assert.ok(store[preVisitSummaryTitleDetailsRedisKey(jobId)]);

  const payload = await enrichNovaCompletionPollWithPreVisitSummaryTitleDetails(redis, {
    id: jobId,
    status: 'complete',
  }, { id: jobId, status: 'complete' });

  assert.deepEqual(payload.pre_visit_summary_title_details, {
    patient_display_name: 'Jane Doe',
    visit_kind: 'NP',
  });
});

test('enrichNovaCompletionPollWithPreVisitSummaryTitleDetails attaches on PRE_VISIT_SUMMARY_PERSIST_FAILED', async () => {
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
  await writePreVisitSummaryTitleDetails(redis, jobId, {
    patient_display_name: PRE_VISIT_SUMMARY_UNKNOWN_PATIENT,
    visit_kind: 'F/U',
  });

  const payload = await enrichNovaCompletionPollWithPreVisitSummaryTitleDetails(
    redis,
    { id: jobId, status: 'failed', error_code: 'PRE_VISIT_SUMMARY_PERSIST_FAILED' },
    { id: jobId, status: 'failed' }
  );

  assert.equal(payload.pre_visit_summary_title_details?.visit_kind, 'F/U');
});

test('enrichNovaCompletionPollWithPreVisitSummaryTitleDetails skips pending jobs', async () => {
  const redis = {
    async get() {
      return null;
    },
  };
  const payload = await enrichNovaCompletionPollWithPreVisitSummaryTitleDetails(
    redis,
    { id: 'x', status: 'running' },
    { id: 'x', status: 'running' }
  );
  assert.equal(payload.pre_visit_summary_title_details, undefined);
});
