/**
 * Orphan storage cleanup: files under audio-files/{userId}/ not referenced by recordings.recording_file_path.
 * Age gate uses Storage object updated_at (ISO string from list()).
 * Persists a row in archive.job_runs (frozen cutoff + result summary) like other internal cleanup tasks.
 */
import { timingSafeEqual } from 'node:crypto';
import { loadCleanupExcludedUserIdSet } from './cleanupExcludedUserIds.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';
import {
  AUDIO_BUCKET,
  listRecordingRootUserPrefixes,
  listUserRecordingObjects,
  deleteRecordingObject,
} from './recordingsStorage.js';

export { AUDIO_BUCKET };
const JOB_NAME = 'unattached_storage';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DELETES = 500;
/** Cap paths / error keys stored in archive.job_runs.result (full lists remain in HTTP response). */
const RESULT_PREVIEW = 50;

/** UUID directory names at bucket root (user folders). */
const USER_DIR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const recordingTableName = 'recordings';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} [opts]
 * @param {number} [opts.retentionMs]
 * @param {number} [opts.maxDeletesPerRun]
 * @param {number} [opts.nowMs] inject clock for tests
 * @returns {Promise<object>} includes `jobRunId`, `cutoff` from archive.job_runs when the run completes
 */
export async function runUnattachedStorageCleanup(supabase, opts = {}) {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxDeletesPerRun = opts.maxDeletesPerRun ?? DEFAULT_MAX_DELETES;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - retentionMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let jobRunId = /** @type {string | null} */ (null);
  const markJobFailed = async (message) => {
    if (!jobRunId) return;
    await querySupabasePostgres(
      `UPDATE archive.job_runs
       SET status = 'failed'::archive.job_run_status,
           finished_at = now(),
           error_message = $2
       WHERE id = $1::uuid`,
      [jobRunId, message ?? null]
    );
  };

  /** @type {{ id: string, cutoff: string } | undefined} */
  let jobRow;
  try {
    const { rows } = await querySupabasePostgres(
      `INSERT INTO archive.job_runs (job_name, cutoff, status)
       VALUES ($1, $2::timestamptz, 'running'::archive.job_run_status)
       RETURNING id, cutoff`,
      [JOB_NAME, cutoffIso]
    );
    jobRow = rows[0];
    if (!jobRow) throw new Error('no row returned');
  } catch (jobErr) {
    const msg = jobErr instanceof Error ? jobErr.message : String(jobErr);
    throw new Error(`archive.job_runs insert failed: ${msg}`);
  }

  jobRunId = jobRow.id;

  try {
    const fromRoot = await listRootUserPrefixes(supabase);
    const fromRecordings = await listDistinctRecordingUserIds(supabase);
    const userPrefixes = [...new Set([...fromRoot, ...fromRecordings])].sort((a, b) =>
      a.localeCompare(b)
    );

    const deleted = [];
    const failed = [];
    /** @type {Record<string, string>} */
    const errors = {};
    let skippedNoTimestamp = 0;
    let skippedTooNew = 0;
    let skippedAttached = 0;
    let skippedCleanupExemptUsers = 0;

    const cleanupExcludedUserIds = await loadCleanupExcludedUserIdSet();

    let remaining = maxDeletesPerRun;

    for (const userId of userPrefixes) {
      if (remaining <= 0) break;

      if (cleanupExcludedUserIds.has(userId)) {
        skippedCleanupExemptUsers++;
        continue;
      }

      const { data: rows, error: recErr } = await supabase
        .from(recordingTableName)
        .select('recording_file_path')
        .eq('user_id', userId);

      if (recErr) {
        throw new Error(`recordings query failed for ${userId}: ${recErr.message}`);
      }

      const attachedPaths = new Set((rows || []).map((r) => r.recording_file_path).filter(Boolean));

      const storageFiles = await listAllFilesInUserFolder(supabase, userId);

      /** @type {{ path: string, updatedMs: number }[]} */
      const orphanCandidates = [];

      for (const file of storageFiles) {
        const fullPath = `${userId}/${file.name}`;
        if (attachedPaths.has(fullPath)) {
          skippedAttached++;
          continue;
        }
        const updatedAt = file.updated_at;
        if (!updatedAt) {
          skippedNoTimestamp++;
          continue;
        }
        const updatedMs = new Date(updatedAt).getTime();
        if (Number.isNaN(updatedMs)) {
          skippedNoTimestamp++;
          continue;
        }
        if (updatedMs >= cutoffMs) {
          skippedTooNew++;
          continue;
        }
        orphanCandidates.push({ path: fullPath, updatedMs });
      }

      orphanCandidates.sort((a, b) => a.updatedMs - b.updatedMs);

      const take = orphanCandidates.slice(0, remaining);
      const REMOVE_CHUNK = 100;

      for (let i = 0; i < take.length; i += REMOVE_CHUNK) {
        const chunk = take.slice(i, i + REMOVE_CHUNK).map((c) => c.path);

        for (const objectPath of chunk) {
          try {
            await deleteRecordingObject(supabase, objectPath);
            deleted.push(objectPath);
            remaining--;
          } catch (oneErr) {
            failed.push(objectPath);
            errors[objectPath] =
              oneErr instanceof Error ? oneErr.message : 'Storage error';
          }
        }
      }
    }

    const hitCap = deleted.length >= maxDeletesPerRun;
    const stats = {
      userPrefixesScanned: userPrefixes.length,
      deletedCount: deleted.length,
      failedCount: failed.length,
      skippedNoTimestamp,
      skippedTooNew,
      skippedAttached,
      skippedCleanupExemptUsers,
      mayHaveMore: hitCap,
    };

    const errorsSample = failed.slice(0, RESULT_PREVIEW).map((path) => ({
      path,
      message: errors[path] ?? '',
    }));

    const jobResult = {
      maxDeletesPerRun,
      retentionMs,
      stats,
      deletedSample: deleted.slice(0, RESULT_PREVIEW),
      deletedSampleTruncated: deleted.length > RESULT_PREVIEW,
      failedSample: failed.slice(0, RESULT_PREVIEW),
      failedSampleTruncated: failed.length > RESULT_PREVIEW,
      errorsSample,
    };

    try {
      await querySupabasePostgres(
        `UPDATE archive.job_runs
         SET status = 'success'::archive.job_run_status,
             finished_at = now(),
             result = $2::jsonb
         WHERE id = $1::uuid`,
        [jobRunId, jobResult]
      );
    } catch (finErr) {
      const msg = finErr instanceof Error ? finErr.message : String(finErr);
      throw new Error(`archive.job_runs finalize failed: ${msg}`);
    }

    return {
      deleted,
      failed,
      errors,
      stats,
      jobRunId,
      cutoff: jobRow.cutoff,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markJobFailed(msg);
    throw err;
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listRootUserPrefixes(supabase) {
  return listRecordingRootUserPrefixes(supabase);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 */
export async function listAllFilesInUserFolder(supabase, userId) {
  return listUserRecordingObjects(supabase, userId);
}

/**
 * Users who have at least one recording row (covers edge cases where root list is incomplete).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listDistinctRecordingUserIds(supabase) {
  const ids = new Set();
  const page = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(recordingTableName)
      .select('user_id')
      .not('user_id', 'is', null)
      .range(from, from + page - 1);

    if (error) {
      throw new Error(`recordings user_id list failed: ${error.message}`);
    }

    if (!data?.length) break;

    for (const row of data) {
      const id = row.user_id;
      if (id && USER_DIR_UUID.test(String(id))) {
        ids.add(String(id));
      }
    }

    if (data.length < page) break;
    from += page;
  }

  return [...ids];
}

export function safeEqualUtf8(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
