/**
 * Orphan storage cleanup: files under audio-files/{userId}/ not referenced by recordings.recording_file_path.
 * Age gate uses Storage object updated_at (ISO string from list()).
 */
import { timingSafeEqual } from 'node:crypto';

export const AUDIO_BUCKET = 'audio-files';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DELETES = 500;
const PAGE_SIZE = 100;
const PARALLEL_LIST_BATCHES = 5;

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
 */
export async function runUnattachedStorageCleanup(supabase, opts = {}) {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxDeletesPerRun = opts.maxDeletesPerRun ?? DEFAULT_MAX_DELETES;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - retentionMs;

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

  let remaining = maxDeletesPerRun;

  for (const userId of userPrefixes) {
    if (remaining <= 0) break;

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
      const { error: batchError } = await supabase.storage.from(AUDIO_BUCKET).remove(chunk);

      if (batchError) {
        for (const path of chunk) {
          const { error: oneErr } = await supabase.storage.from(AUDIO_BUCKET).remove([path]);
          if (oneErr) {
            failed.push(path);
            errors[path] = oneErr.message || 'Storage error';
          } else {
            deleted.push(path);
            remaining--;
          }
        }
      } else {
        deleted.push(...chunk);
        remaining -= chunk.length;
      }
    }
  }

  const hitCap = deleted.length >= maxDeletesPerRun;

  return {
    deleted,
    failed,
    errors,
    stats: {
      userPrefixesScanned: userPrefixes.length,
      deletedCount: deleted.length,
      failedCount: failed.length,
      skippedNoTimestamp,
      skippedTooNew,
      skippedAttached,
      mayHaveMore: hitCap,
    },
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listRootUserPrefixes(supabase) {
  const dirs = new Set();
  let offset = 0;
  const rootPage = 1000;

  while (true) {
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).list('', {
      limit: rootPage,
      offset,
    });

    if (error) {
      throw new Error(`storage list root failed: ${error.message}`);
    }
    if (!data?.length) break;

    for (const item of data) {
      if (USER_DIR_UUID.test(item.name)) {
        dirs.add(item.name);
      }
    }

    if (data.length < rootPage) break;
    offset += rootPage;
  }

  return [...dirs];
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

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 */
export async function listAllFilesInUserFolder(supabase, userId) {
  const allStorageFiles = [];
  let currentOffset = 0;
  let hasMoreFiles = true;

  while (hasMoreFiles) {
    const batchPromises = [];
    for (let i = 0; i < PARALLEL_LIST_BATCHES; i++) {
      const off = currentOffset + i * PAGE_SIZE;
      batchPromises.push(
        supabase.storage.from(AUDIO_BUCKET).list(userId, {
          limit: PAGE_SIZE,
          offset: off,
        })
      );
    }

    const results = await Promise.all(batchPromises);

    let foundAnyData = false;
    for (const { data: storageData, error: storageError } of results) {
      if (storageError) {
        throw new Error(`storage list ${userId}: ${storageError.message}`);
      }
      if (!storageData || storageData.length === 0) {
        hasMoreFiles = false;
        break;
      }
      foundAnyData = true;
      allStorageFiles.push(...storageData);
      if (storageData.length < PAGE_SIZE) {
        hasMoreFiles = false;
        break;
      }
    }

    if (!foundAnyData) {
      hasMoreFiles = false;
    }

    currentOffset += PARALLEL_LIST_BATCHES * PAGE_SIZE;
  }

  return allStorageFiles;
}

export function safeEqualUtf8(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
