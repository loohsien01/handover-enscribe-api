/**
 * Internal cleanup endpoints (Bearer INTERNAL_CLEANUP_SECRET, not user JWT).
 */
import { cleanupRunBodySchema, cleanupJobParamsSchema } from '../schemas/requests.js';
import supabaseAdmin from '../../utils/supabaseAdmin.js';
import { safeEqualUtf8, runUnattachedStorageCleanup } from '../../utils/unattachedStorageCleanup.js';
import { runUnattachedNoteTemplateSectionsCleanup } from '../../utils/unattachedNoteTemplateSectionsCleanup.js';
import { runArchiveStorageManifestSync } from '../../utils/archiveStorageManifestSync.js';
import { runArchiveStoragePurge } from '../../utils/archiveStoragePurge.js';
import {
  createQueuedEncounterArchiveJob,
  runEncounterArchiveJob,
  runEncounterArchiveSync,
  getArchiveJobRunById,
} from '../../utils/encounterArchivePurge.js';

function extractBearerToken(authorizationHeader) {
  const auth = authorizationHeader || '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m?.[1] ?? '';
}

/**
 * POST /api/internal/cleanup/run
 */
export async function postCleanupRun(request, reply) {
  const secret = process.env.INTERNAL_CLEANUP_SECRET;
  if (!secret) {
    return reply.status(503).send({ error: 'INTERNAL_CLEANUP_SECRET is not configured' });
  }

  const token = extractBearerToken(request.headers.authorization);
  if (!safeEqualUtf8(token, secret)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = cleanupRunBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const {
    tasks: rawTasks,
    maxObjectsPerRun,
    async: asyncJob,
    maxEnqueue,
    maxProcessPerJob,
    processConcurrency,
    maxDeletesPerRunUnattachedStorage,
    maxDeletesPerRunUnattachedNoteTemplateSections,
    maxEligibleRowsStorageManifest,
  } = parsed.data;
  const tasks = [...new Set(rawTasks)];
  const manifestOpts =
    maxEligibleRowsStorageManifest !== undefined
      ? { maxEligibleRows: maxEligibleRowsStorageManifest }
      : {};
  const purgeOpts =
    maxObjectsPerRun !== undefined ? { maxObjectsPerRun } : {};
  const encounterOpts = {
    ...(maxEnqueue !== undefined ? { maxEnqueue } : {}),
    ...(maxProcessPerJob !== undefined ? { maxProcessPerJob } : {}),
    ...(processConcurrency !== undefined ? { processConcurrency } : {}),
  };
  const unattachedStorageOpts =
    maxDeletesPerRunUnattachedStorage !== undefined
      ? { maxDeletesPerRun: maxDeletesPerRunUnattachedStorage }
      : {};
  const unattachedNoteTemplateSectionsOpts =
    maxDeletesPerRunUnattachedNoteTemplateSections !== undefined
      ? { maxDeletesPerRun: maxDeletesPerRunUnattachedNoteTemplateSections }
      : {};

  const supabase = supabaseAdmin();

  if (asyncJob) {
    try {
      const job = await createQueuedEncounterArchiveJob(supabase, {
        requestParams: {
          tasks,
          maxEnqueue: encounterOpts.maxEnqueue ?? null,
          maxProcessPerJob: encounterOpts.maxProcessPerJob ?? null,
          processConcurrency: encounterOpts.processConcurrency ?? null,
        },
      });
      const jobRunId = job.id;
      setImmediate(() => {
        runEncounterArchiveJob(supabase, jobRunId, encounterOpts).catch((err) => {
          request.log.error({ err, jobRunId }, '[postCleanupRun] encounter_archive async worker');
        });
      });
      const pollPath = `/api/internal/cleanup/jobs/${jobRunId}`;
      return reply.status(202).send({
        ok: true,
        accepted: true,
        jobRunId,
        pollPath,
        message: `Poll GET ${pollPath} until job.status is success or failed.`,
      });
    } catch (err) {
      request.log.error({ err }, '[postCleanupRun] encounter_archive async enqueue failed');
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to create archive job',
      });
    }
  }

  const results = {};
  let anyError = false;

  for (const task of tasks) {
    if (task === 'storage_manifest') {
      try {
        const out = await runArchiveStorageManifestSync(supabase, manifestOpts);
        results.storage_manifest = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postCleanupRun] storage_manifest failed');
        results.storage_manifest = {
          status: 'error',
          message: err?.message || 'cleanup failed',
        };
      }
    } else if (task === 'storage_archive') {
      try {
        const out = await runArchiveStoragePurge(supabase, purgeOpts);
        results.storage_archive = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postCleanupRun] storage_archive failed');
        results.storage_archive = {
          status: 'error',
          message: err?.message || 'cleanup failed',
        };
      }
    } else if (task === 'encounter_archive') {
      try {
        const out = await runEncounterArchiveSync(supabase, encounterOpts);
        results.encounter_archive = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postCleanupRun] encounter_archive failed');
        results.encounter_archive = {
          status: 'error',
          message: err?.message || 'encounter_archive failed',
        };
      }
    } else if (task === 'unattached_storage') {
      try {
        const out = await runUnattachedStorageCleanup(supabase, unattachedStorageOpts);
        results.unattached_storage = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postCleanupRun] unattached_storage failed');
        results.unattached_storage = {
          status: 'error',
          message: err?.message || 'unattached_storage failed',
        };
      }
    } else if (task === 'unattached_note_template_sections') {
      try {
        const out = await runUnattachedNoteTemplateSectionsCleanup(supabase, unattachedNoteTemplateSectionsOpts);
        results.unattached_note_template_sections = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postCleanupRun] unattached_note_template_sections failed');
        results.unattached_note_template_sections = {
          status: 'error',
          message: err?.message || 'unattached_note_template_sections failed',
        };
      }
    }
  }

  if (anyError) {
    return reply.status(500).send({ ok: false, results });
  }

  return reply.status(200).send({ ok: true, results });
}

/**
 * GET /api/internal/cleanup/jobs/:jobRunId
 * Poll archive.job_runs (encounter_archive async jobs; unattached_* and other tasks also write rows).
 */
export async function getCleanupJobRun(request, reply) {
  const secret = process.env.INTERNAL_CLEANUP_SECRET;
  if (!secret) {
    return reply.status(503).send({ error: 'INTERNAL_CLEANUP_SECRET is not configured' });
  }

  const token = extractBearerToken(request.headers.authorization);
  if (!safeEqualUtf8(token, secret)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = cleanupJobParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const { jobRunId } = parsed.data;
  const supabase = supabaseAdmin();

  try {
    const job = await getArchiveJobRunById(supabase, jobRunId);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return reply.status(200).send({ ok: true, job });
  } catch (err) {
    request.log.error({ err, jobRunId }, '[getCleanupJobRun] failed');
    return reply.status(500).send({
      error: err instanceof Error ? err.message : 'Failed to load job',
    });
  }
}
