import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectEncounterPurgeInventory,
  findEncounterInFlightJobs,
  deleteEncounterSubtreeRows,
  EncounterDeleteInFlightError,
  ENCOUNTER_DELETE_IN_FLIGHT,
} from '../src/utils/encounterLivePurge.js';

/**
 * @param {Array<{ match?: RegExp, rows?: object[], rowCount?: number }>} script
 */
function mockClient(script) {
  let i = 0;
  return {
    query: async (sql) => {
      const step = script[i++];
      assert.ok(step, `Unexpected query #${i}: ${String(sql).slice(0, 120)}`);
      if (step.match) {
        assert.match(String(sql), step.match, `Query #${i} SQL mismatch`);
      }
      return { rows: step.rows ?? [], rowCount: step.rowCount ?? (step.rows?.length ?? 0) };
    },
  };
}

test('collectEncounterPurgeInventory gathers subtree ids and paths', async () => {
  const client = mockClient([
    {
      match: /FROM public\.recordings/i,
      rows: [
        { id: '10', recording_file_path: 'u/a.wav' },
        { id: '11', recording_file_path: 'u/a.wav' },
        { id: '12', recording_file_path: 'u/b.wav' },
      ],
    },
    {
      match: /FROM public\.transcripts/i,
      rows: [{ id: '100' }, { id: '101' }],
    },
    {
      match: /FROM public\.notes/i,
      rows: [{ id: '20' }],
    },
    {
      match: /FROM public\.pre_visit_summaries/i,
      rows: [
        { id: 'pvs-1', chat_id: 'chat-1' },
        { id: 'pvs-2', chat_id: null },
      ],
    },
  ]);

  const inventory = await collectEncounterPurgeInventory(client, 1, 'user-1');
  assert.deepEqual(inventory.recordingIds, ['10', '11', '12']);
  assert.deepEqual(inventory.recordingFilePaths, ['u/a.wav', 'u/b.wav']);
  assert.deepEqual(inventory.transcriptIds, ['100', '101']);
  assert.deepEqual(inventory.noteIds, ['20']);
  assert.deepEqual(inventory.preVisitSummaryIds, ['pvs-1', 'pvs-2']);
  assert.deepEqual(inventory.chatIds, ['chat-1']);
});

test('findEncounterInFlightJobs returns prompt-llm and nova in-flight rows', async () => {
  /** @type {string[]} */
  const sqlSeen = [];
  const client = {
    query: async (sql) => {
      sqlSeen.push(String(sql));
      if (/FROM public\.jobs/i.test(sql)) {
        // Must cast enum job_status → text; bare `status = ANY($n::text[])` fails on RDS.
        assert.match(sql, /status::text = ANY\(\$2::text\[\]\)/);
        return {
          rows: [{ id: 'job-1', status: 'generating', recording_file_path: 'u/a.wav' }],
          rowCount: 1,
        };
      }
      if (/nova_chat_completion_jobs/i.test(sql)) {
        assert.match(sql, /status::text = ANY\(\$3::text\[\]\)/);
        return {
          rows: [{ id: 'nova-1', status: 'running', chat_id: 'chat-1' }],
          rowCount: 1,
        };
      }
      assert.fail(`Unexpected SQL: ${sql.slice(0, 160)}`);
    },
  };

  const inFlight = await findEncounterInFlightJobs(client, 'user-1', {
    recordingFilePaths: ['u/a.wav'],
    preVisitSummaryIds: ['pvs-1'],
    noteIds: [20],
    chatIds: ['chat-1'],
  });

  assert.equal(sqlSeen.length, 2);
  assert.equal(inFlight.promptLlmJobs.length, 1);
  assert.equal(inFlight.novaJobs.length, 1);
  assert.equal(new EncounterDeleteInFlightError(inFlight).code, ENCOUNTER_DELETE_IN_FLIGHT);
});

test('deleteEncounterSubtreeRows deletes in archive order and returns inventory', async () => {
  const client = mockClient([
    { match: /DELETE FROM public\.jobs/i, rows: [{ id: 'job-1' }] },
    { match: /DELETE FROM public\.transcripts/i, rows: [{ id: '100' }] },
    { match: /DELETE FROM public\.recordings/i, rows: [{ id: '10' }] },
    { match: /DELETE FROM public\.notes/i, rows: [{ id: '20' }] },
    {
      match: /DELETE FROM public\.pre_visit_summaries/i,
      rows: [{ id: 'pvs-1', chat_id: 'chat-1' }],
    },
    { match: /DELETE FROM public\.chat_sessions/i, rows: [{ id: 'chat-1' }] },
    {
      match: /DELETE FROM public\."patientEncounters"/i,
      rows: [{ id: '1', user_id: 'user-1', encrypted_name: 'x' }],
    },
  ]);

  const result = await deleteEncounterSubtreeRows(
    client,
    1,
    'user-1',
    {
      recordingIds: [10],
      recordingFilePaths: ['u/a.wav'],
      transcriptIds: [100],
      noteIds: [20],
      preVisitSummaryIds: ['pvs-1'],
      chatIds: ['chat-1'],
    },
    { includeNovaChats: true }
  );

  assert.equal(result.deleted.patientEncounter_id, 1);
  assert.deepEqual(result.deleted.job_ids, ['job-1']);
  assert.deepEqual(result.deleted.chat_ids, ['chat-1']);
  assert.deepEqual(result.deleted.recording_file_paths, ['u/a.wav']);
  assert.deepEqual(result.chatIdsForRedis, ['chat-1']);
});

test('deleteEncounterSubtreeRows can skip Nova chat delete', async () => {
  const client = mockClient([
    { match: /DELETE FROM public\.recordings/i, rows: [] },
    { match: /DELETE FROM public\.notes/i, rows: [] },
    { match: /DELETE FROM public\.pre_visit_summaries/i, rows: [] },
    // no jobs/transcripts (empty inventory); no chat_sessions when includeNovaChats=false
    {
      match: /DELETE FROM public\."patientEncounters"/i,
      rows: [{ id: '5', user_id: 'user-1' }],
    },
  ]);

  const result = await deleteEncounterSubtreeRows(
    client,
    5,
    'user-1',
    {
      recordingIds: [],
      recordingFilePaths: [],
      transcriptIds: [],
      noteIds: [],
      preVisitSummaryIds: [],
      chatIds: ['chat-should-not-delete'],
    },
    { includeNovaChats: false }
  );

  assert.deepEqual(result.deleted.chat_ids, []);
  assert.equal(result.deleted.patientEncounter_id, 5);
});
