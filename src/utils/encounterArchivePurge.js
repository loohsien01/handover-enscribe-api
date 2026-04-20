/**
 * Patient encounter bundle archive: enqueue cold encounters, upload JSONL + audio to S3,
 * remove Storage audio, delete live rows. Uses archive.job_runs + patient_encounter_archive_queue.
 * If the recording object is already missing from `audio-files`, the job continues without S3
 * audio and records an entry in `result.warningRows` (job still succeeds when `failedRows` is empty).
 *
 * Async + polling: POST creates archive.job_runs (queued), returns jobRunId; worker advances to
 * running/success/failed. GET /api/internal/archive-purge/jobs/:jobRunId reads job_runs.
 * `job.result.queueRowsByStatus` lists queue row UUIDs per {@link PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES}
 * (after enqueue and again when `phase` is `done`).
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { querySupabasePostgres } from './supabasePostgresPool.js';
import { getArchiveS3Client } from './archiveS3Client.js';

export const ENCOUNTER_ARCHIVE_JOB_NAME = 'encounter_archive';

/**
 * Labels for `archive.patient_encounter_archive_queue.status` (Postgres enum), in stable API order.
 * Poll `job.result.queueRowsByStatus` uses the same sequence so each `status` is documented as
 * one of these values only.
 *
 * @type {readonly string[]}
 */
export const PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES = Object.freeze([
  'pending',
  'processing',
  's3_audio_done',
  's3_db_done',
  'audio_deleted',
  'db_deleted',
  'failed',
]);

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Max queue rows inserted per job run (single RPC call). null = unlimited (all eligible
 * encounters for the frozen cutoff). Set to null here for a project-wide default of “enqueue all”.
 * @type {number | null}
 */
const DEFAULT_MAX_ENQUEUE = 50;
/**
 * Max queue rows fully processed (S3 + deletes) in one job run, after enqueue.
 * null = drain every pending row for this job_run_id in one run (no cap).
 * Each run: enqueue up to maxEnqueue, then drain up to this many pending rows (unless null).
 * @type {number | null}
 */
const DEFAULT_MAX_PROCESS_PER_JOB = null;
/**
 * How many queue rows to process in parallel per wave (each wave claims up to this many via RPC).
 * Set to 1 for strictly sequential behavior.
 */
const DEFAULT_PROCESS_CONCURRENCY = 5;
/**
 * How many times the full encounter pipeline may fail before the queue row is marked `failed`.
 * One increment = one failed `failRow` (after download/S3/DB steps), not each Storage HTTP retry.
 * Transient Storage errors are retried separately (see STORAGE_DOWNLOAD_MAX_TRIES) within one attempt.
 */
const MAX_QUEUE_ATTEMPTS = 3;

/** Supabase Storage `.download()` attempts per pipeline try (does not bump queue `attempts`). */
const STORAGE_DOWNLOAD_MAX_TRIES = 3;
const STORAGE_DOWNLOAD_RETRY_BASE_MS = 400;

/**
 * APIs sometimes surface PostgREST/Storage errors as the literal string "{}" (or similar),
 * which is useless in `last_error`, `result.failedRows`, and `result.warningRows`.
 * @param {unknown} s
 */
function isUnhelpfulLiteralErrorString(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return (
    t === '{}' ||
    t === '[]' ||
    t === '""' ||
    t === "''" ||
    t === '[object Object]'
  );
}

/**
 * @param {string} s
 * @param {string} fallback
 */
function sanitizeHumanErrorString(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.trim();
  if (!t || isUnhelpfulLiteralErrorString(t)) return fallback;
  return t;
}

/**
 * @param {unknown} e
 */
function serializeCaughtError(e) {
  if (e instanceof Error) {
    const core =
      sanitizeHumanErrorString(e.message, '') || sanitizeHumanErrorString(e.name, '') || 'Error';
    if (e.cause != null) {
      return `${core} | cause: ${serializeCaughtError(e.cause)}`;
    }
    return core;
  }
  if (typeof e === 'string') {
    return sanitizeHumanErrorString(e, '(thrown empty string)') || '(thrown empty string)';
  }
  if (e && typeof e === 'object') {
    try {
      const j = JSON.stringify(e);
      return isUnhelpfulLiteralErrorString(j) ? '(thrown empty object)' : j;
    } catch {
      return String(e);
    }
  }
  return String(e);
}

function getArchiveBucket() {
  const b = process.env.AWS_ARCHIVE_S3_BUCKET;
  if (!b || typeof b !== 'string' || !b.trim()) {
    throw new Error(
      'AWS_ARCHIVE_S3_BUCKET is not set. Required for encounter archive S3 uploads.'
    );
  }
  return b.trim();
}

/**
 * Drain pending rows: claim batches with SKIP LOCKED, then run up to `processConcurrency` pipelines
 * in parallel per wave until `maxProcessPerJob` or no pending rows.
 *
 * @param {number | null} maxProcessPerJob null = no cap on total processed this run
 * @param {number} processConcurrency max rows claimed + processed in parallel per wave (min 1, max 50)
 */
