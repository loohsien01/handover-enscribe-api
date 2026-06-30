#!/usr/bin/env node
/**
 * Part 7 — One-time copy: Supabase Storage `audio-files` → `AWS_RECORDINGS_S3_BUCKET`.
 *
 * For each object: download from Supabase, PutObject to S3 with same key `{userId}/{filename}`,
 * verify HeadObject size. Skips objects already on S3 with matching size.
 *
 * Usage (from repo root):
 *   npm run migrate:audio-files-to-recordings-s3
 *   npm run migrate:audio-files-to-recordings-s3 -- --dry-run
 *   npm run migrate:audio-files-to-recordings-s3 -- --prefix=<user-uuid>
 *   npm run migrate:audio-files-to-recordings-s3 -- --cap=100
 *
 * Env (.env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   AWS_RECORDINGS_S3_BUCKET, AWS_REGION
 *   AWS_ACTIONS_ACCESS_KEY_ID / AWS_ACTIONS_SECRET_ACCESS_KEY (local dev)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getAwsSdkBaseClientConfig } from '../../src/utils/awsSdkBaseClientConfig.js';
import { normalizeRecordingStorageKey } from '../../src/utils/recordingsS3Client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const SUPABASE_BUCKET = 'audio-files';
const LIST_LIMIT = 1000;

let PATH_PREFIX = '';
let CAP = null;
let DRY_RUN = false;

for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') DRY_RUN = true;
  else if (arg.startsWith('--prefix=')) {
    PATH_PREFIX = arg.slice('--prefix='.length).trim().replace(/^\/+|\/+$/g, '');
  } else if (arg.startsWith('--cap=')) {
    const n = Number.parseInt(arg.slice('--cap='.length), 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error('Invalid --cap');
      process.exit(1);
    }
    CAP = n;
  } else if (arg === '--help' || arg === '-h') {
    console.log(
      'Usage: node sql/scripts/migrate-audio-files-to-recordings-s3.mjs [--dry-run] [--prefix=userId] [--cap=N]'
    );
    process.exit(0);
  }
}

const REPORTS_DIR = path.join(__dirname, 'reports', 'audio-files-migration');

function assertEnv() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }
  if (!process.env.AWS_RECORDINGS_S3_BUCKET?.trim()) {
    throw new Error('Set AWS_RECORDINGS_S3_BUCKET in .env.local');
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} dirPrefix
 */
async function listFilesRecursive(supabase, dirPrefix) {
  /** @type {{ path: string, size: number | null }[]} */
  const out = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).list(dirPrefix, {
      limit: LIST_LIMIT,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (error) throw new Error(`storage.list(${JSON.stringify(dirPrefix)}): ${error.message}`);
    if (!data?.length) break;

    for (const item of data) {
      const rel = dirPrefix ? `${dirPrefix}/${item.name}` : item.name;
      if (item.id == null) {
        const nested = await listFilesRecursive(supabase, rel);
        out.push(...nested);
      } else {
        out.push({
          path: normalizeRecordingStorageKey(rel),
          size: item.metadata?.size ?? null,
        });
      }
    }

    if (data.length < LIST_LIMIT) break;
    offset += LIST_LIMIT;
  }

  return out;
}

/**
 * @param {S3Client} s3
 * @param {string} bucket
 * @param {string} key
 */
async function s3HeadSize(s3, bucket, key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch (err) {
    const code =
      err && typeof err === 'object' && '$metadata' in err ? err.$metadata?.httpStatusCode : null;
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (code === 404 || name === 'NotFound' || name === 'NoSuchKey') return null;
    throw err;
  }
}

async function main() {
  assertEnv();

  const bucket = process.env.AWS_RECORDINGS_S3_BUCKET.trim();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const s3 = new S3Client(getAwsSdkBaseClientConfig('recordings S3 migration'));

  console.log('Supabase → S3 recordings migration');
  console.log(`  source:  supabase:${SUPABASE_BUCKET}`);
  console.log(`  dest:    s3://${bucket}`);
  console.log(`  prefix:  ${PATH_PREFIX || '(all)'}`);
  console.log(`  dry-run: ${DRY_RUN}`);
  console.log('');

  const objects = await listFilesRecursive(supabase, PATH_PREFIX);
  const toProcess = CAP != null ? objects.slice(0, CAP) : objects;

  console.log(`Listed ${objects.length} object(s); processing ${toProcess.length}`);

  const stats = { copied: 0, skipped: 0, failed: 0 };
  /** @type {{ path: string, error: string }[]} */
  const failures = [];

  for (const obj of toProcess) {
    const key = obj.path;
    if (!key || !key.includes('/')) {
      stats.skipped++;
      continue;
    }

    try {
      const existingSize = await s3HeadSize(s3, bucket, key);
      if (existingSize != null && obj.size != null && existingSize === obj.size) {
        stats.skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] would copy ${key}`);
        stats.copied++;
        continue;
      }

      const { data: blob, error: dlErr } = await supabase.storage.from(SUPABASE_BUCKET).download(key);
      if (dlErr || !blob) {
        throw new Error(dlErr?.message || 'download failed');
      }

      const body = Buffer.from(await blob.arrayBuffer());
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: blob.type || 'application/octet-stream',
        })
      );

      const headSize = await s3HeadSize(s3, bucket, key);
      if (headSize == null || headSize !== body.length) {
        throw new Error(`size mismatch after upload (local=${body.length}, s3=${headSize})`);
      }

      stats.copied++;
      if (stats.copied % 25 === 0) {
        console.log(`  … copied ${stats.copied} so far`);
      }
    } catch (err) {
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ path: key, error: msg });
      console.error(`  ✗ ${key}: ${msg}`);
    }
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORTS_DIR, `migrate-${stamp}-summary.json`);
  const summary = {
    at: new Date().toISOString(),
    dryRun: DRY_RUN,
    prefix: PATH_PREFIX || null,
    cap: CAP,
    listed: objects.length,
    processed: toProcess.length,
    stats,
    failures,
  };
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  console.log('');
  console.log('Summary:', stats);
  console.log(`Report: ${reportPath}`);

  if (stats.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
