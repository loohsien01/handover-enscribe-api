#!/usr/bin/env node
/**
 * Infra smoke test for the live recordings S3 bucket (before API cutover).
 *
 * Validates: PutObject, HeadObject, GetObject, ListBucket (prefix), DeleteObject
 * using the same credential pattern as the API (dev keys in .env.local or EC2 role).
 *
 * Usage (from repo root):
 *   node sql/scripts/smoke-recordings-s3.mjs
 *   npm run smoke:recordings-s3
 *
 * Env (.env.local or shell):
 *   AWS_RECORDINGS_S3_BUCKET=enscribe-recordings-prod
 *   AWS_REGION=us-east-1
 *   AWS_ACTIONS_ACCESS_KEY_ID / AWS_ACTIONS_SECRET_ACCESS_KEY (local dev)
 *
 * On EC2 with instance profile: NODE_ENV=production node sql/scripts/smoke-recordings-s3.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getAwsSdkBaseClientConfig } from '../../src/utils/awsSdkBaseClientConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

function getBucketName() {
  const bucket = process.env.AWS_RECORDINGS_S3_BUCKET?.trim();
  if (!bucket) {
    throw new Error(
      'AWS_RECORDINGS_S3_BUCKET is not set. Add it to .env.local (e.g. enscribe-recordings-prod).'
    );
  }
  return bucket;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function step(label, fn) {
  process.stdout.write(`  … ${label} `);
  try {
    await fn();
    console.log('✓');
  } catch (err) {
    console.log('✗');
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} failed (${name}): ${msg}`);
  }
}

async function main() {
  const bucket = getBucketName();
  const region = process.env.AWS_REGION || 'us-east-1';
  const runId = randomUUID();
  const key = `smoke-test/${runId}/smoke.txt`;
  const body = `enscribe-recordings-s3 smoke ${new Date().toISOString()}\n`;

  const client = new S3Client(getAwsSdkBaseClientConfig('recordings S3 smoke'));

  console.log('Recordings S3 smoke test');
  console.log(`  bucket: ${bucket}`);
  console.log(`  region: ${region}`);
  console.log(`  key:    ${key}`);
  console.log('');

  await step('PutObject', async () => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'text/plain',
      })
    );
  });

  await step('HeadObject', async () => {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (!head.ContentLength || head.ContentLength < 1) {
      throw new Error('unexpected ContentLength');
    }
  });

  await step('GetObject', async () => {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await streamToString(res.Body);
    if (text !== body) {
      throw new Error('body mismatch');
    }
  });

  await step('ListObjectsV2 (prefix)', async () => {
    const prefix = `smoke-test/${runId}/`;
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 10 })
    );
    const names = (res.Contents || []).map((o) => o.Key);
    if (!names.includes(key)) {
      throw new Error(`list missing key; got ${JSON.stringify(names)}`);
    }
  });

  await step('DeleteObject', async () => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });

  await step('HeadObject after delete (expect 404)', async () => {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      throw new Error('object still exists after delete');
    } catch (err) {
      const code =
        err && typeof err === 'object' && '$metadata' in err && err.$metadata?.httpStatusCode;
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      if (code === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        return;
      }
      throw err;
    }
  });

  console.log('');
  console.log('All recordings S3 smoke checks passed.');
}

main().catch((err) => {
  console.error('');
  console.error(err instanceof Error ? err.message : String(err));
  console.error('');
  console.error('Hints:');
  console.error('  - Bucket exists in AWS_REGION and IAM allows s3:Put/Get/Delete/List on that bucket');
  console.error('  - Local: AWS_ACTIONS_ACCESS_KEY_ID + AWS_ACTIONS_SECRET_ACCESS_KEY in .env.local');
  console.error('  - EC2: instance role includes RecordingsBucketList + RecordingsObjectReadWrite');
  process.exit(1);
});
