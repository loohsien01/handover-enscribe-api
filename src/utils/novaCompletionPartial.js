/**
 * Nova completion partial text in Redis (poll-based pseudo-streaming).
 * @see docs/NOVA_AI_ARCHITECTURE.md — Completion partial streaming
 */

/** Redis TTL for partial keys (30 minutes). */
export const NOVA_COMPLETION_PARTIAL_TTL_SEC = 30 * 60;

/** Debounce interval between partial Redis writes while Bedrock streams. */
export const NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS = 150;

/**
 * @param {string} jobId
 * @returns {string}
 */
export function novaCompletionPartialRedisKey(jobId) {
  return `nova:completion:partial:${jobId}`;
}

/**
 * Partial streaming is enabled unless explicitly disabled (`NOVA_COMPLETION_PARTIAL=0`).
 * @returns {boolean}
 */
export function isNovaCompletionPartialEnabled() {
  return process.env.NOVA_COMPLETION_PARTIAL !== '0';
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} jobId
 * @returns {Promise<{ text: string, revision: number } | null>}
 */
export async function readNovaCompletionPartial(redis, jobId) {
  const raw = await redis.get(novaCompletionPartialRedisKey(jobId));
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text !== 'string' || typeof parsed?.revision !== 'number') {
      return null;
    }
    return { text: parsed.text, revision: parsed.revision };
  } catch {
    return null;
  }
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} jobId
 * @param {string} text
 * @param {number} revision
 */
export async function writeNovaCompletionPartial(redis, jobId, text, revision) {
  await redis.set(
    novaCompletionPartialRedisKey(jobId),
    JSON.stringify({ text, revision }),
    { EX: NOVA_COMPLETION_PARTIAL_TTL_SEC }
  );
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} jobId
 */
export async function deleteNovaCompletionPartial(redis, jobId) {
  await redis.del(novaCompletionPartialRedisKey(jobId));
}

/**
 * Debounced writer for partial assistant text during Bedrock streaming.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} jobId
 * @returns {{ onText: (text: string) => void, flush: (text: string) => Promise<void> }}
 */
export function createNovaCompletionPartialWriter(redis, jobId) {
  let revision = 0;
  let lastWriteAt = 0;
  let pendingText = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const writeNow = async (text) => {
    revision += 1;
    await writeNovaCompletionPartial(redis, jobId, text, revision);
    lastWriteAt = Date.now();
    pendingText = null;
  };

  const scheduleWrite = (text) => {
    pendingText = text;
    const elapsed = Date.now() - lastWriteAt;
    if (lastWriteAt === 0 || elapsed >= NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS) {
      return writeNow(text);
    }
    if (timer) return Promise.resolve();
    return new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        if (pendingText !== null) {
          writeNow(pendingText)
            .catch((err) => {
              console.error(`[novaCompletionPartial] debounced write for job ${jobId}:`, err);
            })
            .finally(resolve);
        } else {
          resolve();
        }
      }, NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS - elapsed);
    });
  };

  return {
    onText(text) {
      if (!text) return;
      scheduleWrite(text).catch((err) => {
        console.error(`[novaCompletionPartial] write for job ${jobId}:`, err);
      });
    },
    async flush(text) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!text) return;
      await writeNow(text);
    },
  };
}

/**
 * Attach `assistant_partial` / `partial_revision` to poll payloads when applicable.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {{ id: string, status: string }} job
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
export async function enrichNovaCompletionPollWithPartial(redis, job, payload) {
  if (!isNovaCompletionPartialEnabled()) {
    return payload;
  }

  if (job.status === 'running') {
    const partial = await readNovaCompletionPartial(redis, job.id);
    if (partial?.text) {
      payload.assistant_partial = partial.text;
      payload.partial_revision = partial.revision;
    }
    return payload;
  }

  if (job.status === 'failed') {
    const partial = await readNovaCompletionPartial(redis, job.id);
    if (partial?.text) {
      payload.assistant_partial = partial.text;
      payload.partial_revision = partial.revision;
    }
    await deleteNovaCompletionPartial(redis, job.id);
    return payload;
  }

  return payload;
}
