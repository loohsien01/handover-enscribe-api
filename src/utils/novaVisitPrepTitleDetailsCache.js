/**
 * Ephemeral Redis cache for visit prep title details (poll delivery only; not Postgres).
 * @see docs/VISIT_PREP_ARCHITECTURE.md — Session title
 */

/** Align with completion partial poll window (~30 minutes). */
export const VISIT_PREP_TITLE_DETAILS_TTL_SEC = 30 * 60;

/**
 * @param {string} jobId
 * @returns {string}
 */
export function visitPrepTitleDetailsRedisKey(jobId) {
  return `nova:visit_prep:title_details:${jobId}`;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} jobId
 * @returns {Promise<{ patient_display_name: string, visit_kind: 'F/U' | 'NP' } | null>}
 */
export async function readVisitPrepTitleDetails(redis, jobId) {
  const raw = await redis.get(visitPrepTitleDetailsRedisKey(jobId));
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.patient_display_name !== 'string' ||
      (parsed?.visit_kind !== 'F/U' && parsed?.visit_kind !== 'NP')
    ) {
      return null;
    }
    return {
      patient_display_name: parsed.patient_display_name,
      visit_kind: parsed.visit_kind,
    };
  } catch {
    return null;
  }
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} jobId
 * @param {{ patient_display_name: string, visit_kind: 'F/U' | 'NP' }} details
 */
export async function writeVisitPrepTitleDetails(redis, jobId, details) {
  await redis.set(visitPrepTitleDetailsRedisKey(jobId), JSON.stringify(details), {
    EX: VISIT_PREP_TITLE_DETAILS_TTL_SEC,
  });
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {{ id: string, status: string, error_code?: string | null }} job
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
export async function enrichNovaCompletionPollWithVisitPrepTitleDetails(redis, job, payload) {
  const terminal =
    job.status === 'complete' ||
    (job.status === 'failed' && job.error_code === 'VISIT_PREP_PERSIST_FAILED');
  if (!terminal) {
    return payload;
  }

  const details = await readVisitPrepTitleDetails(redis, job.id);
  if (details) {
    payload.visit_prep_title_details = details;
  }
  return payload;
}
