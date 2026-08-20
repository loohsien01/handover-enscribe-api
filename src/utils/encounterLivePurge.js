/**
 * User-facing patient encounter live purge (no S3 archive).
 * Mirrors archive DB delete order from `encounterArchivePurge.js`, plus linked Nova chats.
 * Legacy `soapNotes` are intentionally out of scope (same as archive).
 *
 * Flow: inventory → block on in-flight jobs → single Postgres transaction (source of truth) →
 * Redis + Storage audio cleanup **fire-and-forget** (hot cache / blobs; do not block HTTP).
 */
import { getSupabasePostgresPool } from './supabasePostgresPool.js';
import { pgIdToNumber, pgCoerceBigIntFields } from './pgQueryHelpers.js';
import {
  clearOwnedNovaChatRedis,
  chatSessionsTable,
  novaChatCompletionJobsTable,
} from './novaChatPersistence.js';
import {
  normalizeRecordingStorageKey,
  deleteRecordingObject,
  isMissingRecordingObjectError,
} from './recordingsStorage.js';

export const ENCOUNTER_DELETE_IN_FLIGHT = 'ENCOUNTER_DELETE_IN_FLIGHT';

const PROMPT_LLM_IN_FLIGHT = ['pending', 'transcribing', 'generating'];
const NOVA_IN_FLIGHT = ['pending', 'running'];

/**
 * @typedef {{ id: string, status: string, recording_file_path?: string | null, pre_visit_summary_id?: string | null }} InFlightPromptLlmJob
 * @typedef {{ id: string, status: string, chat_id: string }} InFlightNovaJob
 */

export class EncounterDeleteInFlightError extends Error {
  /**
   * @param {{ promptLlmJobs: InFlightPromptLlmJob[], novaJobs: InFlightNovaJob[] }} detail
   */
  constructor(detail) {
    super('Cannot delete encounter while jobs are in flight');
    this.name = 'EncounterDeleteInFlightError';
    this.code = ENCOUNTER_DELETE_IN_FLIGHT;
    this.promptLlmJobs = detail.promptLlmJobs;
    this.novaJobs = detail.novaJobs;
  }
}

export class EncounterNotFoundError extends Error {
  constructor() {
    super('Encounter not found');
    this.name = 'EncounterNotFoundError';
  }
}

/**
 * @param {import('pg').PoolClient | { query: Function }} client
 * @param {string|number} encounterId
 * @param {string} userId
 */
async function loadOwnedEncounter(client, encounterId, userId) {
  const { rows } = await client.query(
    `SELECT * FROM public."patientEncounters"
      WHERE id = $1 AND user_id = $2`,
    [encounterId, userId]
  );
  return rows[0] ?? null;
}

/**
 * @param {import('pg').PoolClient | { query: Function }} client
 * @param {string|number} encounterId
 * @param {string} userId
 */
export async function collectEncounterPurgeInventory(client, encounterId, userId) {
  const { rows: recordings } = await client.query(
    `SELECT id, recording_file_path
       FROM public.recordings
      WHERE "patientEncounter_id" = $1 AND user_id = $2`,
    [encounterId, userId]
  );

  const recordingIds = recordings.map((r) => r.id).filter((id) => id != null);
  const recordingFilePaths = [
    ...new Set(
      recordings
        .map((r) => (typeof r.recording_file_path === 'string' ? r.recording_file_path : null))
        .filter(Boolean)
    ),
  ];

  let transcriptIds = [];
  if (recordingIds.length > 0) {
    const { rows: transcripts } = await client.query(
      `SELECT id FROM public.transcripts WHERE recording_id = ANY($1::bigint[])`,
      [recordingIds]
    );
    transcriptIds = transcripts.map((t) => t.id).filter((id) => id != null);
  }

  const { rows: notes } = await client.query(
    `SELECT id FROM public.notes
      WHERE "patientEncounter_id" = $1 AND user_id = $2`,
    [encounterId, userId]
  );
  const noteIds = notes.map((n) => n.id).filter((id) => id != null);

  const { rows: pvsRows } = await client.query(
    `SELECT id, chat_id
       FROM public.pre_visit_summaries
      WHERE "patientEncounter_id" = $1 AND user_id = $2`,
    [encounterId, userId]
  );
  const preVisitSummaryIds = pvsRows.map((p) => p.id).filter(Boolean);
  const chatIds = [
    ...new Set(pvsRows.map((p) => (typeof p.chat_id === 'string' ? p.chat_id : null)).filter(Boolean)),
  ];

  return {
    recordingIds,
    recordingFilePaths,
    transcriptIds,
    noteIds,
    preVisitSummaryIds,
    chatIds,
  };
}

