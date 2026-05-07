/**
 * Nova AI hot-session payload in Redis (see docs/NOVA_AI_ARCHITECTURE.md).
 * Keys are scoped per Supabase user id so one user cannot read another's cache by chat id alone.
 */

/** @typedef {{ role: 'user' | 'assistant' | 'system', content: string }} NovaChatMessage */

/**
 * @typedef {object} NovaChatSession
 * @property {string} chat_id
 * @property {NovaChatMessage[]} messages
 * @property {string} summary
 * @property {number} last_active - unix seconds
 * @property {number} token_estimate
 */

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {string}
 */
export function novaSessionRedisKey(userId, chatId) {
  return `nova:chat:${userId}:${chatId}`;
}

/**
 * @param {string} chatId
 * @returns {NovaChatSession}
 */
export function createEmptyNovaSession(chatId) {
  return {
    chat_id: chatId,
    messages: [],
    summary: '',
    last_active: Math.floor(Date.now() / 1000),
    token_estimate: 0,
  };
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<NovaChatSession | null>}
 */
export async function novaSessionGet(redis, userId, chatId) {
  const raw = await redis.get(novaSessionRedisKey(userId, chatId));
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {NovaChatSession} session
 * @param {number} ttlSec
 */
export async function novaSessionSave(redis, userId, session, ttlSec) {
  session.last_active = Math.floor(Date.now() / 1000);
  await redis.set(novaSessionRedisKey(userId, session.chat_id), JSON.stringify(session), {
    EX: ttlSec,
  });
}

/**
 * @returns {number}
 */
export function novaSessionTtlSeconds() {
  const raw = process.env.NOVA_REDIS_SESSION_TTL_SEC;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 60 && n <= 86400) return n;
  return 3600;
}
