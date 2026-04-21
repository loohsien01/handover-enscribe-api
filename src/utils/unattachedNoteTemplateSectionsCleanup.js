/**
 * Task `unattached_note_template_sections`: delete noteTemplateSections with no
 * noteTemplateSectionOrders (any template). Age gate: updated_at <= cutoff, or
 * (updated_at is null and created_at <= cutoff). Same 7-day window as unattached_storage.
 * Persists archive.job_runs for audit (frozen cutoff + bounded result).
 */
import { querySupabasePostgres } from './supabasePostgresPool.js';

const sectionsTable = 'noteTemplateSections';
const ordersTable = 'noteTemplateSectionOrders';

const JOB_NAME = 'unattached_note_template_sections';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DELETES = 500;
const PAGE_SIZE = 150;
const RESULT_PREVIEW = 50;

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} [opts]
 * @param {number} [opts.retentionMs]
 * @param {number} [opts.maxDeletesPerRun]
 * @param {number} [opts.nowMs]
 * @returns {Promise<object>} includes `jobRunId`, `cutoff` from archive.job_runs when the run completes
 */
export async function runUnattachedNoteTemplateSectionsCleanup(supabase, opts = {}) {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxDeletesPerRun = opts.maxDeletesPerRun ?? DEFAULT_MAX_DELETES;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffTimestamptz = new Date(nowMs - retentionMs).toISOString();
  const cutoffIso = cutoffTimestamptz.replace(/\.\d{3}Z$/, 'Z');

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
      [JOB_NAME, cutoffTimestamptz]
    );
    jobRow = rows[0];
    if (!jobRow) throw new Error('no row returned');
  } catch (jobErr) {
    const msg = jobErr instanceof Error ? jobErr.message : String(jobErr);
    throw new Error(`archive.job_runs insert failed: ${msg}`);
  }

  jobRunId = jobRow.id;

  try {
    /** @type {string[]} */
    const deletedIds = [];
    /** @type {{ id: string, reason: string }[]} */
    const warnings = [];
    /** @type {{ id: string, message: string }[]} */
    const failed = [];
    let pagesScanned = 0;
    let candidatesSeen = 0;
    let offset = 0;

    /** PostgREST `or`: first branch must not be split as multiple OR operands. */
    const eligibilityOr = `and(updated_at.is.null,created_at.lte.${cutoffIso}),updated_at.lte.${cutoffIso}`;

    while (deletedIds.length < maxDeletesPerRun) {
      const { data: sections, error: secErr } = await supabase
        .from(sectionsTable)
        .select('id, user_id, updated_at, created_at')
        .or(eligibilityOr)
        .order('updated_at', { ascending: true, nullsFirst: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (secErr) {
        throw new Error(`noteTemplateSections query failed: ${secErr.message}`);
      }

      if (!sections?.length) {
        break;
      }

      pagesScanned += 1;
      candidatesSeen += sections.length;

      const attached = await loadAttachedSectionIds(supabase, sections.map((s) => s.id));
      const unattached = sections.filter((s) => !attached.has(String(s.id)));
      const room = maxDeletesPerRun - deletedIds.length;
      const toDelete = unattached.slice(0, room);

      if (toDelete.length === 0) {
        offset += sections.length;
        continue;
      }

      const ids = toDelete.map((s) => s.id);
      const { error: delErr } = await supabase.from(sectionsTable).delete().in('id', ids);

      if (delErr) {
        for (const row of toDelete) {
          failed.push({
            id: String(row.id),
            message: delErr.message || 'delete failed',
          });
        }
        offset += sections.length;
        continue;
      }

      for (const row of toDelete) {
        const sid = String(row.id);
        deletedIds.push(sid);
        if (row.user_id == null) {
          warnings.push({
            id: sid,
            reason: 'deleted_system_owned_unattached_section',
          });
        }
      }

      offset = 0;
    }

    const hitCap = deletedIds.length >= maxDeletesPerRun;
    const stats = {
      pagesScanned,
      candidatesSeen,
      deletedCount: deletedIds.length,
      failedCount: failed.length,
      warningCount: warnings.length,
      cutoffIso,
      mayHaveMore: hitCap,
    };

    const jobResult = {
      maxDeletesPerRun,
      retentionMs,
      stats,
      deletedIdsSample: deletedIds.slice(0, RESULT_PREVIEW),
      deletedIdsSampleTruncated: deletedIds.length > RESULT_PREVIEW,
      warningsSample: warnings.slice(0, RESULT_PREVIEW),
      warningsSampleTruncated: warnings.length > RESULT_PREVIEW,
      failedSample: failed.slice(0, RESULT_PREVIEW),
      failedSampleTruncated: failed.length > RESULT_PREVIEW,
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
      deletedIds,
      warnings,
      failed,
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
 * @param {(string|number|bigint)[]} sectionIds
 */
async function loadAttachedSectionIds(supabase, sectionIds) {
  const attached = new Set();
  const CHUNK = 200;
  for (let i = 0; i < sectionIds.length; i += CHUNK) {
    const chunk = sectionIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from(ordersTable)
      .select('noteTemplateSection_id')
      .in('noteTemplateSection_id', chunk);

    if (error) {
      throw new Error(`noteTemplateSectionOrders query failed: ${error.message}`);
    }
    for (const row of data || []) {
      if (row.noteTemplateSection_id != null) {
        attached.add(String(row.noteTemplateSection_id));
      }
    }
  }
  return attached;
}