/**
 * @param {import('pg').PoolClient | { query: Function }} client
 * @param {string} userId
 * @param {{ recordingFilePaths: string[], preVisitSummaryIds: string[], noteIds: unknown[], chatIds: string[] }} inventory
 */
export async function findEncounterInFlightJobs(client, userId, inventory) {
  const { recordingFilePaths, preVisitSummaryIds, noteIds, chatIds } = inventory;

  /** @type {InFlightPromptLlmJob[]} */
  let promptLlmJobs = [];
  if (recordingFilePaths.length > 0 || preVisitSummaryIds.length > 0 || noteIds.length > 0) {
    // jobs.status is enum job_status — compare via ::text (same pattern as nova jobs below).
    const { rows } = await client.query(
      `SELECT id, status, recording_file_path, pre_visit_summary_id
         FROM public.jobs
        WHERE user_id = $1
          AND status::text = ANY($2::text[])
          AND (
            (cardinality($3::text[]) > 0 AND recording_file_path = ANY($3::text[]))
            OR (cardinality($4::uuid[]) > 0 AND pre_visit_summary_id = ANY($4::uuid[]))
            OR (cardinality($5::bigint[]) > 0 AND note_id = ANY($5::bigint[]))
          )`,
      [userId, PROMPT_LLM_IN_FLIGHT, recordingFilePaths, preVisitSummaryIds, noteIds]
    );
    promptLlmJobs = rows;
  }

  /** @type {InFlightNovaJob[]} */
  let novaJobs = [];
  if (chatIds.length > 0) {
    const { rows } = await client.query(
      `SELECT id, status, chat_id
         FROM public.${novaChatCompletionJobsTable}
        WHERE user_id = $1
          AND chat_id = ANY($2::uuid[])
          AND status::text = ANY($3::text[])`,
      [userId, chatIds, NOVA_IN_FLIGHT]
    );
    novaJobs = rows;
  }

  return { promptLlmJobs, novaJobs };
}

/**
 * @param {import('pg').PoolClient | { query: Function }} client
 * @param {string|number} encounterId
 * @param {string} userId
 * @param {Awaited<ReturnType<typeof collectEncounterPurgeInventory>>} inventory
 * @param {{ includeNovaChats?: boolean }} [opts]
 */
