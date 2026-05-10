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
 * @property {number} [summary_covered_message_count] - messages[0..count) folded into `summary`
 * @property {boolean} [summarize_pending] - summarization queued or still due
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
    summary_covered_message_count: 0,
    summarize_pending: false,
  };
}

/**
 * Ensure checkpoint / pending flags exist (Redis JSON or older payloads).
 * @param {NovaChatSession | null} session
 * @returns {NovaChatSession | null}
 */
export function normalizeNovaSessionShape(session) {
  if (!session) return null;
  const msgLen = session.messages?.length ?? 0;
  if (typeof session.summary_covered_message_count !== 'number' || session.summary_covered_message_count < 0) {
    const sum = session.summary != null ? String(session.summary).trim() : '';
    session.summary_covered_message_count = sum ? msgLen : 0;
  }
  if (session.summary_covered_message_count > msgLen) {
    session.summary_covered_message_count = msgLen;
  }
  if (typeof session.summarize_pending !== 'boolean') {
    session.summarize_pending = false;
  }
  return session;
}

/**
 * Dialog messages for the next Bedrock completion: `messages.slice(summary_covered_message_count)`.
 * Earlier turns are treated as covered by `session.summary` (rolling memory); avoids duplicating them
 * in the message list alongside the summary block.
 *
 * @param {NovaChatSession} session
 * @returns {NovaChatMessage[]}
 */
export function novaPriorDialogMessagesForBedrock(session) {
  normalizeNovaSessionShape(session);
  const msgs = session.messages || [];
  const n = msgs.length;
  let covered = session.summary_covered_message_count ?? 0;
  if (covered < 0) covered = 0;
  if (covered > n) covered = n;
  return msgs.slice(covered);
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
    return normalizeNovaSessionShape(JSON.parse(raw));
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
