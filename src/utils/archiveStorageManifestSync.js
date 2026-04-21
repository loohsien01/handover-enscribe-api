/**
 * Step 1 + storage discovery (doc Step 3 prefix): persist frozen cutoff in archive.job_runs,
 * list audio-files objects older than cutoff (Storage list metadata only — no object download),
 * upsert eligible paths into archive.storage_objects. Does not archive to S3 or delete Storage.
 *
 * `archive.*` reads/writes use Postgres via `pg` (`SUPABASE_DB_DIRECT_URL` or equivalent; pooler URI OK).
 */
import { querySupabasePostgres } from './supabasePostgresPool.js';
import {
  AUDIO_BUCKET,
  listRootUserPrefixes,
  listDistinctRecordingUserIds,
  listAllFilesInUserFolder,
} from './unattachedStorageCleanup.js';

const JOB_NAME = 'storage_manifest';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ELIGIBLE = 5000;
const DEFAULT_DB_BATCH = 100;
/** Parallel SQL updates per batch. */
const DEFAULT_UPDATE_CONCURRENCY = 16;

/**
 * Run async work over `items` with at most `concurrency` in flight.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} fn
 */
async function runPool(items, concurrency, fn) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = /** @type {R[]} */ (new Array(items.length));
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * @param {string} isoA
 * @param {string | null | undefined} isoB
 */
