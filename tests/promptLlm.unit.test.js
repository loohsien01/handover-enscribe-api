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

test('generate-note schema accepts optional patient_encounter_name (trimmed)', () => {
  const withName = promptLlmGenerateNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
    patient_encounter_name: '  Jane Doe F/U  ',
  });
  assert.equal(withName.success, true);
  assert.equal(withName.data.patient_encounter_name, 'Jane Doe F/U');

  const withoutName = promptLlmGenerateNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
  });
  assert.equal(withoutName.success, true);
  assert.equal(withoutName.data.patient_encounter_name, undefined);
});

test('generate-note schema rejects empty patient_encounter_name', () => {
  const result = promptLlmGenerateNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
    patient_encounter_name: '   ',
  });
  assert.equal(result.success, false);
});

test('generate-and-save schema requires patient_encounter_name', () => {
  const missing = promptLlmGenerateAndSaveNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
  });
  assert.equal(missing.success, false);

  const ok = promptLlmGenerateAndSaveNoteRequestSchema.safeParse({
    recording_file_path: 'recordings/foo.m4a',
    patient_encounter_name: 'Jane Doe F/U',
  });
  assert.equal(ok.success, true);
  assert.equal(ok.data.patient_encounter_name, 'Jane Doe F/U');
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
  const prepIdx = content.indexOf('Pre-visit summary (historical context');
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
  assert.ok(content.includes('merging this pre-visit summary with today\'s visit transcript'));
  assert.ok(content.includes('relevant historical context'));
  assert.ok(content.includes('prefer the transcript as the up-to-date source'));
  assert.ok(content.includes('different patient or visit than the transcript'));
  assert.ok(content.includes('vocabulary section'));
  assert.ok(content.includes('same patient and topic as the transcript'));
  assert.ok(content.includes('forty vs fourteen'));
  assert.ok(
    String(body.system[0].text).includes('merging that historical context'),
    'system preamble should switch to merge framing when PVS present'
  );
});

test('processor-shaped context: null summary omits pre-visit block', () => {
  const body = getSoapNoteRequestBody('Transcript only.', null, buildPreVisitContextFromSummary(null));
  const content = String(body.messages[0].content);
  assert.ok(!content.includes('Pre-visit summary (historical context'));
  assert.ok(content.includes('Here is a patient encounter transcript:'));
  assert.ok(content.includes('Generate SOAP note'));
  assert.ok(
    String(body.system[0].text).includes('base the note solely on the encounter transcript'),
    'system preamble should stay transcript-only when PVS absent'
  );
  assert.ok(!String(body.system[0].text).includes('merging that historical context'));
});

test('patient encounter name is prepended as Title in transcript block (primary source)', () => {
  const maskedTranscript = '{{NAME_1}} is {{AGE_2}} years old. Continue met Foreman ten milligrams.';
  const body = getSoapNoteRequestBody(maskedTranscript, null, null, 'Jane Doe F/U');
  const content = String(body.messages[0].content);
  const titleIdx = content.indexOf('Title: Jane Doe F/U');
  const transcriptIdx = content.indexOf(maskedTranscript);
  assert.ok(titleIdx >= 0, 'encounter title missing from user message');
  assert.ok(transcriptIdx >= 0, 'transcript missing from user message');
  assert.ok(titleIdx < transcriptIdx, 'title must appear at the start of the transcript block');
  // Title is a primary source, not the historical-context pre-visit block
  assert.ok(!content.includes('Pre-visit summary (historical context'));
});

test('encounter title and pre-visit summary coexist (primary title, historical summary)', () => {
  const body = getSoapNoteRequestBody(
    'Doctor discussed follow-up.',
    null,
    { title: 'PVS Title', text: 'Home meds: lisinopril 10mg.' },
    'Robert Chen NP'
  );
  const content = String(body.messages[0].content);
  const titleIdx = content.indexOf('Title: Robert Chen NP');
  const preVisitIdx = content.indexOf('Pre-visit summary (historical context');
  assert.ok(titleIdx >= 0, 'primary encounter title missing');
  assert.ok(preVisitIdx >= 0, 'pre-visit summary block missing');
  assert.ok(titleIdx < preVisitIdx, 'primary title must precede historical-context pre-visit block');
});

test('null encounter name omits Title line', () => {
  const body = getSoapNoteRequestBody('Transcript only.', null, null, null);
  assert.ok(!String(body.messages[0].content).includes('Title:'));
});

test('getSoapNoteRequestBody messages array is single user turn for Bedrock', () => {
  const body = getSoapNoteRequestBody('t', null, { title: 'T', text: 'body' });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(typeof body.messages[0].content, 'string');
});
