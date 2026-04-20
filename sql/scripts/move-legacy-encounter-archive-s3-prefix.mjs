#!/usr/bin/env node
/**
 * TEMP: one-off S3 "move" from legacy `archive/storage/{uuid}/…` to
 * `archive/encounter-bundles/{user_id}/{queue_id}/…` (same bucket, e.g. enscribe-supabase-archive).
 *
 * S3 has no rename: server-side CopyObject + DeleteObject per key.
 * If objects are Glacier-class and not restored, copy may fail — check storage class first.
 *
 * This is a normal List/Copy/Delete workload. It is not written around Glacier retrieval
 * quotas or an informal "AWS access count" budget — expect standard per-request/per-GB pricing.
 *
 * Usage (from repo root):
 *   node sql/scripts/move-legacy-encounter-archive-s3-prefix.mjs
 *
 * Loads ../../.env.local (AWS_ARCHIVE_S3_BUCKET, AWS_REGION, dev keys — same as API).
 * For EC2 instance profile creds, run with NODE_ENV=production so dev key env is not required.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getArchiveS3Client } from '../../src/utils/archiveS3Client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

// --- EDIT THESE (hardcode before running) ---------------------------------

/** Legacy id only (UUID) — objects live under `archive/storage/<this>/…`. */
const LEGACY_ARCHIVE_FOLDER = '7e577005-8f90-4f4a-9369-63e0a3a5caa9';

/** Supabase user id for the encounter bundle prefix. */
const USER_ID = '0c58a5fd-7456-46fe-902c-f8a68c6def6f';

/** `archive.patient_encounter_archive_queue.id` (bundle id in S3 paths). */
const PATIENT_ENCOUNTER_ARCHIVE_QUEUE_ID = 'bc6ffbd8-7156-4245-97b7-0eae9fdb180e';


/**
 * If non-empty: the legacy prefix must match exactly one object; it is written as
 * `destPrefix + DEST_OBJECT_NAME_OVERRIDE` (e.g. `recording.m4a`, `db-rows.jsonl`).
 * Leave empty to keep each source’s relative path / filename under the destination prefix.
 */
const DEST_OBJECT_NAME_OVERRIDE = 'recording.webm';
/** Leave empty to use `process.env.AWS_ARCHIVE_S3_BUCKET`. */

const ARCHIVE_S3_BUCKET_OVERRIDE = '';

/**
 * When `DEST_OBJECT_NAME_OVERRIDE` is empty: rename any destination **basename** that equals
 * `SOURCE_LEAF_RENAME` to `DEST_LEAF_RENAME`. Both must be non-empty to apply; other keys unchanged.
 */
const SOURCE_LEAF_RENAME = '';
const DEST_LEAF_RENAME = '';

/** If true, only prints planned copy/delete; no API writes. */
const DRY_RUN = false;

// --------------------------------------------------------------------------

const bucket =
  (typeof ARCHIVE_S3_BUCKET_OVERRIDE === 'string' && ARCHIVE_S3_BUCKET_OVERRIDE.trim()) ||
  process.env.AWS_ARCHIVE_S3_BUCKET;

const legacyBase = `archive/storage/${LEGACY_ARCHIVE_FOLDER.trim()}`;
const destPrefix = `archive/encounter-bundles/${USER_ID.trim()}/${PATIENT_ENCOUNTER_ARCHIVE_QUEUE_ID.trim()}/`;

function destKeyForSourceKey(sourceKey) {
  if (sourceKey === legacyBase) {
    const leaf = sourceKey.split('/').filter(Boolean).pop() || 'object';
    return `${destPrefix}${leaf}`;
  }
  const slash = `${legacyBase}/`;
  if (sourceKey.startsWith(slash)) {
    return `${destPrefix}${sourceKey.slice(slash.length)}`;
  }
  return null;
}

