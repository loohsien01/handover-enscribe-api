/**
 * Signed URL assertions for integration tests.
 * Mirrors {@link ../src/utils/recordingsStorageBackend.js} — Supabase vs S3 presigned URLs.
 */

/** @returns {'supabase' | 's3' | 'dual-read'} */
export function getRecordingsStorageBackendForTests() {
  const raw = (process.env.RECORDINGS_STORAGE_BACKEND || 'supabase').trim().toLowerCase();
  if (raw === 's3' || raw === 'dual-read') return raw;
  return 'supabase';
}

export function expectsS3UploadUrls() {
  const backend = getRecordingsStorageBackendForTests();
  return backend === 's3' || backend === 'dual-read';
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isValidUploadSignedUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  if (expectsS3UploadUrls()) {
    return (
      (url.includes('.amazonaws.com/') || url.includes('s3.')) &&
      url.includes('X-Amz-Algorithm=')
    );
  }
  return (
    url.includes('/storage/v1/object/upload/sign/') &&
    url.includes('?token=') &&
    url.includes('.supabase.co')
  );
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isValidDownloadSignedUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  const backend = getRecordingsStorageBackendForTests();
  if (backend === 's3') {
    return (
      (url.includes('.amazonaws.com/') || url.includes('s3.')) &&
      url.includes('X-Amz-Algorithm=')
    );
  }
  if (backend === 'dual-read') {
    const isSupabase =
      url.includes('/storage/v1/object/sign/') && url.includes('.supabase.co');
    const isS3 =
      (url.includes('.amazonaws.com/') || url.includes('s3.')) &&
      url.includes('X-Amz-Algorithm=');
    return isSupabase || isS3;
  }
  return url.includes('/storage/v1/object/sign/') && url.includes('.supabase.co');
}

export function uploadSignedUrlFormatLabel() {
  return expectsS3UploadUrls() ? 'S3 presigned PUT' : 'Supabase upload/sign';
}

/** @param {string} url */
export function downloadSignedUrlFormatLabel(url) {
  if (url.includes('.amazonaws.com/') || (url.includes('s3.') && url.includes('X-Amz-'))) {
    return 'S3 presigned GET';
  }
  return 'Supabase object/sign';
}
