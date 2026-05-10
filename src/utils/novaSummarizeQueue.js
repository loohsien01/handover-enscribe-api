/**
 * Redis queue + due-set for Nova rolling summarization (worker drains queue; sweep re-enqueues due).
 */

export const NOVA_SUMMARIZE_QUEUE_KEY = 'nova:summarize:queue';
export const NOVA_SUMMARIZE_DUE_SET_KEY = 'nova:summarize:due';

/**
 * @returns {number}
 */
export function novaSummarizeSweepIntervalSec() {
  const raw = process.env.NOVA_SUMMARIZE_SWEEP_INTERVAL_SEC;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 15 && n <= 3600) return n;
  return 120;
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {string}
 */
export function novaSummarizeDueMember(userId, chatId) {
  return `${userId}:${chatId}`;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {{ userId: string, chatId: string }} job
 */
export async function enqueueNovaSummarizeJob(redis, job) {
  const member = novaSummarizeDueMember(job.userId, job.chatId);
  await redis.sAdd(NOVA_SUMMARIZE_DUE_SET_KEY, member);
  await redis.lPush(NOVA_SUMMARIZE_QUEUE_KEY, JSON.stringify({ userId: job.userId, chatId: job.chatId }));
}

/**
 * Re-queue jobs for all members in the due-set (sweep). Safe if queue already has duplicates.
 * @param {import('redis').RedisClientType} redis
 * @param {number} [batchLimit=500]
 */
export async function sweepNovaSummarizeDueSet(redis, batchLimit = 500) {
  const members = await redis.sMembers(NOVA_SUMMARIZE_DUE_SET_KEY);
  let n = 0;
  for (const m of members) {
    const idx = m.indexOf(':');
    if (idx <= 0) continue;
    const userId = m.slice(0, idx);
    const chatId = m.slice(idx + 1);
    if (!userId || !chatId) continue;
    await redis.lPush(NOVA_SUMMARIZE_QUEUE_KEY, JSON.stringify({ userId, chatId }));
    n += 1;
    if (n >= batchLimit) break;
  }
  return n;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 */
export async function clearNovaSummarizeDue(redis, userId, chatId) {
  await redis.sRem(NOVA_SUMMARIZE_DUE_SET_KEY, novaSummarizeDueMember(userId, chatId));
}
