/**
 * Doc Step 3 (storage): eligible rows in archive.storage_objects → download from Supabase Storage,
 * PutObject to S3, delete from Storage, set archived_at. Requires AWS_ARCHIVE_S3_BUCKET.
 *
 * Order: S3 PutObject → Storage remove → mark archived_at (delete before mark so retries work if remove fails).
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { querySupabasePostgres } from './supabasePostgresPool.js';
import { getArchiveS3Client } from './archiveS3Client.js';

const JOB_NAME = 'storage_archive';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OBJECTS = 10;
/** @type {number | null} */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB per object

function getArchiveBucket() {
  const b = process.env.AWS_ARCHIVE_S3_BUCKET;
  if (!b || typeof b !== 'string' || !b.trim()) {
    throw new Error(
      'AWS_ARCHIVE_S3_BUCKET is not set. Set it to the S3 bucket name for retention archives (same account/region as AWS SDK).'
    );
  }
  return b.trim();
}

/** UTC date prefix + job id — doc: archive/manifests/YYYY/MM/DD/{jobRunId}.jsonl */
function manifestObjectKey(jobRunId, at = new Date()) {
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  return `archive/manifests/${y}/${mo}/${d}/${jobRunId}.jsonl`;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase Storage + `public` via PostgREST; `archive.*` via direct Postgres.
 * @param {object} [opts]
 * @param {number} [opts.retentionMs]
 * @param {number | null} [opts.maxObjectsPerRun] null = no `.limit()` (unbounded batch; PostgREST may still cap rows)
 * @param {number | null} [opts.maxBytesPerObject] skip / fail row if larger (null = no limit)
 * @param {number} [opts.nowMs]
 */
export async function runArchiveStoragePurge(supabase, opts = {}) {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxObjectsPerRun =
    opts.maxObjectsPerRun !== undefined ? opts.maxObjectsPerRun : DEFAULT_MAX_OBJECTS;
  if (maxObjectsPerRun !== null) {
    if (
      !Number.isInteger(maxObjectsPerRun) ||
      maxObjectsPerRun < 1 ||
      !Number.isFinite(maxObjectsPerRun)
    ) {
      throw new Error('maxObjectsPerRun must be null (unlimited) or a positive integer');
    }
  }
  const maxBytes = opts.maxBytesPerObject !== undefined ? opts.maxBytesPerObject : DEFAULT_MAX_BYTES;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();

  const archiveBucket = getArchiveBucket();
  const s3 = getArchiveS3Client();

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
  const manifestPartitionDate = new Date();

  try {
    let rows;
    try {
      if (maxObjectsPerRun != null) {
        const { rows: r } = await querySupabasePostgres(
          `SELECT id, bucket_id, path, user_id, updated_at
           FROM archive.storage_objects
           WHERE archived_at IS NULL AND updated_at < $1::timestamptz
           ORDER BY updated_at ASC
           LIMIT $2::int`,
          [cutoffIso, maxObjectsPerRun]
        );
        rows = r;
      } else {
        const { rows: r } = await querySupabasePostgres(
          `SELECT id, bucket_id, path, user_id, updated_at
           FROM archive.storage_objects
           WHERE archived_at IS NULL AND updated_at < $1::timestamptz
           ORDER BY updated_at ASC`,
          [cutoffIso]
        );
        rows = r;
      }
    } catch (selErr) {
      const msg = selErr instanceof Error ? selErr.message : String(selErr);
      throw new Error(`archive.storage_objects query failed: ${msg}`);
    }

    const processed = [];
    const failed = /** @type {{ id: string, path: string, stage: string, message: string }[]} */ ([]);
    /** @type {string[]} */
    const manifestLines = [];

    for (const row of rows || []) {
      const id = row.id;
      const bucketId = row.bucket_id;
      const path = row.path;

      try {
        const { data: blob, error: dlErr } = await supabase.storage.from(bucketId).download(path);
        if (dlErr || !blob) {
          failed.push({
            id,
            path,
            stage: 'download',
            message: dlErr?.message || 'no blob',
          });
          continue;
        }

        const buf = Buffer.from(await blob.arrayBuffer());
        if (maxBytes != null && buf.length > maxBytes) {
          failed.push({
            id,
            path,
            stage: 'size',
            message: `object ${buf.length} bytes exceeds max ${maxBytes}`,
          });
          continue;
        }

        const key = `archive/storage/${id}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: archiveBucket,
            Key: key,
            Body: buf,
            ContentType: 'application/octet-stream',
          })
        );

        const { error: rmErr } = await supabase.storage.from(bucketId).remove([path]);
        if (rmErr) {
          failed.push({ id, path, stage: 'storage_delete', message: rmErr.message });
          continue;
        }

        const archivedAt = new Date().toISOString();
        let upErr;
        try {
          const { rowCount } = await querySupabasePostgres(
            `UPDATE archive.storage_objects
             SET archived_at = $2::timestamptz
             WHERE id = $1::uuid AND archived_at IS NULL`,
            [id, archivedAt]
          );
          if (rowCount === 0) {
            upErr = new Error('no row updated (already archived or missing id)');
          }
        } catch (e) {
          upErr = e instanceof Error ? e : new Error(String(e));
        }

        if (upErr) {
          failed.push({
            id,
            path,
            stage: 'mark_archived',
            message: `${upErr.message} (object removed from Storage; S3 key ${key} may need reconciliation)`,
          });
          continue;
        }

        const entry = {
          job_run_id: jobRunId,
          storage_object_id: id,
          user_id: row.user_id,
          bucket_id: bucketId,
          path,
          s3_bucket: archiveBucket,
          s3_key: key,
          archived_at: archivedAt,
          bytes: buf.length,
        };
        manifestLines.push(JSON.stringify(entry));
        processed.push({
          id,
          path,
          user_id: row.user_id,
          bucket_id: bucketId,
          archived_at: archivedAt,
          bytes: buf.length,
          s3: { bucket: archiveBucket, key },
        });
      } catch (e) {
        failed.push({
          id,
          path,
          stage: 'exception',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    /** Optional audit JSONL (one line per successful archive); same bucket as payloads. */
    let manifestKey = /** @type {string | null} */ (null);
    if (manifestLines.length > 0) {
      manifestKey = manifestObjectKey(jobRunId, manifestPartitionDate);
      await s3.send(
        new PutObjectCommand({
          Bucket: archiveBucket,
          Key: manifestKey,
          Body: Buffer.from(`${manifestLines.join('\n')}\n`, 'utf8'),
          ContentType: 'application/x-ndjson',
        })
      );
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

    const rowCount = (rows || []).length;
    const capped =
      maxObjectsPerRun != null ? rowCount >= maxObjectsPerRun : false;

    return {
      job_name: JOB_NAME,
      jobRunId,
      cutoff: jobRow.cutoff,
      archiveBucket,
      manifestKey,
      manifestLineCount: manifestLines.length,
      maxObjectsPerRun,
      eligibleQueried: rowCount,
      processedCount: processed.length,
      processed,
      failed,
      capped,
    };
  } catch (err) {
    await markJobFailed();
    throw err;
  }
}
