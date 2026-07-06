/**
 * Prompt LLM unit tests — generate-note request schemas and SOAP prompt assembly
 * (including optional pre_visit_summary_id).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  promptLlmGenerateNoteRequestSchema,
  promptLlmGenerateAndSaveNoteRequestSchema,
} from '../src/fastify/schemas/requests.js';
import { getSoapNoteRequestBody } from '../src/utils/claudeRequestBody.js';

const SUMMARY_ID = '550e8400-e29b-41d4-a716-446655440000';

/** Same shape as promptLlmProcessor preVisitContext */
function buildPreVisitContextFromSummary(summary) {
  if (!summary) return null;
  return { title: summary.title, text: summary.text };
}

// --- Request schema ---

test('promptLlmGenerateNoteRequestSchema accepts optional pre_visit_summary_id', () => {
  const withSummary = promptLlmGenerateNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
    pre_visit_summary_id: SUMMARY_ID,
  });
  assert.equal(withSummary.success, true);
  assert.equal(withSummary.data.pre_visit_summary_id, SUMMARY_ID);

  const withoutSummary = promptLlmGenerateNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
  });
  assert.equal(withoutSummary.success, true);
  assert.equal(withoutSummary.data.pre_visit_summary_id, undefined);
});

test('promptLlmGenerateNoteRequestSchema rejects invalid pre_visit_summary_id', () => {
  const result = promptLlmGenerateNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
    pre_visit_summary_id: 'not-a-uuid',
  });
  assert.equal(result.success, false);
});

test('promptLlmGenerateAndSaveNoteRequestSchema inherits pre_visit_summary_id', () => {
  const result = promptLlmGenerateAndSaveNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
    patient_encounter_name: 'Jane Doe',
    pre_visit_summary_id: SUMMARY_ID,
  });
  assert.equal(result.success, true);
  assert.equal(result.data.pre_visit_summary_id, SUMMARY_ID);
});

// --- SOAP prompt (processor-shaped, immediately before Bedrock) ---

test('processor-shaped context: transcript precedes pre-visit block in user message', () => {
  const maskedTranscript = '{{NAME_1}} is {{AGE_2}} years old. Continue met Foreman ten milligrams.';
  const summary = {
    title: 'Jane Doe F/U',
    text: 'Patient Jane Doe on metformin 500mg daily. Prior BP stable.',
  };
  const body = getSoapNoteRequestBody(
    maskedTranscript,
    null,
    buildPreVisitContextFromSummary(summary)
  );
  const content = String(body.messages[0].content);
  const transcriptIdx = content.indexOf(maskedTranscript);
  const prepIdx = content.indexOf('Pre-visit summary (reference only');
  assert.ok(transcriptIdx >= 0, 'transcript missing from user message');
  assert.ok(prepIdx >= 0, 'pre-visit block missing from user message');
  assert.ok(transcriptIdx < prepIdx, 'transcript must appear before pre-visit summary');
});

test('processor-shaped context: title and body both appear in Claude user payload', () => {
  const summary = {
    title: 'Robert Chen NP 7/6/26',
    text: 'Allergies: penicillin. Home meds: lisinopril 10mg.',
  };
  const body = getSoapNoteRequestBody('Doctor discussed follow-up.', null, buildPreVisitContextFromSummary(summary));
  const content = String(body.messages[0].content);
  assert.ok(content.includes('Title (prefer spellings'));
  assert.ok(content.includes('Robert Chen NP 7/6/26'));
  assert.ok(content.includes('Allergies: penicillin'));
  assert.ok(content.includes('sole authority for what was discussed today'));
  assert.ok(content.includes('forty vs fourteen'));
});

test('processor-shaped context: null summary omits pre-visit block', () => {
  const body = getSoapNoteRequestBody('Transcript only.', null, buildPreVisitContextFromSummary(null));
  assert.ok(!String(body.messages[0].content).includes('Pre-visit summary (reference only'));
});

test('getSoapNoteRequestBody messages array is single user turn for Bedrock', () => {
  const body = getSoapNoteRequestBody('t', null, { title: 'T', text: 'body' });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(typeof body.messages[0].content, 'string');
});
