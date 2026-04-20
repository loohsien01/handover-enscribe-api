/**
 * S3 client for retention / archive-purge uploads (Glacier-capable bucket in AWS).
 * Auth: same as Bedrock on dev (env keys) vs IAM role on EC2 — see {@link ./awsSdkBaseClientConfig.js}.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { getAwsSdkBaseClientConfig } from './awsSdkBaseClientConfig.js';

/** @type {S3Client | null} */
let cachedClient = null;

/** @returns {S3Client} */
export function getArchiveS3Client() {
  if (!cachedClient) {
    cachedClient = new S3Client(getAwsSdkBaseClientConfig('S3 archive'));
  }
  return cachedClient;
}
