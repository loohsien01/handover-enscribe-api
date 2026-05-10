/**
 * Drains `nova:summarize:queue` (Redis) and runs rolling summarization via Bedrock + Supabase.
 * Summarizer model: `NOVA_SUMMARIZE_BEDROCK_MODEL_ID`, else same Bedrock ID as Nova preset Sonnet (`NOVA_BEDROCK_MODEL_SONNET` / default profile).
 *
 * Env: same as API (`.env.local`): `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
 * AWS Bedrock credentials, `RSA_PRIVATE_KEY` / encryption env used to unwrap user master keys.
 *
 * Run: `npm run worker:nova-summarize`
 * Production: run as a separate systemd unit alongside the Fastify service.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { getRedisClient } from '../utils/redisClient.js';
import supabaseAdmin from '../utils/supabaseAdmin.js';
import {
  NOVA_SUMMARIZE_QUEUE_KEY,
  sweepNovaSummarizeDueSet,
  novaSummarizeSweepIntervalSec,
} from '../utils/novaSummarizeQueue.js';
import { processNovaSummarizeJob } from '../utils/novaSummarizeService.js';

/**
 * @param {import('redis').RedisClientType} redis
 * @param {number} timeoutSec
 * @returns {Promise<string | null>}
 */
async function blockingPopSummarizeJob(redis, timeoutSec) {
  const reply = await redis.sendCommand(['BRPOP', NOVA_SUMMARIZE_QUEUE_KEY, String(timeoutSec)]);
  if (reply == null) return null;
  if (!Array.isArray(reply) || reply.length < 2) return null;
  const el = reply[1];
  return typeof el === 'string' ? el : el?.toString?.('utf8') ?? null;
}

async function main() {
  const redis = await getRedisClient();
  if (!redis) {
    console.error('[novaSummarizeWorker] Redis unavailable (check REDIS_URL)');
    process.exit(1);
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    console.error('[novaSummarizeWorker] Supabase admin:', e?.message || e);
    process.exit(1);
  }

  const sweepMs = novaSummarizeSweepIntervalSec() * 1000;
  console.log(
    `[novaSummarizeWorker] listening on ${NOVA_SUMMARIZE_QUEUE_KEY}; sweep every ${sweepMs / 1000}s`
  );

  setInterval(async () => {
    try {
      const n = await sweepNovaSummarizeDueSet(redis);
      if (n > 0) {
        console.log(`[novaSummarizeWorker] sweep re-queued ${n} job(s)`);
      }
    } catch (err) {
      console.error('[novaSummarizeWorker] sweep failed:', err?.message || err);
    }
  }, sweepMs);

  try {
    const n0 = await sweepNovaSummarizeDueSet(redis);
    if (n0 > 0) {
      console.log(`[novaSummarizeWorker] startup sweep re-queued ${n0} job(s)`);
    }
  } catch (err) {
    console.error('[novaSummarizeWorker] startup sweep failed:', err?.message || err);
  }

  const blockSec = (() => {
    const raw = process.env.NOVA_SUMMARIZE_QUEUE_BLOCK_SEC;
    const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= 120) return n;
    return 10;
  })();

  for (;;) {
    let raw;
    try {
      raw = await blockingPopSummarizeJob(redis, blockSec);
    } catch (err) {
      console.error('[novaSummarizeWorker] BRPOP failed:', err?.message || err);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (raw == null) continue;

    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      console.warn('[novaSummarizeWorker] invalid job JSON, skipping');
      continue;
    }
    if (!job?.userId || !job?.chatId) {
      console.warn('[novaSummarizeWorker] job missing userId/chatId, skipping');
      continue;
    }

    try {
      const result = await processNovaSummarizeJob(redis, admin, job);
      if (result === 'failed') {
        console.warn('[novaSummarizeWorker] job failed (will retry on sweep):', job);
      }
    } catch (err) {
      console.error('[novaSummarizeWorker] job error:', err?.message || err);
    }
  }
}

main().catch((err) => {
  console.error('[novaSummarizeWorker] fatal:', err);
  process.exit(1);
});