export async function deleteEncounterSubtreeRows(client, encounterId, userId, inventory, opts = {}) {
  const includeNovaChats = opts.includeNovaChats !== false;
  const {
    recordingIds,
    recordingFilePaths,
    noteIds,
    preVisitSummaryIds,
    chatIds,
  } = inventory;

  /** @type {string[]} */
  let deletedJobIds = [];
  if (recordingFilePaths.length > 0 || preVisitSummaryIds.length > 0 || noteIds.length > 0) {
    const { rows } = await client.query(
      `DELETE FROM public.jobs
        WHERE user_id = $1
          AND (
            (cardinality($2::text[]) > 0 AND recording_file_path = ANY($2::text[]))
            OR (cardinality($3::uuid[]) > 0 AND pre_visit_summary_id = ANY($3::uuid[]))
            OR (cardinality($4::bigint[]) > 0 AND note_id = ANY($4::bigint[]))
          )
        RETURNING id`,
      [userId, recordingFilePaths, preVisitSummaryIds, noteIds]
    );
    deletedJobIds = rows.map((r) => r.id);
  }

  /** @type {unknown[]} */
  let deletedTranscriptIds = [];
  if (recordingIds.length > 0) {
    const { rows } = await client.query(
      `DELETE FROM public.transcripts
        WHERE recording_id = ANY($1::bigint[])
        RETURNING id`,
      [recordingIds]
    );
    deletedTranscriptIds = rows.map((r) => r.id);
  }

  const { rows: deletedRecordings } = await client.query(
    `DELETE FROM public.recordings
      WHERE "patientEncounter_id" = $1 AND user_id = $2
      RETURNING id`,
    [encounterId, userId]
  );

  const { rows: deletedNotes } = await client.query(
    `DELETE FROM public.notes
      WHERE "patientEncounter_id" = $1 AND user_id = $2
      RETURNING id`,
    [encounterId, userId]
  );

  const { rows: deletedPvs } = await client.query(
    `DELETE FROM public.pre_visit_summaries
      WHERE "patientEncounter_id" = $1 AND user_id = $2
      RETURNING id, chat_id`,
    [encounterId, userId]
  );

  /** @type {string[]} */
  let deletedChatIds = [];
  if (includeNovaChats && chatIds.length > 0) {
    const { rows } = await client.query(
      `DELETE FROM public.${chatSessionsTable}
        WHERE id = ANY($1::uuid[]) AND user_id = $2
        RETURNING id`,
      [chatIds, userId]
    );
    deletedChatIds = rows.map((r) => r.id);
  }

  const { rows: encounterRows } = await client.query(
    `DELETE FROM public."patientEncounters"
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [encounterId, userId]
  );
  const encounter = encounterRows[0] ?? null;
  if (!encounter) {
    throw new EncounterNotFoundError();
  }

  return {
    encounter,
    deleted: {
      patientEncounter_id: pgIdToNumber(encounter.id),
      note_ids: deletedNotes.map((r) => pgIdToNumber(r.id)),
      recording_ids: deletedRecordings.map((r) => pgIdToNumber(r.id)),
      transcript_ids: deletedTranscriptIds.map((id) => pgIdToNumber(id)),
      job_ids: deletedJobIds,
      pre_visit_summary_ids: deletedPvs.map((r) => r.id),
      chat_ids: deletedChatIds,
      recording_file_paths: recordingFilePaths,
    },
    chatIdsForRedis: deletedChatIds,
    recordingFilePaths,
  };
}

/**
 * Single-transaction live Postgres purge for an owned encounter.
 *
 * @param {string|number} encounterId
 * @param {string} userId
 * @param {{ includeNovaChats?: boolean, pool?: import('pg').Pool }} [opts]
 */
export async function purgeEncounterLiveSubtreeDb(encounterId, userId, opts = {}) {
  const includeNovaChats = opts.includeNovaChats !== false;
  const pool = opts.pool ?? getSupabasePostgresPool();
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const encounter = await loadOwnedEncounter(client, encounterId, userId);
    if (!encounter) {
      throw new EncounterNotFoundError();
    }

    const inventory = await collectEncounterPurgeInventory(client, encounterId, userId);
    const inFlight = await findEncounterInFlightJobs(client, userId, inventory);
    if (inFlight.promptLlmJobs.length > 0 || inFlight.novaJobs.length > 0) {
      throw new EncounterDeleteInFlightError(inFlight);
    }

    const result = await deleteEncounterSubtreeRows(client, encounterId, userId, inventory, {
      includeNovaChats,
    });

    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (err) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} recordingFilePaths
 * @returns {Promise<{ code: string, path: string, message?: string }[]>}
 */
export async function bestEffortDeleteRecordingAudio(supabase, recordingFilePaths) {
  /** @type {{ code: string, path: string, message?: string }[]} */
  const warnings = [];

  for (const path of recordingFilePaths) {
    const normalized = normalizeRecordingStorageKey(path);
    if (!normalized) continue;
    try {
      await deleteRecordingObject(supabase, normalized);
    } catch (err) {
      if (isMissingRecordingObjectError(err)) {
        warnings.push({ code: 'RECORDING_AUDIO_MISSING', path: normalized });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[encounterLivePurge] audio delete failed:', normalized, message);
        warnings.push({ code: 'RECORDING_AUDIO_DELETE_FAILED', path: normalized, message });
      }
    }
  }

  return warnings;
}

/**
 * Full user-facing encounter purge: Postgres transaction only on the critical path.
 * Redis (hot cache) and Storage audio are cleared asynchronously after commit.
 *
 * @param {string|number} encounterId
 * @param {string} userId
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient, includeNovaChats?: boolean, pool?: import('pg').Pool }} opts
 */
export async function purgeEncounterLiveSubtree(encounterId, userId, opts) {
  const { supabase, includeNovaChats = true, pool } = opts;

  const dbResult = await purgeEncounterLiveSubtreeDb(encounterId, userId, {
    includeNovaChats,
    pool,
  });

  const chatIds = dbResult.chatIdsForRedis;
  const paths = dbResult.recordingFilePaths;

  if (chatIds.length > 0 || paths.length > 0) {
    setImmediate(() => {
      void (async () => {
        for (const chatId of chatIds) {
          try {
            await clearOwnedNovaChatRedis(userId, chatId);
          } catch (err) {
            console.warn('[encounterLivePurge] async redis cleanup failed:', chatId, err);
          }
        }
        if (paths.length > 0) {
          try {
            const warnings = await bestEffortDeleteRecordingAudio(supabase, paths);
            for (const w of warnings) {
              console.warn('[encounterLivePurge] async audio cleanup:', w);
            }
          } catch (err) {
            console.warn('[encounterLivePurge] async audio cleanup failed:', err);
          }
        }
      })();
    });
  }

  return {
    data: pgCoerceBigIntFields(dbResult.encounter, ['id']),
    deleted: dbResult.deleted,
    warnings: [],
  };
}