async function processPendingEncounterQueueForJob(
  supabase,
  s3,
  archiveBucket,
  jobRunId,
  maxProcessPerJob,
  processConcurrency
) {
  const conc = Math.max(
    1,
    Math.min(
      Number.isFinite(processConcurrency) ? Math.floor(processConcurrency) : DEFAULT_PROCESS_CONCURRENCY,
      50
    )
  );

  const processedIds = /** @type {string[]} */ ([]);
  const failedRows = /** @type {object[]} */ ([]);
  const warningRows = /** @type {object[]} */ ([]);
  let processed = 0;

  while (true) {
    if (maxProcessPerJob != null && processed >= maxProcessPerJob) break;

    const batchCap =
      maxProcessPerJob == null ? conc : Math.min(conc, maxProcessPerJob - processed);
    if (batchCap <= 0) break;

    let batch;
    try {
      const { rows } = await querySupabasePostgres(
        'SELECT * FROM archive.claim_patient_encounter_archive_queue_batch($1::uuid, $2::int)',
        [jobRunId, batchCap]
      );
      batch = rows;
    } catch (claimErr) {
      const msg = claimErr instanceof Error ? claimErr.message : String(claimErr);
      throw new Error(
        `${msg} (apply migration sql/migrations/20260419210000_archive_claim_patient_encounter_archive_queue_batch.sql)`
      );
    }
    if (batch.length === 0) break;

    const outcomes = await Promise.all(
      batch.map((row) =>
        processOneQueueRow(supabase, s3, archiveBucket, row, { skipPendingClaim: true })
      )
    );

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const r = outcomes[i];
      if (r.ok) {
        processedIds.push(row.id);
        const rw = /** @type {{ recordingWarning?: string }} */ (r).recordingWarning;
        if (typeof rw === 'string' && rw.trim()) {
          warningRows.push({
            queueId: row.id,
            patient_encounter_id: row.patient_encounter_id,
            message: sanitizeHumanErrorString(rw.trim(), '(recording warning)'),
          });
        }
      } else {
        failedRows.push({
          queueId: row.id,
          message: sanitizeHumanErrorString(
            typeof r.message === 'string' ? r.message : String(r.message ?? ''),
            '(missing or non-string row error message)'
          ),
        });
      }
    }

    processed += batch.length;
  }

  // A row may fail mid-run (e.g. connection reset), `failRow` returns it to `pending`, then a later
  // wave succeeds — omit stale failures for queue ids that ultimately completed this run.
  const processedSet = new Set(processedIds.map((id) => String(id)));
  /** @type {Map<string, { queueId: string, message: string }>} */
  const failByQueueId = new Map();
  for (const fr of failedRows) {
    const qid = fr && typeof fr.queueId === 'string' ? fr.queueId : String(fr?.queueId ?? '');
    if (!qid) continue;
    failByQueueId.set(qid, {
      queueId: qid,
      message: sanitizeHumanErrorString(
        typeof fr.message === 'string' ? fr.message : String(fr.message ?? ''),
        '(missing or non-string row error message)'
      ),
    });
  }
  const reconciledFailedRows = [...failByQueueId.values()].filter((fr) => !processedSet.has(fr.queueId));

  return { processedIds, failedRows: reconciledFailedRows, warningRows };
}

/**
 * @param {string} userId
 * @param {string} bundleId queue row UUID
 */
export function encounterBundleS3Prefix(userId, bundleId) {
  return `archive/encounter-bundles/${userId}/${bundleId}`;
}

/**
 * @param {string | null | undefined} recordingFilePath
 */
export function encounterRecordingObjectKey(userId, bundleId, recordingFilePath) {
  const base = encounterBundleS3Prefix(userId, bundleId);
  const ext = recordingFileExtension(recordingFilePath);
  return `${base}/recording.${ext}`;
}

export function encounterDbJsonlObjectKey(userId, bundleId) {
  return `${encounterBundleS3Prefix(userId, bundleId)}/db-rows.jsonl`;
}

function recordingFileExtension(recordingFilePath) {
  if (!recordingFilePath || typeof recordingFilePath !== 'string') return 'bin';
  const base = recordingFilePath.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return 'bin';
  const ext = base.slice(i + 1).replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return ext.slice(0, 16);
}

/**
 * Path relative to audio-files bucket (strip optional bucket prefix / leading slash).
 * @param {string | null | undefined} path
 */
