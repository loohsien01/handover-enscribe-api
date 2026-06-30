/**
 * S3 client for live recording blobs (`AWS_RECORDINGS_S3_BUCKET`).
 * Auth: {@link ./awsSdkBaseClientConfig.js} (dev keys vs EC2 instance profile).
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getAwsSdkBaseClientConfig } from './awsSdkBaseClientConfig.js';

/** @type {S3Client | null} */
let cachedClient = null;

const DEFAULT_UPLOAD_EXPIRY = 3600;
const DEFAULT_DOWNLOAD_EXPIRY = 3600;

/** @returns {S3Client} */
export function getRecordingsS3Client() {
  if (!cachedClient) {
    cachedClient = new S3Client(getAwsSdkBaseClientConfig('recordings S3'));
  }
  return cachedClient;
}

/** @returns {string} */
export function getRecordingsBucket() {
  const bucket = process.env.AWS_RECORDINGS_S3_BUCKET?.trim();
  if (!bucket) {
    throw new Error(
      'AWS_RECORDINGS_S3_BUCKET is not set. Configure it in .env.local or EC2 environment.'
    );
  }
  return bucket;
}

/**
 * @param {string | null | undefined} path
 * @returns {string}
 */
export function normalizeRecordingStorageKey(path) {
  if (path == null || typeof path !== 'string') return '';
  let p = path.trim();
  if (p.startsWith('audio-files/')) p = p.replace(/^audio-files\//, '');
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isS3NotFoundError(err) {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String(err.name) : '';
  const code =
    '$metadata' in err && err.$metadata && typeof err.$metadata === 'object'
      ? err.$metadata.httpStatusCode
      : undefined;
  return code === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

/**
 * @param {import('stream').Readable | Blob | undefined} body
 * @returns {Promise<Buffer>}
 */
async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * @param {string} key
 * @param {{ contentType?: string, expiresIn?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function createPresignedUploadUrl(key, opts = {}) {
  const normalized = normalizeRecordingStorageKey(key);
  const expiresIn = opts.expiresIn ?? DEFAULT_UPLOAD_EXPIRY;
  const command = new PutObjectCommand({
    Bucket: getRecordingsBucket(),
    Key: normalized,
    ...(opts.contentType ? { ContentType: opts.contentType } : {}),
  });
  return getSignedUrl(getRecordingsS3Client(), command, { expiresIn });
}

/**
 * @param {string} key
 * @param {number} [expiresIn]
 * @returns {Promise<string>}
 */
export async function createPresignedDownloadUrl(key, expiresIn = DEFAULT_DOWNLOAD_EXPIRY) {
  const normalized = normalizeRecordingStorageKey(key);
  const command = new GetObjectCommand({
    Bucket: getRecordingsBucket(),
    Key: normalized,
  });
  return getSignedUrl(getRecordingsS3Client(), command, { expiresIn });
}

/**
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function s3ObjectExists(key) {
  const normalized = normalizeRecordingStorageKey(key);
  if (!normalized) return false;
  try {
    await getRecordingsS3Client().send(
      new HeadObjectCommand({ Bucket: getRecordingsBucket(), Key: normalized })
    );
    return true;
  } catch (err) {
    if (isS3NotFoundError(err)) return false;
    throw err;
  }
}

/**
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
export async function downloadS3Object(key) {
  const normalized = normalizeRecordingStorageKey(key);
  const res = await getRecordingsS3Client().send(
    new GetObjectCommand({ Bucket: getRecordingsBucket(), Key: normalized })
  );
  return streamToBuffer(res.Body);
}

/**
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteS3Object(key) {
  const normalized = normalizeRecordingStorageKey(key);
  if (!normalized) return;
  await getRecordingsS3Client().send(
    new DeleteObjectCommand({ Bucket: getRecordingsBucket(), Key: normalized })
  );
}

/**
 * @typedef {{ name: string, metadata: { size: number | null }, created_at: string | null, updated_at: string | null }} StorageListItem
 */

/**
 * @param {string} userId
 * @param {{ pageSize?: number }} [opts]
 * @returns {Promise<StorageListItem[]>}
 */
export async function listS3UserObjects(userId, opts = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const prefix = `${userId}/`;
  /** @type {StorageListItem[]} */
  const all = [];
  let continuationToken = undefined;

  do {
    const res = await getRecordingsS3Client().send(
      new ListObjectsV2Command({
        Bucket: getRecordingsBucket(),
        Prefix: prefix,
        MaxKeys: pageSize,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })
    );

    for (const obj of res.Contents || []) {
      const key = obj.Key || '';
      if (!key || key === prefix) continue;
      const name = key.slice(prefix.length);
      if (!name || name.includes('/')) continue;
      const iso = obj.LastModified ? obj.LastModified.toISOString() : null;
      all.push({
        name,
        metadata: { size: obj.Size ?? null },
        created_at: iso,
        updated_at: iso,
      });
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return all;
}

/** UUID directory names at bucket root (user folders). */
const USER_DIR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @returns {Promise<string[]>}
 */
export async function listS3RootUserPrefixes() {
  const dirs = new Set();
  let continuationToken = undefined;

  while (true) {
    const res = await getRecordingsS3Client().send(
      new ListObjectsV2Command({
        Bucket: getRecordingsBucket(),
        Delimiter: '/',
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })
    );

    for (const cp of res.CommonPrefixes || []) {
      const p = (cp.Prefix || '').replace(/\/$/, '');
      const name = p.split('/').pop() || p;
      if (USER_DIR_UUID.test(name)) dirs.add(name);
    }

    if (!res.IsTruncated) break;
    continuationToken = res.NextContinuationToken;
  }

  return [...dirs];
}

/**
 * @param {string} extension
 * @returns {string | undefined}
 */
export function recordingContentTypeForExtension(extension) {
  const map = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
  };
  return map[extension.toLowerCase()];
}
