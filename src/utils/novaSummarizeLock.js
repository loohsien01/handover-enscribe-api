/**
 * Worker-only lock: one summarization run per chat at a time.
 */
import { randomUUID } from 'crypto';

export function novaSummarizeExecutionLockKey(userId, chatId) {
  return `nova:summarize-exec-lock:${userId}:${chatId}`;
}

export function novaSummarizeLockTtlSec() {
  const raw = process.env.NOVA_SUMMARIZE_LOCK_TTL_SEC;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 60 && n <= 3600) return n;
  return 600;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<string | null>}
 */
export async function acquireNovaSummarizeLock(redis, userId, chatId) {
  const token = randomUUID();
  const ok = await redis.set(novaSummarizeExecutionLockKey(userId, chatId), token, {
    NX: true,
    EX: novaSummarizeLockTtlSec(),
  });
  return ok ? token : null;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 * @param {string} token
 */
export async function releaseNovaSummarizeLock(redis, userId, chatId, token) {
  const key = novaSummarizeExecutionLockKey(userId, chatId);
  try {
    const current = await redis.get(key);
    if (current === token) {
      await redis.del(key);
    }
  } catch (err) {
    console.warn('[novaSummarizeLock] release failed:', err?.message || err);
  }
}
