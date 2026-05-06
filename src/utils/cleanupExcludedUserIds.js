import { querySupabasePostgres } from './supabasePostgresPool.js';

/**
 * `user_id` values with `internal_access.exclude_from_cleanup` (internal cleanup must not archive/delete their data).
 * @returns {Promise<Set<string>>}
 */
export async function loadCleanupExcludedUserIdSet() {
  const { rows } = await querySupabasePostgres(
    `SELECT user_id::text AS uid
     FROM public.internal_access
     WHERE exclude_from_cleanup IS TRUE
       AND user_id IS NOT NULL`
  );
  const set = new Set();
  for (const r of rows || []) {
    if (r.uid) set.add(String(r.uid));
  }
  return set;
}