export function normalizeAudioStoragePath(path) {
  if (!path || typeof path !== 'string') return null;
  let p = path.trim();
  if (p.startsWith('audio-files/')) p = p.replace(/^audio-files\//, '');
  if (p.startsWith('/')) p = p.slice(1);
  return p || null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase reserved for API symmetry; archive reads use Postgres.
 * @param {string} jobRunId
 */
export async function getArchiveJobRunById(_supabase, jobRunId) {
  try {
    const { rows } = await querySupabasePostgres(
      `SELECT id, job_name, cutoff, started_at, finished_at, status, queued_at, request_params, result, error_message
       FROM archive.job_runs WHERE id = $1::uuid LIMIT 1`,
      [jobRunId]
    );
    return rows[0] ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`archive.job_runs select failed: ${msg}`);
  }
}

async function markJobFailed(_supabase, jobRunId, message) {
  await querySupabasePostgres(
    `UPDATE archive.job_runs
     SET status = 'failed'::archive.job_run_status,
         finished_at = now(),
         error_message = $2
     WHERE id = $1::uuid`,
    [jobRunId, message ?? null]
  );
}

/** Terminal failure with structured `result` (e.g. failedRows, warningRows) for ops / polling. */
async function markJobFailedWithResult(_supabase, jobRunId, message, result) {
  await querySupabasePostgres(
    `UPDATE archive.job_runs
     SET status = 'failed'::archive.job_run_status,
         finished_at = now(),
         error_message = $2,
         result = $3::jsonb
     WHERE id = $1::uuid`,
    [jobRunId, message ?? null, result ?? null]
  );
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase unused; call sites pass the same Supabase client used for Storage/public.
 * @param {string} jobRunId
 */
async function countEncounterQueueRowsNotDbDeleted(_supabase, jobRunId) {
  const { rows } = await querySupabasePostgres(
    `SELECT COUNT(*)::int AS c
     FROM archive.patient_encounter_archive_queue
     WHERE job_run_id = $1::uuid
       AND status IS DISTINCT FROM 'db_deleted'::archive.patient_encounter_archive_status`,
    [jobRunId]
  );
  const count = rows[0]?.c;
  if (count == null || Number.isNaN(Number(count))) {
    throw new Error(
      'archive.patient_encounter_archive_queue exact count returned null (refuse to assume 0 rows)'
    );
  }
  return Number(count);
}

/**
 * For `archive.job_runs.result.queueRowsByStatus`: all queue row ids for this job_run_id, grouped
 * by `patient_encounter_archive_status` (every enum label appears once, in canonical order).
 *
 * @param {string} jobRunId
 * @returns {Promise<{ status: string, queueIds: string[] }[]>}
 */
async function buildEncounterArchiveQueueRowsByStatus(jobRunId) {
  const { rows } = await querySupabasePostgres(
    `SELECT q.status::text AS status,
            COALESCE(array_agg(q.id::text ORDER BY q.id::text), ARRAY[]::text[]) AS queue_ids
     FROM archive.patient_encounter_archive_queue q
     WHERE q.job_run_id = $1::uuid
     GROUP BY q.status`,
    [jobRunId]
  );

  /** @type {Record<string, string[]>} */
  const byStatus = Object.fromEntries(PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES.map((s) => [s, []]));

  for (const row of rows) {
    const st = typeof row.status === 'string' ? row.status : String(row.status ?? '');
    const raw = row.queue_ids;
    const ids = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
    if (Object.prototype.hasOwnProperty.call(byStatus, st)) {
      byStatus[st] = ids;
    }
  }

  return PATIENT_ENCOUNTER_ARCHIVE_QUEUE_STATUSES.map((status) => ({
    status,
    queueIds: byStatus[status],
  }));
}

/**
 * Insert a queued job row (caller should spawn worker).
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase unused; kept so callers keep passing `supabaseAdmin()`.
 * @param {object} opts
 * @param {number} [opts.retentionMs]
 * @param {number} [opts.nowMs]
 * @param {Record<string, unknown>} [opts.requestParams]
 */
export async function createQueuedEncounterArchiveJob(_supabase, opts = {}) {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();
  const requestParams = opts.requestParams ?? {};

  const queuedAt = new Date().toISOString();
  try {
    const { rows } = await querySupabasePostgres(
      `INSERT INTO archive.job_runs (job_name, cutoff, status, queued_at, request_params)
       VALUES ($1, $2::timestamptz, 'queued'::archive.job_run_status, $3::timestamptz, $4::jsonb)
       RETURNING id, cutoff, status`,
      [ENCOUNTER_ARCHIVE_JOB_NAME, cutoffIso, queuedAt, requestParams]
    );
    const data = rows[0];
    if (!data) throw new Error('no row returned');
    return data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`archive.job_runs insert failed: ${msg}`);
  }
}

/**
 * Run encounter archive work for one job_run (claim queued → running, enqueue RPC, process batch).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase used for Storage + public tables; archive rows use direct Postgres.
 * @param {string} jobRunId
 * @param {object} [opts]
 * @param {number | null} [opts.maxEnqueue] null = RPC inserts all eligible encounters (requires migration 20260419200000).
 * @param {number | null} [opts.maxProcessPerJob] null = process all pending queue rows for this job in one run.
 * @param {number} [opts.processConcurrency] parallel encounter pipelines per wave (default 5).
 */
export async function runEncounterArchiveJob(supabase, jobRunId, opts = {}) {
  const maxEnqueue =
    opts.maxEnqueue !== undefined ? opts.maxEnqueue : DEFAULT_MAX_ENQUEUE;
  const maxProcessPerJob =
    opts.maxProcessPerJob !== undefined ? opts.maxProcessPerJob : DEFAULT_MAX_PROCESS_PER_JOB;
  const processConcurrency =
    opts.processConcurrency !== undefined ? opts.processConcurrency : DEFAULT_PROCESS_CONCURRENCY;
  const archiveBucket = getArchiveBucket();
  const s3 = getArchiveS3Client();

  const existingPre = await getArchiveJobRunById(supabase, jobRunId);
  if (!existingPre) throw new Error('Job not found');
  if (existingPre.status === 'success' || existingPre.status === 'failed') {
    return { jobRunId, skipped: true, reason: 'already_terminal', job: existingPre };
  }

  /** @type {{ id: string, cutoff: string, status: string, job_name: string } | null} */
  let claimed = null;
  if (existingPre.status === 'queued') {
    try {
      const { rows } = await querySupabasePostgres(
        `UPDATE archive.job_runs
         SET status = 'running'::archive.job_run_status
         WHERE id = $1::uuid AND status = 'queued'::archive.job_run_status
         RETURNING id, cutoff, status, job_name`,
        [jobRunId]
      );
      claimed = rows[0] ?? null;
    } catch (claimErr) {
      const msg = claimErr instanceof Error ? claimErr.message : String(claimErr);
      await markJobFailed(supabase, jobRunId, msg);
      throw new Error(msg);
    }
  }

  if (!claimed) {
    if (existingPre.status === 'running') {
      claimed = {
        id: String(existingPre.id),
        cutoff: existingPre.cutoff,
        status: 'running',
        job_name: String(existingPre.job_name ?? ENCOUNTER_ARCHIVE_JOB_NAME),
      };
    } else {
      throw new Error(`Job could not be claimed (status=${existingPre.status})`);
    }
  }

  if (claimed.job_name !== ENCOUNTER_ARCHIVE_JOB_NAME) {
    await markJobFailed(supabase, jobRunId, `wrong job_name: ${claimed.job_name}`);
    throw new Error('Not an encounter_archive job');
  }

  const cutoffIso =
    typeof claimed.cutoff === 'string' ? claimed.cutoff : new Date(claimed.cutoff).toISOString();

  let enqueued = 0;
  try {
    let encN;
    try {
      const { rows } = await querySupabasePostgres(
        'SELECT archive.enqueue_patient_encounter_archive_candidates($1::uuid, $2::timestamptz, $3::int) AS n',
        [jobRunId, cutoffIso, maxEnqueue]
      );
      encN = rows[0]?.n;
    } catch (rpcErr) {
      const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
      throw new Error(
        `${msg} (ensure migration sql/migrations/20260419140000_archive_enqueue_patient_encounter_candidates_fn.sql is applied)`
      );
    }
    enqueued = typeof encN === 'number' ? encN : Number(encN) || 0;

    const queueRowsByStatusAfterEnqueue = await buildEncounterArchiveQueueRowsByStatus(jobRunId);

    await querySupabasePostgres(
      `UPDATE archive.job_runs SET result = $2::jsonb WHERE id = $1::uuid`,
      [
        jobRunId,
        {
          phase: 'enqueued',
          enqueued,
          maxEnqueue,
          maxProcessPerJob,
          processConcurrency,
          queueRowsByStatus: queueRowsByStatusAfterEnqueue,
        },
      ]
    );

    const { processedIds, failedRows, warningRows } = await processPendingEncounterQueueForJob(
      supabase,
      s3,
      archiveBucket,
      jobRunId,
      maxProcessPerJob,
      processConcurrency
    );

    const queueRowsNotDbDeleted = await countEncounterQueueRowsNotDbDeleted(supabase, jobRunId);

    const { rows: pendingRows } = await querySupabasePostgres(
      `SELECT COUNT(*)::int AS c FROM archive.patient_encounter_archive_queue
       WHERE job_run_id = $1::uuid AND status = 'pending'::archive.patient_encounter_archive_status`,
      [jobRunId]
    );
    const pendingLeft = pendingRows[0]?.c ?? 0;

    const queueRowsByStatus = await buildEncounterArchiveQueueRowsByStatus(jobRunId);

    const result = {
      phase: 'done',
      enqueued,
      processedQueueIds: processedIds,
      failedRows,
      warningRows,
      queueRowsByStatus,
      maxEnqueue,
      maxProcessPerJob,
      processConcurrency,
      queueRowsNotDbDeleted,
      pendingRemaining: pendingLeft > 0,
    };

    const hasRowFailures = failedRows.length > 0;
    const hasIncompleteBundles = queueRowsNotDbDeleted > 0;
    if (hasRowFailures || hasIncompleteBundles) {
      const parts = [];
      if (hasRowFailures) {
        parts.push(`${failedRows.length} bundle(s) failed during processing (see result.failedRows)`);
      }
      if (hasIncompleteBundles) {
        parts.push(
          `${queueRowsNotDbDeleted} queue row(s) not in db_deleted (pending/processing/failed — re-run job or fix data)`
        );
      }
      const msg = `Encounter archive did not fully succeed: ${parts.join('; ')}`;
      await markJobFailedWithResult(supabase, jobRunId, msg, result);
      return { jobRunId, enqueued, ...result, jobFullySuccessful: false };
    }

    try {
      await querySupabasePostgres(
        `UPDATE archive.job_runs
         SET status = 'success'::archive.job_run_status,
             finished_at = now(),
             result = $2::jsonb
         WHERE id = $1::uuid`,
        [jobRunId, result]
      );
    } catch (finErr) {
      const msg = finErr instanceof Error ? finErr.message : String(finErr);
      throw new Error(`archive.job_runs finalize failed: ${msg}`);
    }

    return { jobRunId, enqueued, ...result, jobFullySuccessful: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markJobFailed(supabase, jobRunId, msg);
    throw err;
  }
}

/**
 * Supabase Storage / PostgREST errors sometimes use `message: {}` (truthy object), or the
 * useless literal string "{}" as `message`. Using `err?.message || fallback` would pick an object
 * and write JSON `{}` into `last_error` text.
 * @param {unknown} err
 * @param {string} fallback
 */
function isEmptyPlainObject(x) {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) return false;
  return Object.keys(/** @type {object} */ (x)).length === 0;
}

/**
 * @param {unknown} err storage-js error (often StorageUnknownError with empty originalError)
 * @param {string} pathHint normalized storage path
 */
function storageDownloadErrorMessage(err, pathHint) {
  if (err == null) {
    return `audio download failed (no error object) path=${pathHint}`;
  }
  const o = /** @type {Record<string, unknown>} */ (err);
  const name = typeof o.name === 'string' ? o.name : '';
  const orig = o.originalError;
  const storageLike = o.__isStorageError === true || name.toLowerCase().includes('storage');
  if (storageLike) {
    const emptyOrig = orig == null || (typeof orig === 'object' && isEmptyPlainObject(orig));
    if ((name === 'StorageUnknownError' || name === 'StorageError') && emptyOrig) {
      return `Supabase Storage download failed (SDK reported unknown error with no detail). Check bucket \`audio-files\`, object path, network, and Storage policies. path=${pathHint}`;
    }
  }
  const base = supabaseClientErrorMessage(err, 'audio download failed');
  return pathHint ? `${base} path=${pathHint}` : base;
}

/**
 * Recording audio is optional for the encounter archive pipeline (DB JSONL + deletes can proceed).
 * Missing objects often surface as 404-ish errors, or as StorageUnknownError with an empty
 * `originalError` after the file was already moved (e.g. storage_archive).
 *
 * @param {unknown} dlErr storage-js error from `.download()`, or null when the client returned no blob and no error
 * @param {string} resolvedMessage human message (e.g. from {@link storageDownloadErrorMessage})
 */
function isMissingRecordingStorageError(dlErr, resolvedMessage) {
  const m = typeof resolvedMessage === 'string' ? resolvedMessage.toLowerCase() : '';
  if (
    m.includes('not found') ||
    m.includes('does not exist') ||
    m.includes('no such file') ||
    m.includes('no such key') ||
    m.includes('object not found') ||
    /\b404\b/.test(m)
  ) {
    return true;
  }
  if (dlErr == null || typeof dlErr !== 'object') {
    return false;
  }
  const o = /** @type {Record<string, unknown>} */ (dlErr);
  const sc = Number(o.statusCode ?? o.status);
  if (Number.isFinite(sc) && sc === 404) {
    return true;
  }
  const name = typeof o.name === 'string' ? o.name : '';
  const orig = o.originalError;
  const emptyOrig = orig == null || (typeof orig === 'object' && isEmptyPlainObject(orig));
  const storageLike = o.__isStorageError === true || name.toLowerCase().includes('storage');
  if (storageLike && (name === 'StorageUnknownError' || name === 'StorageError') && emptyOrig) {
    return true;
  }
  return false;
}

function supabaseClientErrorMessage(err, fallback) {
  if (err == null || typeof err !== 'object') return fallback;
  const m = /** @type {{ message?: unknown }} */ (err).message;
  if (typeof m === 'string' && m.trim().length > 0 && !isUnhelpfulLiteralErrorString(m)) {
    return m.trim();
  }
  try {
    const j = JSON.stringify(err);
    if (j === '{}' || isUnhelpfulLiteralErrorString(j)) return fallback;
    return j;
  } catch {
    return fallback;
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase used for Storage + public tables; archive rows use direct Postgres.
 * @param {import('@aws-sdk/client-s3').S3Client} s3
 * @param {string} archiveBucket
 * @param {Record<string, unknown>} row patient_encounter_archive_queue row
 * @param {{ skipPendingClaim?: boolean }} [rowOpts] set skipPendingClaim when row was claimed via claim_patient_encounter_archive_queue_batch
 */
async function processOneQueueRow(supabase, s3, archiveBucket, row, rowOpts = {}) {
  const skipPendingClaim = rowOpts.skipPendingClaim === true;
  const queueId = row.id;
  const encounterId = row.patient_encounter_id;
  const userId = row.user_id;
  const recordingFilePath = row.recording_file_path;
  const attemptsBefore = Number(row.attempts ?? 0);

  const failRow = async (rawMessage) => {
    let message =
      typeof rawMessage === 'string'
        ? rawMessage.trim() || '(empty error string)'
        : rawMessage != null
          ? (() => {
              try {
                const j = JSON.stringify(rawMessage);
                return j === '{}' ? '(error object with no enumerable fields)' : j;
              } catch {
                return String(rawMessage);
              }
            })()
          : '(null error)';
    message = sanitizeHumanErrorString(
      message,
      '(unspecified archive row error; upstream returned empty or placeholder text)'
    );
    const nextAttempts = attemptsBefore + 1;
    const terminal = nextAttempts >= MAX_QUEUE_ATTEMPTS;
    let upErr;
    try {
      await querySupabasePostgres(
        `UPDATE archive.patient_encounter_archive_queue
         SET status = $1::archive.patient_encounter_archive_status,
             attempts = $2,
             last_error = $3,
             last_attempt_at = now(),
             updated_at = now()
         WHERE id = $4::uuid`,
        [terminal ? 'failed' : 'pending', nextAttempts, message, queueId]
      );
    } catch (e) {
      upErr = e;
    }
    if (upErr) {
      const persist = supabaseClientErrorMessage(upErr, 'queue last_error update failed');
      console.error('[encounterArchivePurge] failRow queue update failed', { queueId, persist, message });
      return {
        ok: false,
        message: `${message} | queueUpdateFailed: ${persist}`,
      };
    }
    return { ok: false, message };
  };

  if (!skipPendingClaim) {
    let claimed;
    let cErr;
    try {
      const { rows } = await querySupabasePostgres(
        `UPDATE archive.patient_encounter_archive_queue
         SET status = 'processing'::archive.patient_encounter_archive_status,
             last_attempt_at = now(),
             updated_at = now()
         WHERE id = $1::uuid AND status = 'pending'::archive.patient_encounter_archive_status
         RETURNING id`,
        [queueId]
      );
      claimed = rows[0] ?? null;
    } catch (e) {
      cErr = e;
    }
    if (cErr) return failRow(supabaseClientErrorMessage(cErr, 'claim pending→processing failed'));
    if (!claimed) return { ok: false, message: 'row not pending (race)' };
  }

  try {
    const normPath = normalizeAudioStoragePath(
      typeof recordingFilePath === 'string' ? recordingFilePath : null
    );

    /** If the object is already gone from `audio-files`, continue without an S3 recording object. */
    let skipAudioDueToMissing = false;
    let recordingMissingDetail = /** @type {string | null} */ (null);

    if (normPath) {
      let blob = null;
      let dlErr = null;
      for (let ti = 0; ti < STORAGE_DOWNLOAD_MAX_TRIES; ti++) {
        const res = await supabase.storage.from('audio-files').download(normPath);
        blob = res.data;
        dlErr = res.error;
        if (!dlErr && blob) break;
        if (ti < STORAGE_DOWNLOAD_MAX_TRIES - 1) {
          await new Promise((r) => setTimeout(r, STORAGE_DOWNLOAD_RETRY_BASE_MS * 2 ** ti));
        }
      }
      if (dlErr || !blob) {
        const msg = dlErr
          ? storageDownloadErrorMessage(dlErr, normPath)
          : 'audio download failed (no blob returned)';
        if (isMissingRecordingStorageError(dlErr, msg)) {
          skipAudioDueToMissing = true;
          recordingMissingDetail = `Recording missing in Storage; continuing without S3 audio. ${msg}`;
        } else {
          return failRow(msg);
        }
      } else {
        const buf = Buffer.from(await blob.arrayBuffer());
        const audioKey = encounterRecordingObjectKey(userId, queueId, recordingFilePath);
        await s3.send(
          new PutObjectCommand({
            Bucket: archiveBucket,
            Key: audioKey,
            Body: buf,
            ContentType: 'application/octet-stream',
          })
        );
      }
    }

    await querySupabasePostgres(
      `UPDATE archive.patient_encounter_archive_queue
       SET status = 's3_audio_done'::archive.patient_encounter_archive_status, updated_at = now()
       WHERE id = $1::uuid`,
      [queueId]
    );

    const lines = await buildBundleJsonlLines(supabase, encounterId, userId);
    const dbKey = encounterDbJsonlObjectKey(userId, queueId);
    await s3.send(
      new PutObjectCommand({
        Bucket: archiveBucket,
        Key: dbKey,
        Body: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
        ContentType: 'application/x-ndjson',
      })
    );

    await querySupabasePostgres(
      `UPDATE archive.patient_encounter_archive_queue
       SET status = 's3_db_done'::archive.patient_encounter_archive_status, updated_at = now()
       WHERE id = $1::uuid`,
      [queueId]
    );

    if (normPath && !skipAudioDueToMissing) {
      const { error: rmErr } = await supabase.storage.from('audio-files').remove([normPath]);
      if (rmErr) {
        return failRow(
          `storage remove audio: ${supabaseClientErrorMessage(rmErr, 'remove failed')}`
        );
      }
    }

    await querySupabasePostgres(
      `UPDATE archive.patient_encounter_archive_queue
       SET status = 'audio_deleted'::archive.patient_encounter_archive_status, updated_at = now()
       WHERE id = $1::uuid`,
      [queueId]
    );

    if (typeof recordingFilePath === 'string' && recordingFilePath.length > 0) {
      await supabase.from('jobs').delete().eq('recording_file_path', recordingFilePath).eq('user_id', userId);
    }

    const { data: recs, error: recErr } = await supabase
      .from('recordings')
      .select('id')
      .eq('patientEncounter_id', encounterId);
    if (recErr) return failRow(supabaseClientErrorMessage(recErr, 'recordings select failed'));
    const recIds = (recs || []).map((r) => r.id).filter(Boolean);
    if (recIds.length > 0) {
      const { error: tErr } = await supabase.from('transcripts').delete().in('recording_id', recIds);
      if (tErr) return failRow(supabaseClientErrorMessage(tErr, 'transcripts delete failed'));
    }

    const { error: rDelErr } = await supabase.from('recordings').delete().eq('patientEncounter_id', encounterId);
    if (rDelErr) return failRow(supabaseClientErrorMessage(rDelErr, 'recordings delete failed'));

    const { error: nDelErr } = await supabase.from('notes').delete().eq('patientEncounter_id', encounterId);
    if (nDelErr) return failRow(supabaseClientErrorMessage(nDelErr, 'notes delete failed'));

    const { error: eDelErr } = await supabase.from('patientEncounters').delete().eq('id', encounterId);
    if (eDelErr) return failRow(supabaseClientErrorMessage(eDelErr, 'patientEncounters delete failed'));

    const now = new Date().toISOString();
    let finQ;
    try {
      await querySupabasePostgres(
        `UPDATE archive.patient_encounter_archive_queue
         SET status = 'db_deleted'::archive.patient_encounter_archive_status,
             source_deleted_at = $2::timestamptz,
             archived_at = $2::timestamptz,
             updated_at = now()
         WHERE id = $1::uuid`,
        [queueId, now]
      );
    } catch (e) {
      finQ = e;
    }
    if (finQ) return failRow(supabaseClientErrorMessage(finQ, 'queue final db_deleted update failed'));

    if (recordingMissingDetail) {
      return { ok: true, recordingWarning: recordingMissingDetail };
    }
    return { ok: true };
  } catch (e) {
    return failRow(serializeCaughtError(e));
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase used for Storage + public tables; archive rows use direct Postgres.
 * @param {number|string} encounterId
 * @param {string} userId
 */
async function buildBundleJsonlLines(supabase, encounterId, userId) {
  const lines = /** @type {string[]} */ ([]);

  const { data: pe, error: peErr } = await supabase
    .from('patientEncounters')
    .select('*')
    .eq('id', encounterId)
    .maybeSingle();
  if (peErr) throw new Error(peErr.message);
  if (pe) lines.push(JSON.stringify({ table: 'patientEncounters', row: pe }));

  const { data: notes, error: nErr } = await supabase
    .from('notes')
    .select('*')
    .eq('patientEncounter_id', encounterId);
  if (nErr) throw new Error(nErr.message);
  for (const n of notes || []) lines.push(JSON.stringify({ table: 'notes', row: n }));

  const { data: recs, error: rErr } = await supabase
    .from('recordings')
    .select('*')
    .eq('patientEncounter_id', encounterId);
  if (rErr) throw new Error(rErr.message);
  for (const r of recs || []) lines.push(JSON.stringify({ table: 'recordings', row: r }));

  const recIds = (recs || []).map((r) => r.id).filter(Boolean);
  if (recIds.length > 0) {
    const { data: tr, error: tErr } = await supabase.from('transcripts').select('*').in('recording_id', recIds);
    if (tErr) throw new Error(tErr.message);
    for (const t of tr || []) lines.push(JSON.stringify({ table: 'transcripts', row: t }));
  }

  if (recs && recs[0]?.recording_file_path) {
    const path = recs[0].recording_file_path;
    const { data: jobs, error: jErr } = await supabase
      .from('jobs')
      .select('*')
      .eq('recording_file_path', path)
      .eq('user_id', userId);
    if (jErr) throw new Error(jErr.message);
    for (const j of jobs || []) lines.push(JSON.stringify({ table: 'jobs', row: j }));
  }

  return lines;
}

/**
 * Synchronous encounter archive (single request): queued → running → done (same as async worker).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase used for Storage + public tables; archive rows use direct Postgres.
 * @param {object} [opts]
 * @param {number | null} [opts.maxEnqueue] null = enqueue all eligible encounters for cutoff.
 * @param {number | null} [opts.maxProcessPerJob] null = process all pending rows for this job run.
 * @param {number} [opts.processConcurrency] parallel pipelines per wave (default 5).
 */
export async function runEncounterArchiveSync(supabase, opts = {}) {
  const maxEnqueue =
    opts.maxEnqueue !== undefined ? opts.maxEnqueue : DEFAULT_MAX_ENQUEUE;
  const maxProcessPerJob =
    opts.maxProcessPerJob !== undefined ? opts.maxProcessPerJob : DEFAULT_MAX_PROCESS_PER_JOB;
  const processConcurrency =
    opts.processConcurrency !== undefined ? opts.processConcurrency : DEFAULT_PROCESS_CONCURRENCY;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();

  let jobRow;
  try {
    const { rows } = await querySupabasePostgres(
      `INSERT INTO archive.job_runs (job_name, cutoff, status)
       VALUES ($1, $2::timestamptz, 'running'::archive.job_run_status)
       RETURNING id, cutoff`,
      [ENCOUNTER_ARCHIVE_JOB_NAME, cutoffIso]
    );
    jobRow = rows[0];
    if (!jobRow) throw new Error('no row returned');
  } catch (jobErr) {
    const msg = jobErr instanceof Error ? jobErr.message : String(jobErr);
    throw new Error(`archive.job_runs insert failed: ${msg}`);
  }

  const jobRunId = jobRow.id;
  let jobRunFailureAlreadyPersisted = false;
  try {
    let encN;
    try {
      const { rows } = await querySupabasePostgres(
        'SELECT archive.enqueue_patient_encounter_archive_candidates($1::uuid, $2::timestamptz, $3::int) AS n',
        [jobRunId, cutoffIso, maxEnqueue]
      );
      encN = rows[0]?.n;
    } catch (rpcErr) {
      const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
      throw new Error(
        `${msg} (ensure migration sql/migrations/20260419140000_archive_enqueue_patient_encounter_candidates_fn.sql is applied)`
      );
    }
    const enqueued = typeof encN === 'number' ? encN : Number(encN) || 0;

    const archiveBucket = getArchiveBucket();
    const s3 = getArchiveS3Client();
    const { processedIds, failedRows, warningRows } = await processPendingEncounterQueueForJob(
      supabase,
      s3,
      archiveBucket,
      jobRunId,
      maxProcessPerJob,
      processConcurrency
    );

    const queueRowsNotDbDeleted = await countEncounterQueueRowsNotDbDeleted(supabase, jobRunId);

    const { rows: pendingRows } = await querySupabasePostgres(
      `SELECT COUNT(*)::int AS c FROM archive.patient_encounter_archive_queue
       WHERE job_run_id = $1::uuid AND status = 'pending'::archive.patient_encounter_archive_status`,
      [jobRunId]
    );
    const pendingLeft = pendingRows[0]?.c ?? 0;

    const queueRowsByStatus = await buildEncounterArchiveQueueRowsByStatus(jobRunId);

    const result = {
      phase: 'done',
      enqueued,
      processedQueueIds: processedIds,
      failedRows,
      warningRows,
      queueRowsByStatus,
      maxEnqueue,
      maxProcessPerJob,
      processConcurrency,
      queueRowsNotDbDeleted,
      pendingRemaining: pendingLeft > 0,
    };

    const hasRowFailures = failedRows.length > 0;
    const hasIncompleteBundles = queueRowsNotDbDeleted > 0;
    if (hasRowFailures || hasIncompleteBundles) {
      const parts = [];
      if (hasRowFailures) {
        parts.push(`${failedRows.length} bundle(s) failed during processing (see result.failedRows)`);
      }
      if (hasIncompleteBundles) {
        parts.push(
          `${queueRowsNotDbDeleted} queue row(s) not in db_deleted (pending/processing/failed — re-run job or fix data)`
        );
      }
      const msg = `Encounter archive did not fully succeed: ${parts.join('; ')}`;
      await markJobFailedWithResult(supabase, jobRunId, msg, result);
      jobRunFailureAlreadyPersisted = true;
      throw new Error(msg);
    }

    await querySupabasePostgres(
      `UPDATE archive.job_runs
       SET status = 'success'::archive.job_run_status,
           finished_at = now(),
           result = $2::jsonb
       WHERE id = $1::uuid`,
      [jobRunId, result]
    );

    return { job_name: ENCOUNTER_ARCHIVE_JOB_NAME, jobRunId, cutoff: jobRow.cutoff, ...result };
  } catch (err) {
    if (!jobRunFailureAlreadyPersisted) {
      await markJobFailed(supabase, jobRunId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
