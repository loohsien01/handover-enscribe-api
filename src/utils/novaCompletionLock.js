/**
 * Per-chat exclusive lock for `POST .../completions` (409 when another request holds it).
 */
import { randomUUID } from 'crypto';

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {string}
 */
export function novaCompletionLockKey(userId, chatId) {
  return `nova:completion-lock:${userId}:${chatId}`;
}

/**
 * @returns {number} TTL seconds
 */
export function novaCompletionLockTtlSec() {
  const raw = process.env.NOVA_COMPLETION_LOCK_TTL_SEC;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 30 && n <= 900) return n;
  return 300;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<string | null>} lock token if acquired, else null
 */
export async function acquireNovaCompletionLock(redis, userId, chatId) {
  const key = novaCompletionLockKey(userId, chatId);
  const token = randomUUID();
  const ok = await redis.set(key, token, { NX: true, EX: novaCompletionLockTtlSec() });
  return ok ? token : null;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 * @param {string} token
 */
export async function releaseNovaCompletionLock(redis, userId, chatId, token) {
  const key = novaCompletionLockKey(userId, chatId);
  try {
    const current = await redis.get(key);
    if (current === token) {
      await redis.del(key);
    }
  } catch (err) {
    console.warn('[novaCompletionLock] release failed:', err?.message || err);
  }
}
