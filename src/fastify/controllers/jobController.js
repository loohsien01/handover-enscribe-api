/**
 * Job Controller
 *
 * Handles job creation and status polling for SOAP note generation
 * - POST /api/jobs/prompt-llm/generate-note — create job, spawn async processor
 * - POST /api/jobs/prompt-llm/generate-and-save-note — same + persist encounter when done
 * - GET /api/jobs/prompt-llm/:jobId — poll job status and results
 * - GET /api/jobs/prompt-llm/:jobId/encounter-bundle — saved encounter bundle (generate-and-save jobs with note_id)
 */

import { getSupabaseClient } from '../../utils/supabase.js';
import { promptLlmProcessor } from '../processors/promptLlmProcessor.js';
import parseSoapNotes from '../../utils/parseSoapNotes.js';
import { getPatientEncounterBundleByNoteId } from './patientEncountersController.js';
import { validatePreVisitSummaryForNoteGeneration } from './preVisitSummariesController.js';
import { pgQueryOne, pgCoerceBigIntFields } from '../../utils/pgQueryHelpers.js';

const jobsTable = 'jobs';

/**
 * @param {string} userId
 * @param {string | null | undefined} preVisitSummaryId
 * @param {import('fastify').FastifyReply} reply
 * @returns {Promise<boolean>} false when reply was sent (validation error)
 */
async function validatePreVisitSummaryIdForJob(userId, preVisitSummaryId, reply) {
  if (!preVisitSummaryId) {
    return true;
  }

  const validation = await validatePreVisitSummaryForNoteGeneration(userId, preVisitSummaryId);
  if (validation.success) {
    return true;
  }

  const payload = { error: validation.error };
  if (validation.code) {
    payload.code = validation.code;
  }
  reply.status(validation.status).send(payload);
  return false;
}

/**
 * @param {string} userId
 * @param {string} recordingFilePath
 * @param {string | null | undefined} preVisitSummaryId
 */
async function insertPromptLlmJob(userId, recordingFilePath, preVisitSummaryId) {
  return pgQueryOne(
    `INSERT INTO ${jobsTable} (user_id, recording_file_path, status, pre_visit_summary_id)
     VALUES ($1, $2, 'pending', $3)
     RETURNING *`,
    [userId, recordingFilePath, preVisitSummaryId ?? null]
  );
}

/**
 * Create a new SOAP note generation job (used by generate-note routes).
 *
 * Route: POST /api/jobs/prompt-llm/generate-note.
 * Returns 202 with job id immediately;
 * processing runs asynchronously in the background.
 *
 * @param {Object} request - Fastify request with { recording_file_path }
 * @param {Object} reply - Fastify reply
 */
