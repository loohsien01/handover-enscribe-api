/**
 * Feature flag for live recording blob storage (Supabase `audio-files` vs S3).
 *
 * @typedef {'supabase' | 's3' | 'dual-read'} RecordingsStorageBackend
 */

/** @returns {RecordingsStorageBackend} */
export function getRecordingsStorageBackend() {
  const raw = (process.env.RECORDINGS_STORAGE_BACKEND || 'supabase').trim().toLowerCase();
  if (raw === 's3' || raw === 'dual-read') return raw;
  return 'supabase';
}

/** @returns {boolean} */
export function useS3ForWrites() {
  const b = getRecordingsStorageBackend();
  return b === 's3' || b === 'dual-read';
}

/** @returns {boolean} */
export function useS3ForReads() {
  const b = getRecordingsStorageBackend();
  return b === 's3' || b === 'dual-read';
}

/** @returns {boolean} */
export function useSupabaseForReads() {
  const b = getRecordingsStorageBackend();
  return b === 'supabase' || b === 'dual-read';
}

/** @returns {boolean} */
export function useSupabaseForWrites() {
  return getRecordingsStorageBackend() === 'supabase';
}
