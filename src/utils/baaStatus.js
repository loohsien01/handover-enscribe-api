/**
 * BAA status helpers — load active version / acceptance and compute UX flags.
 * Strict re-sign: needs_acceptance when org has not accepted the currently active version.
 */
import { pgQueryOne } from './pgQueryHelpers.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';

/**
 * @param {{
 *   activeVersion: { id: string, version_number: string } | null,
 *   acceptance: {
 *     id: string,
 *     baa_version_id: string,
 *     accepted_at: string,
 *     accepted_by_user_id: string,
 *     version_number?: string,
 *   } | null,
 *   memberRole: string | null | undefined,
 * }} input
 */
export function computeBaaStatus({ activeVersion, acceptance, memberRole }) {
  const needs_acceptance = Boolean(
    activeVersion && (!acceptance || acceptance.baa_version_id !== activeVersion.id)
  );
  const can_accept = memberRole === 'owner' && Boolean(activeVersion);

  return {
    active_version: activeVersion?.version_number ?? null,
    acceptance: acceptance
      ? {
          id: acceptance.id,
          version_number: acceptance.version_number ?? activeVersion?.version_number ?? null,
          accepted_at: acceptance.accepted_at,
          accepted_by_user_id: acceptance.accepted_by_user_id,
        }
      : null,
    needs_acceptance,
    can_accept,
  };
}

/**
 * @returns {Promise<{
 *   id: string,
 *   version_number: string,
 *   title: string,
 *   content_markdown: string,
 *   effective_date: string,
 * } | null>}
 */
export async function loadActiveBaaVersion() {
  const row = await pgQueryOne(
    `SELECT id, version_number, title, content_markdown, effective_date
       FROM public.baa_versions
      WHERE is_active = true
      LIMIT 1`
  );
  return row || null;
}

/**
 * Acceptance row for a specific org + version (strict re-sign uses active version id).
 *
 * @param {string} organizationId
 * @param {string} baaVersionId
 */
export async function loadBaaAcceptanceForVersion(organizationId, baaVersionId) {
  const row = await pgQueryOne(
    `SELECT a.id,
            a.organization_id,
            a.baa_version_id,
            a.accepted_by_user_id,
            a.accepted_at,
            v.version_number
       FROM public.baa_acceptances a
       LEFT JOIN public.baa_versions v ON v.id = a.baa_version_id
      WHERE a.organization_id = $1
        AND a.baa_version_id = $2
      LIMIT 1`,
    [organizationId, baaVersionId]
  );
  if (!row) return null;

  return {
    id: row.id,
    organization_id: row.organization_id,
    baa_version_id: row.baa_version_id,
    accepted_by_user_id: row.accepted_by_user_id,
    accepted_at: row.accepted_at,
    version_number: row.version_number ?? null,
  };
}

/**
 * @param {{
 *   organization_id: string,
 *   baa_version_id: string,
 *   accepted_by_user_id: string,
 * }} row
 */
export async function insertBaaAcceptance(row) {
  const inserted = await pgQueryOne(
    `INSERT INTO public.baa_acceptances (
       organization_id, baa_version_id, accepted_by_user_id
     ) VALUES ($1, $2, $3)
     RETURNING id, organization_id, baa_version_id, accepted_by_user_id, accepted_at`,
    [row.organization_id, row.baa_version_id, row.accepted_by_user_id]
  );
  if (!inserted) throw new Error('baa_acceptances insert returned no row');

  const version = await pgQueryOne(
    `SELECT version_number FROM public.baa_versions WHERE id = $1 LIMIT 1`,
    [row.baa_version_id]
  );

  return {
    id: inserted.id,
    organization_id: inserted.organization_id,
    baa_version_id: inserted.baa_version_id,
    accepted_by_user_id: inserted.accepted_by_user_id,
    accepted_at: inserted.accepted_at,
    version_number: version?.version_number ?? null,
  };
}
