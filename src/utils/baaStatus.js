/**
 * BAA status helpers — load active version / acceptance and compute UX flags.
 * Strict re-sign: needs_acceptance when org has not accepted the currently active version.
 */

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
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @returns {Promise<{
 *   id: string,
 *   version_number: string,
 *   title: string,
 *   content_markdown: string,
 *   effective_date: string,
 * } | null>}
 */
export async function loadActiveBaaVersion(admin) {
  const { data, error } = await admin
    .from('baa_versions')
    .select('id, version_number, title, content_markdown, effective_date')
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * Acceptance row for a specific org + version (strict re-sign uses active version id).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {string} organizationId
 * @param {string} baaVersionId
 */
export async function loadBaaAcceptanceForVersion(admin, organizationId, baaVersionId) {
  const { data, error } = await admin
    .from('baa_acceptances')
    .select(
      `
      id,
      organization_id,
      baa_version_id,
      accepted_by_user_id,
      accepted_at,
      baa_versions ( version_number )
    `
    )
    .eq('organization_id', organizationId)
    .eq('baa_version_id', baaVersionId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const versionNumber = data.baa_versions?.version_number ?? null;
  return {
    id: data.id,
    organization_id: data.organization_id,
    baa_version_id: data.baa_version_id,
    accepted_by_user_id: data.accepted_by_user_id,
    accepted_at: data.accepted_at,
    version_number: versionNumber,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {{
 *   organization_id: string,
 *   baa_version_id: string,
 *   accepted_by_user_id: string,
 * }} row
 */
export async function insertBaaAcceptance(admin, row) {
  const { data, error } = await admin
    .from('baa_acceptances')
    .insert(row)
    .select(
      `
      id,
      organization_id,
      baa_version_id,
      accepted_by_user_id,
      accepted_at,
      baa_versions ( version_number )
    `
    )
    .single();

  if (error) throw error;

  return {
    id: data.id,
    organization_id: data.organization_id,
    baa_version_id: data.baa_version_id,
    accepted_by_user_id: data.accepted_by_user_id,
    accepted_at: data.accepted_at,
    version_number: data.baa_versions?.version_number ?? null,
  };
}
