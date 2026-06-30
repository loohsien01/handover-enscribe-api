/**
 * Facade for live recording blob storage (Supabase `audio-files` vs S3).
 * Controllers pass JWT-scoped paths; this module handles backend selection.
 */

import {
  useS3ForWrites,
  useS3ForReads,
  useSupabaseForReads,
  useSupabaseForWrites,
  getRecordingsStorageBackend,
} from './recordingsStorageBackend.js';
import {
  normalizeRecordingStorageKey,
  createPresignedUploadUrl,
  createPresignedDownloadUrl,
  s3ObjectExists,
  downloadS3Object,
  deleteS3Object,
  listS3UserObjects,
  listS3RootUserPrefixes,
  recordingContentTypeForExtension,
  isS3NotFoundError,
} from './recordingsS3Client.js';

export const AUDIO_BUCKET = 'audio-files';

export { normalizeRecordingStorageKey };

/** @typedef {import('./recordingsS3Client.js').StorageListItem} StorageListItem */

const PAGE_SIZE = 100;
const PARALLEL_LIST_BATCHES = 5;

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function recordingObjectExists(supabase, key) {
  const normalized = normalizeRecordingStorageKey(key);
  if (!normalized) return false;

  if (useS3ForReads()) {
    const onS3 = await s3ObjectExists(normalized);
    if (onS3) return true;
    if (getRecordingsStorageBackend() === 's3') return false;
  }

  if (useSupabaseForReads()) {
    const parts = normalized.split('/');
    if (parts.length !== 2) return false;
    const [folder, filename] = parts;
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).list(folder, {
      search: filename,
    });
    if (error) throw new Error(error.message || 'Storage list failed');
    return (data || []).some((f) => f.name === filename);
  }

  return false;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 * @param {{ contentType?: string, expiresIn?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function createRecordingUploadUrl(supabase, key, opts = {}) {
  const normalized = normalizeRecordingStorageKey(key);

  if (useS3ForWrites()) {
    return createPresignedUploadUrl(normalized, opts);
  }

  const { data, error } = await supabase.storage.from(AUDIO_BUCKET).createSignedUploadUrl(normalized);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || 'Failed to generate upload URL');
  }
  return data.signedUrl;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 * @param {number} [expiresIn=3600]
 * @returns {Promise<string>}
 */
export async function createRecordingDownloadUrl(supabase, key, expiresIn = 3600) {
  const normalized = normalizeRecordingStorageKey(key);

  if (useS3ForReads()) {
    const onS3 = await s3ObjectExists(normalized);
    if (onS3) {
      return createPresignedDownloadUrl(normalized, expiresIn);
    }
    if (getRecordingsStorageBackend() === 's3') {
      throw new Error(`Recording not found in S3: ${normalized}`);
    }
  }

  if (useSupabaseForReads()) {
    const { data, error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(normalized, expiresIn);
    if (error || !data?.signedUrl) {
      throw new Error(error?.message || 'Failed to generate download URL');
    }
    return data.signedUrl;
  }

  throw new Error('No recordings storage backend configured for reads');
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
export async function downloadRecordingObject(supabase, key) {
  const normalized = normalizeRecordingStorageKey(key);

  if (useS3ForReads()) {
    try {
      if (await s3ObjectExists(normalized)) {
        return downloadS3Object(normalized);
      }
    } catch (err) {
      if (getRecordingsStorageBackend() === 's3' || !isS3NotFoundError(err)) {
        throw err;
      }
    }
  }

  if (useSupabaseForReads()) {
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).download(normalized);
    if (error) throw error;
    if (!data) throw new Error('audio download failed (no blob returned)');
    return Buffer.from(await data.arrayBuffer());
  }

  throw new Error('No recordings storage backend configured for download');
}

/**
 * @param {unknown} err
 * @param {string} [detail]
 * @returns {boolean}
 */
export function isMissingRecordingObjectError(err, detail = '') {
  const msg = [
    err && typeof err === 'object' && 'message' in err ? String(err.message) : '',
    detail,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (isS3NotFoundError(err)) return true;
  return (
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('object not found') ||
    msg.includes('no such key')
  );
}

/**
 * Idempotent delete from active backend(s). dual-read removes from both.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteRecordingObject(supabase, key) {
  const normalized = normalizeRecordingStorageKey(key);
  if (!normalized) return;

  const backend = getRecordingsStorageBackend();
  const errors = [];

  if (useS3ForWrites() || backend === 'dual-read') {
    try {
      await deleteS3Object(normalized);
    } catch (err) {
      if (!isS3NotFoundError(err)) errors.push(err);
    }
  }

  if (useSupabaseForWrites() || backend === 'dual-read') {
    const { error } = await supabase.storage.from(AUDIO_BUCKET).remove([normalized]);
    if (error) errors.push(error);
  }

  if (errors.length > 0) {
    const first = errors[0];
    throw first instanceof Error ? first : new Error(String(first));
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<StorageListItem[]>}
 */
async function listSupabaseUserObjects(supabase, userId) {
  const allStorageFiles = [];
  let currentOffset = 0;
  let hasMoreFiles = true;

  while (hasMoreFiles) {
    const batchPromises = [];
    for (let i = 0; i < PARALLEL_LIST_BATCHES; i++) {
      const offset = currentOffset + i * PAGE_SIZE;
      batchPromises.push(
        supabase.storage.from(AUDIO_BUCKET).list(userId, {
          limit: PAGE_SIZE,
          offset,
        })
      );
    }

    const results = await Promise.all(batchPromises);
    let foundAnyData = false;

    for (const { data: storageData, error: storageError } of results) {
      if (storageError) {
        throw new Error(storageError.message || 'Storage list failed');
      }
      if (!storageData || storageData.length === 0) {
        hasMoreFiles = false;
        break;
      }
      foundAnyData = true;
      for (const file of storageData) {
        allStorageFiles.push({
          name: file.name,
          metadata: { size: file.metadata?.size ?? null },
          created_at: file.created_at ?? null,
          updated_at: file.updated_at ?? null,
        });
      }
      if (storageData.length < PAGE_SIZE) {
        hasMoreFiles = false;
        break;
      }
    }

    if (!foundAnyData) hasMoreFiles = false;
    currentOffset += PARALLEL_LIST_BATCHES * PAGE_SIZE;
  }

  return allStorageFiles;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<StorageListItem[]>}
 */
export async function listUserRecordingObjects(supabase, userId) {
  const backend = getRecordingsStorageBackend();

  if (backend === 'supabase') {
    return listSupabaseUserObjects(supabase, userId);
  }

  if (backend === 's3') {
    return listS3UserObjects(userId);
  }

  const [s3Files, sbFiles] = await Promise.all([
    listS3UserObjects(userId),
    listSupabaseUserObjects(supabase, userId),
  ]);

  const byName = new Map();
  for (const file of sbFiles) {
    byName.set(file.name, file);
  }
  for (const file of s3Files) {
    byName.set(file.name, file);
  }
  return [...byName.values()];
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<string[]>}
 */
export async function listRecordingRootUserPrefixes(supabase) {
  const backend = getRecordingsStorageBackend();

  if (backend === 'supabase') {
    return listSupabaseRootUserPrefixes(supabase);
  }

  if (backend === 's3') {
    return listS3RootUserPrefixes();
  }

  const [fromS3, fromSb] = await Promise.all([
    listS3RootUserPrefixes(),
    listSupabaseRootUserPrefixes(supabase),
  ]);
  return [...new Set([...fromS3, ...fromSb])];
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<string[]>}
 */
async function listSupabaseRootUserPrefixes(supabase) {
  const USER_DIR_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const dirs = new Set();
  let offset = 0;
  const rootPage = 1000;

  while (true) {
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).list('', {
      limit: rootPage,
      offset,
    });

    if (error) throw new Error(`storage list root failed: ${error.message}`);
    if (!data?.length) break;

    for (const item of data) {
      if (USER_DIR_UUID.test(item.name)) dirs.add(item.name);
    }

    if (data.length < rootPage) break;
    offset += rootPage;
  }

  return [...dirs];
}

export { recordingContentTypeForExtension };