export async function createPromptLlmJobHandler(request, reply) {
  try {
    const { recording_file_path, noteTemplate_id, pre_visit_summary_id: preVisitSummaryId } = request.body;
    const userId = request.user.id;

    console.log('[createPromptLlmJobHandler] generate-note payload:', {
      userId,
      recording_file_path,
      noteTemplate_id: noteTemplate_id ?? null,
      pre_visit_summary_id: preVisitSummaryId ?? null,
    });

    if (!(await validatePreVisitSummaryIdForJob(userId, preVisitSummaryId, reply))) {
      return;
    }

    let job;
    try {
      job = await insertPromptLlmJob(userId, recording_file_path, preVisitSummaryId);
    } catch (createError) {
      console.error('[createPromptLlmJobHandler] Database error:', createError);
      return reply.status(500).send({ error: 'Failed to create job' });
    }

    if (!job) {
      return reply.status(500).send({ error: 'Failed to create job' });
    }

    const authorizationHeader = request.headers.authorization;
    setImmediate(() => {
      promptLlmProcessor(job.id, userId, authorizationHeader, noteTemplate_id).catch((err) => {
        console.error(`[promptLlmProcessor] Unhandled error for job ${job.id}:`, err);
      });
    });

    return reply.status(202).send({
      id: job.id,
      status: 'pending',
    });
  } catch (error) {
    console.error('[createPromptLlmJobHandler] Error:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Create a SOAP generation job (POST .../generate-and-save-note) that persists encounter + recording + note when generation succeeds.
 * Same async polling as generate-note; GET may include note_id after successful save.
 *
 * @param {Object} request - Fastify request (body validated: recording_file_path, optional noteTemplate_id, patient_encounter_name)
 * @param {Object} reply
 */
export async function createPromptLlmJobAndSaveNoteHandler(request, reply) {
  try {
    const {
      recording_file_path,
      noteTemplate_id,
      patient_encounter_name: patientEncounterName,
      pre_visit_summary_id: preVisitSummaryId,
    } = request.body;
    const userId = request.user.id;

    if (!(await validatePreVisitSummaryIdForJob(userId, preVisitSummaryId, reply))) {
      return;
    }

    let job;
    try {
      job = await insertPromptLlmJob(userId, recording_file_path, preVisitSummaryId);
    } catch (createError) {
      console.error('[createPromptLlmJobAndSaveNoteHandler] Database error:', createError);
      return reply.status(500).send({ error: 'Failed to create job' });
    }

    if (!job) {
      return reply.status(500).send({ error: 'Failed to create job' });
    }

    const authorizationHeader = request.headers.authorization;
    setImmediate(() => {
      promptLlmProcessor(job.id, userId, authorizationHeader, noteTemplate_id, {
        persistEncounterName: patientEncounterName,
      }).catch((err) => {
        console.error(`[promptLlmProcessor] Unhandled error for job ${job.id}:`, err);
      });
    });

    return reply.status(202).send({
      id: job.id,
      status: 'pending',
    });
  } catch (error) {
    console.error('[createPromptLlmJobAndSaveNoteHandler] Error:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * GET /api/jobs/prompt-llm/:jobId
 *
 * Poll job status and optionally retrieve results
 * Query param ?includeResult=true returns parsed SOAP note (only if status='complete')
 *
 * @param {Object} request - Fastify request with { jobId }
 * @param {Object} reply - Fastify reply
 */
export async function getPromptLlmJobStatusHandler(request, reply) {
  try {
    const { jobId } = request.params;
    const userId = request.user.id;
    const includeResult = request.query.includeResult === 'true';

    let job;
    try {
      job = await pgQueryOne(
        `SELECT id, status, transcript_text, soap_note_text, error_message, created_at, updated_at, note_id, pre_visit_summary_id
           FROM ${jobsTable}
          WHERE id = $1 AND user_id = $2`,
        [jobId, userId]
      );
    } catch (queryError) {
      console.error('[getPromptLlmJobStatusHandler] Job query error:', jobId, queryError);
      return reply.status(500).send({ error: 'Failed to load job' });
    }

    if (!job) {
      console.error('[getPromptLlmJobStatusHandler] Job not found:', jobId);
      return reply.status(404).send({ error: 'Job not found' });
    }

    job = pgCoerceBigIntFields(job, ['note_id']);

    const response = {
      id: job.id,
      status: job.status,
    };

    if (job.transcript_text) {
      response.transcript_text = job.transcript_text;
    }
    if (job.error_message) {
      response.error_message = job.error_message;
    }
    if (job.pre_visit_summary_id) {
      response.pre_visit_summary_id = job.pre_visit_summary_id;
    }

    if (includeResult && job.status === 'complete' && job.soap_note_text) {
      try {
        const parsed = parseSoapNotes({ soap_note_text: job.soap_note_text });
        response.soap_note = parsed.soap_note_text;
      } catch (err) {
        console.error('[getPromptLlmJobStatusHandler] Failed to parse SOAP note:', err);
        response.soap_note_parse_error = err.message;
      }
    }

    if (job.status === 'complete' && job.note_id != null) {
      response.note_id = job.note_id;
    }

    return reply.status(200).send(response);
  } catch (error) {
    console.error('[getPromptLlmJobStatusHandler] Error:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * GET /api/jobs/prompt-llm/:jobId/encounter-bundle
 *
 * Returns the same shape as POST /api/patient-encounters/complete when the job persisted a note (note_id set).
 * Not available for generate-only jobs or when persistence failed after SOAP generation.
 *
 * @param {Object} request
 * @param {Object} reply
 */
export async function getPromptLlmJobEncounterBundleHandler(request, reply) {
  try {
    const { jobId } = request.params;
    const userId = request.user.id;
    const user = request.user;

    let job;
    try {
      job = await pgQueryOne(
        `SELECT id, status, note_id
           FROM ${jobsTable}
          WHERE id = $1 AND user_id = $2`,
        [jobId, userId]
      );
    } catch (queryError) {
      console.error('[getPromptLlmJobEncounterBundleHandler] Job query error:', jobId, queryError);
      return reply.status(500).send({ error: 'Failed to load job' });
    }

    if (!job) {
      console.error('[getPromptLlmJobEncounterBundleHandler] Job not found:', jobId);
      return reply.status(404).send({ error: 'Job not found' });
    }

    job = pgCoerceBigIntFields(job, ['note_id']);

    if (job.note_id == null) {
      return reply.status(404).send({
        error:
          'Encounter bundle not available for this job (no saved note yet, or this job did not use generate-and-save-note)',
      });
    }

    const userSupabase = getSupabaseClient(request.headers.authorization);
    try {
      const bundle = await getPatientEncounterBundleByNoteId(userSupabase, user, job.note_id);
      return reply.status(200).send(bundle);
    } catch (err) {
      const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
      if (status >= 500) {
        console.error('[getPromptLlmJobEncounterBundleHandler]', err);
      }
      return reply.status(status).send({ error: err.message || 'Internal server error' });
    }
  } catch (error) {
    console.error('[getPromptLlmJobEncounterBundleHandler] Error:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