function sameInstant(isoA, isoB) {
  if (isoB == null) return false;
  return new Date(isoA).getTime() === new Date(isoB).getTime();
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase Storage + `public` via PostgREST; `archive.*` via direct Postgres.
 * @param {object} [opts]
 * @param {number} [opts.retentionMs]
 * @param {number} [opts.maxEligibleRows] cap Storage-derived candidates per run
 * @param {number} [opts.dbBatchSize] paths per DB round-trip
 * @param {number} [opts.updateConcurrency] parallel row updates per batch
 * @param {number} [opts.nowMs]
 */
export async function runArchiveStorageManifestSync(supabase, opts = {}) {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxEligibleRows = opts.maxEligibleRows ?? DEFAULT_MAX_ELIGIBLE;
  const dbBatchSize = opts.dbBatchSize ?? DEFAULT_DB_BATCH;
  const updateConcurrency = opts.updateConcurrency ?? DEFAULT_UPDATE_CONCURRENCY;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - retentionMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let jobRunId = /** @type {string | null} */ (null);

  const markJobFailed = async () => {
    if (!jobRunId) return;
    await querySupabasePostgres(
      `UPDATE archive.job_runs
       SET status = 'failed'::archive.job_run_status, finished_at = now()
       WHERE id = $1::uuid`,
      [jobRunId]
    );
  };

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
  const frozenCutoff = jobRow.cutoff;

  try {
    const fromRoot = await listRootUserPrefixes(supabase);
    const fromRec = await listDistinctRecordingUserIds(supabase);
    const userPrefixes = [...new Set([...fromRoot, ...fromRec])].sort((a, b) => a.localeCompare(b));

    /** @type {{ path: string, user_id: string, updated_at: string }[]} */
    const eligible = [];
    let skippedNoTimestamp = 0;
    let skippedTooNew = 0;

    outer: for (const userId of userPrefixes) {
      if (eligible.length >= maxEligibleRows) break;

      const storageFiles = await listAllFilesInUserFolder(supabase, userId);

      for (const file of storageFiles) {
        if (eligible.length >= maxEligibleRows) break outer;

        const fullPath = `${userId}/${file.name}`;
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

        eligible.push({
          path: fullPath,
          user_id: userId,
          updated_at: new Date(updatedAt).toISOString(),
        });
      }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let skippedArchived = 0;
    let skippedUnchanged = 0;

    for (let i = 0; i < eligible.length; i += dbBatchSize) {
      const batch = eligible.slice(i, i + dbBatchSize);
      const paths = batch.map((r) => r.path);
      if (paths.length === 0) continue;

      let existing;
      try {
        const { rows } = await querySupabasePostgres(
          `SELECT path, archived_at, updated_at, user_id
           FROM archive.storage_objects
           WHERE bucket_id = $1 AND path = ANY($2::text[])`,
          [AUDIO_BUCKET, paths]
        );
        existing = rows;
      } catch (selErr) {
        const msg = selErr instanceof Error ? selErr.message : String(selErr);
        throw new Error(`archive.storage_objects select failed: ${msg}`);
      }

      /** @type {Map<string, { archived_at: string | null, updated_at: string, user_id: string | null }>} */
      const existingByPath = new Map(
        (existing || []).map((r) => [
          r.path,
          { archived_at: r.archived_at, updated_at: r.updated_at, user_id: r.user_id },
        ])
      );

      const inserts = [];
      /** @type {{ path: string, user_id: string, updated_at: string }[]} */
      const toUpdate = [];

      for (const row of batch) {
        const ex = existingByPath.get(row.path);
        if (ex === undefined) {
          inserts.push({
            bucket_id: AUDIO_BUCKET,
            path: row.path,
            user_id: row.user_id,
            updated_at: row.updated_at,
          });
        } else if (ex.archived_at != null) {
          skippedArchived++;
        } else if (
          sameInstant(row.updated_at, ex.updated_at)
        ) {
          skippedUnchanged++;
        } else {
          toUpdate.push(row);
        }
      }

      if (toUpdate.length > 0) {
        await runPool(toUpdate, updateConcurrency, async (row) => {
          try {
            await querySupabasePostgres(
              `UPDATE archive.storage_objects
               SET updated_at = $3::timestamptz, user_id = $4::uuid
               WHERE bucket_id = $1 AND path = $2 AND archived_at IS NULL`,
              [AUDIO_BUCKET, row.path, row.updated_at, row.user_id]
            );
          } catch (upErr) {
            const msg = upErr instanceof Error ? upErr.message : String(upErr);
            throw new Error(`archive.storage_objects update ${row.path}: ${msg}`);
          }
        });
        updatedCount += toUpdate.length;
      }

      if (inserts.length > 0) {
        const placeholders = [];
        const flat = /** @type {unknown[]} */ ([]);
        let p = 1;
        for (const ins of inserts) {
          placeholders.push(`($${p++}, $${p++}, $${p++}::uuid, $${p++}::timestamptz)`);
          flat.push(ins.bucket_id, ins.path, ins.user_id, ins.updated_at);
        }
        try {
          await querySupabasePostgres(
            `INSERT INTO archive.storage_objects (bucket_id, path, user_id, updated_at) VALUES ${placeholders.join(', ')}`,
            flat
          );
        } catch (insErr) {
          const msg = insErr instanceof Error ? insErr.message : String(insErr);
          throw new Error(`archive.storage_objects insert failed: ${msg}`);
        }
        insertedCount += inserts.length;
      }
    }

    try {
      await querySupabasePostgres(
        `UPDATE archive.job_runs
         SET status = 'success'::archive.job_run_status, finished_at = now()
         WHERE id = $1::uuid`,
        [jobRunId]
      );
    } catch (finErr) {
      const msg = finErr instanceof Error ? finErr.message : String(finErr);
      throw new Error(`archive.job_runs finalize failed: ${msg}`);
    }

    return {
      job_name: JOB_NAME,
      jobRunId,
      cutoff: frozenCutoff,
      bucket_id: AUDIO_BUCKET,
      userPrefixesScanned: userPrefixes.length,
      eligibleDiscovered: eligible.length,
      insertedCount,
      updatedCount,
      skippedArchived,
      skippedUnchanged,
      skippedNoTimestamp,
      skippedTooNew,
      capped: eligible.length >= maxEligibleRows,
    };
  } catch (err) {
    await markJobFailed();
    throw err;
  }
}
