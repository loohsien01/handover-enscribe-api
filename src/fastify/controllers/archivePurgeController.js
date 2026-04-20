/**
 * Internal maintenance endpoints (Bearer INTERNAL_CLEANUP_SECRET, not user JWT).
 */
import {
  archivePurgeRunBodySchema,
  archivePurgeJobParamsSchema,
} from '../schemas/requests.js';
import supabaseAdmin from '../../utils/supabaseAdmin.js';
import { safeEqualUtf8 } from '../../utils/unattachedStorageCleanup.js';
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
 * POST /api/internal/archive-purge/run
 */
export async function postArchivePurgeRun(request, reply) {
  const secret = process.env.INTERNAL_CLEANUP_SECRET;
  if (!secret) {
    return reply.status(503).send({ error: 'INTERNAL_CLEANUP_SECRET is not configured' });
  }

  const token = extractBearerToken(request.headers.authorization);
  if (!safeEqualUtf8(token, secret)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = archivePurgeRunBodySchema.safeParse(request.body);
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
  } = parsed.data;
  const tasks = [...new Set(rawTasks)];
  const purgeOpts =
    maxObjectsPerRun !== undefined ? { maxObjectsPerRun } : {};
  const encounterOpts = {
    ...(maxEnqueue !== undefined ? { maxEnqueue } : {}),
    ...(maxProcessPerJob !== undefined ? { maxProcessPerJob } : {}),
    ...(processConcurrency !== undefined ? { processConcurrency } : {}),
  };

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
          request.log.error({ err, jobRunId }, '[postArchivePurgeRun] encounter_archive async worker');
        });
      });
      const pollPath = `/api/internal/archive-purge/jobs/${jobRunId}`;
      return reply.status(202).send({
        ok: true,
        accepted: true,
        jobRunId,
        pollPath,
        message: `Poll GET ${pollPath} until job.status is success or failed.`,
      });
    } catch (err) {
      request.log.error({ err }, '[postArchivePurgeRun] encounter_archive async enqueue failed');
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
        const out = await runArchiveStorageManifestSync(supabase);
        results.storage_manifest = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postArchivePurgeRun] storage_manifest failed');
        results.storage_manifest = {
          status: 'error',
          message: err?.message || 'archive-purge failed',
        };
      }
    } else if (task === 'storage_archive') {
      try {
        const out = await runArchiveStoragePurge(supabase, purgeOpts);
        results.storage_archive = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postArchivePurgeRun] storage_archive failed');
        results.storage_archive = {
          status: 'error',
          message: err?.message || 'archive-purge failed',
        };
      }
    } else if (task === 'encounter_archive') {
      try {
        const out = await runEncounterArchiveSync(supabase, encounterOpts);
        results.encounter_archive = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postArchivePurgeRun] encounter_archive failed');
        results.encounter_archive = {
          status: 'error',
          message: err?.message || 'encounter_archive failed',
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
 * GET /api/internal/archive-purge/jobs/:jobRunId
 * Poll archive.job_runs (encounter_archive async jobs, etc.).
 */
export async function getArchivePurgeJobRun(request, reply) {
  const secret = process.env.INTERNAL_CLEANUP_SECRET;
  if (!secret) {
    return reply.status(503).send({ error: 'INTERNAL_CLEANUP_SECRET is not configured' });
  }

  const token = extractBearerToken(request.headers.authorization);
  if (!safeEqualUtf8(token, secret)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = archivePurgeJobParamsSchema.safeParse(request.params);
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
    request.log.error({ err, jobRunId }, '[getArchivePurgeJobRun] failed');
    return reply.status(500).send({
      error: err instanceof Error ? err.message : 'Failed to load job',
    });
  }
}