function assertConfigured() {
  if (!bucket) {
    console.error('Set ARCHIVE_S3_BUCKET_OVERRIDE or AWS_ARCHIVE_S3_BUCKET in .env.local.');
    process.exit(1);
  }
  if (!LEGACY_ARCHIVE_FOLDER.trim()) {
    console.error('Set LEGACY_ARCHIVE_FOLDER.');
    process.exit(1);
  }
  for (const [name, v] of [
    ['USER_ID', USER_ID],
    ['PATIENT_ENCOUNTER_ARCHIVE_QUEUE_ID', PATIENT_ENCOUNTER_ARCHIVE_QUEUE_ID],
  ]) {
    if (!v || typeof v !== 'string' || !v.trim() || v.includes('{')) {
      console.error(`Replace placeholder in ${name} before running (current value invalid).`);
      process.exit(1);
    }
  }

  const leafOverride = typeof DEST_OBJECT_NAME_OVERRIDE === 'string' ? DEST_OBJECT_NAME_OVERRIDE.trim() : '';
  const renameFrom = typeof SOURCE_LEAF_RENAME === 'string' ? SOURCE_LEAF_RENAME.trim() : '';
  const renameTo = typeof DEST_LEAF_RENAME === 'string' ? DEST_LEAF_RENAME.trim() : '';
  if (leafOverride && (renameFrom || renameTo)) {
    console.error('Use either DEST_OBJECT_NAME_OVERRIDE or SOURCE_LEAF_RENAME/DEST_LEAF_RENAME, not both.');
    process.exit(1);
  }
  if ((renameFrom && !renameTo) || (!renameFrom && renameTo)) {
    console.error('Set both SOURCE_LEAF_RENAME and DEST_LEAF_RENAME, or leave both empty.');
    process.exit(1);
  }
}

/**
 * @param {string} destKey
 * @param {string} renameFrom
 * @param {string} renameTo
 */
function applyBasenameRename(destKey, renameFrom, renameTo) {
  if (!renameFrom || !renameTo) return destKey;
  const parts = destKey.split('/');
  const last = parts[parts.length - 1];
  if (last === renameFrom) parts[parts.length - 1] = renameTo;
  return parts.join('/');
}

async function listAllKeys(client, Bucket, Prefix) {
  /** @type {string[]} */
  const keys = [];
  let ContinuationToken;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket,
        Prefix,
        ContinuationToken,
      })
    );
    for (const o of out.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function main() {
  assertConfigured();

  const client = getArchiveS3Client();
  const keys = await listAllKeys(client, bucket, legacyBase);

  const filtered = keys.filter((k) => {
    const dest = destKeyForSourceKey(k);
    if (!dest) {
      console.warn(`skip (unexpected key under prefix): ${k}`);
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    console.log(`No objects listed under prefix "${legacyBase}" in bucket "${bucket}".`);
    process.exit(0);
  }

  const leafOverride = typeof DEST_OBJECT_NAME_OVERRIDE === 'string' ? DEST_OBJECT_NAME_OVERRIDE.trim() : '';
  const renameFrom = typeof SOURCE_LEAF_RENAME === 'string' ? SOURCE_LEAF_RENAME.trim() : '';
  const renameTo = typeof DEST_LEAF_RENAME === 'string' ? DEST_LEAF_RENAME.trim() : '';

  if (leafOverride && filtered.length !== 1) {
    console.error(
      `DEST_OBJECT_NAME_OVERRIDE is set but "${legacyBase}" matched ${filtered.length} objects; set override empty or fix prefix.`
    );
    process.exit(1);
  }

  console.log(`Bucket: ${bucket}\nLegacy prefix: ${legacyBase}\nDest prefix: ${destPrefix}\nObjects: ${filtered.length}\nDRY_RUN: ${DRY_RUN}\n`);

  for (const sourceKey of filtered) {
    let destKey = leafOverride ? `${destPrefix}${leafOverride}` : destKeyForSourceKey(sourceKey);
    if (!destKey) continue;
    if (!leafOverride) destKey = applyBasenameRename(destKey, renameFrom, renameTo);

    if (DRY_RUN) {
      console.log(`[dry-run] copy s3://${bucket}/${sourceKey} -> s3://${bucket}/${destKey}`);
      console.log(`[dry-run] delete s3://${bucket}/${sourceKey}`);
      continue;
    }

    const copySource = `${bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: destKey,
        CopySource: copySource,
      })
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
    console.log(`moved ${sourceKey} -> ${destKey}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
