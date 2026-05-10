/**
 * Rolling summarization for Nova (worker + threshold enqueue from API).
 */
import { claudeInvokeModel } from './bedrockClient.js';
import {
  novaCompletionContextUsageRatio,
  novaSummarizeContextThreshold,
  resolveNovaBedrockModelId,
} from './bedrockClaudeModels.js';
import { getNovaSummarizeDeltaRequestBody } from './claudeRequestBody.js';
import {
  loadNovaChatSessionFromSupabase,
  persistNovaChatSession,
} from './novaChatPersistence.js';
import {
  normalizeNovaSessionShape,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from './novaRedisSession.js';
import { acquireNovaSummarizeLock, releaseNovaSummarizeLock } from './novaSummarizeLock.js';
import { clearNovaSummarizeDue } from './novaSummarizeQueue.js';
import * as userSecurityConfigController from '../fastify/controllers/userSecurityConfigController.js';

/**
 * @returns {number}
 */
export function novaSummarizeInputMaxChars() {
  const raw = process.env.NOVA_SUMMARIZE_INPUT_MAX_CHARS;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 4096 && n <= 2_000_000) return n;
  return 20_000;
}

/**
 * @returns {number}
 */
export function novaSummarizeRollingMaxChars() {
  const raw = process.env.NOVA_SUMMARIZE_ROLLING_MAX_CHARS;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 2000 && n <= 2_000_000) return n;
  return 10_000;
}

/**
 * @param {import('./novaRedisSession.js').NovaChatSession} session
 * @param {{ input_tokens?: number, output_tokens?: number } | null | undefined} usage
 * @param {'haiku' | 'sonnet' | 'opus'} modelPreset
 */
export function shouldEnqueueNovaSummarize(session, usage, modelPreset) {
  normalizeNovaSessionShape(session);
  if (session.summarize_pending) return false;
  const ratio = novaCompletionContextUsageRatio(usage, modelPreset);
  return ratio >= novaSummarizeContextThreshold();
}

/**
 * Whole messages only until char budget; if none fit, truncate the first message content.
 * @param {Array<{ role: string, content: string }>} messages
 * @param {number} maxChars
 */
export function pickMessagesForSummarize(messages, maxChars) {
  let total = 0;
  const out = [];
  for (const m of messages) {
    const piece = `${m.role}: ${m.content}\n\n`;
    if (total + piece.length <= maxChars) {
      out.push(m);
      total += piece.length;
      continue;
    }
    if (out.length === 0 && m.content) {
      const budget = Math.max(256, maxChars - 48);
      out.push({
        role: m.role,
        content: m.content.slice(0, budget) + (m.content.length > budget ? '\n…' : ''),
      });
    }
    break;
  }
  return out;
}

/**
 * @param {string} previousSummary
 * @param {string} deltaSummaryText
 * @param {number} maxChars
 */
export function mergeNovaRollingSummary(previousSummary, deltaSummaryText, maxChars) {
  const prev = (previousSummary || '').trim();
  const delta = (deltaSummaryText || '').trim();
  if (!delta) return prev;
  let out = prev ? `${prev}\n\n---\n\n${delta}` : delta;
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
  }
  return out;
}

function summarizeModelId() {
  const fromEnv = process.env.NOVA_SUMMARIZE_BEDROCK_MODEL_ID;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return resolveNovaBedrockModelId('sonnet');
}

/**
 * Runs one rolling-summarize pass on an in-memory session: delta since `summary_covered_message_count`,
 * model call, merge into `session.summary`, advance checkpoint, clear `summarize_pending`.
 *
 * @param {import('./novaRedisSession.js').NovaChatSession} session - mutated in place
 * @param {(reqBody: object) => Promise<{ text?: string }>} [invokeModel] - defaults to {@link claudeInvokeModel}
 * @returns {Promise<{ ok: true, didSummarize: boolean } | { ok: false, error: string }>}
 */
export async function applyNovaSummarizeDeltaWithModel(session, invokeModel = claudeInvokeModel) {
  normalizeNovaSessionShape(session);
  const messages = session.messages || [];
  const covered = session.summary_covered_message_count ?? 0;
  const delta = messages.slice(covered);

  if (delta.length === 0) {
    session.summarize_pending = false;
    return { ok: true, didSummarize: false };
  }

  const cap = novaSummarizeInputMaxChars();
  const toSummarize = pickMessagesForSummarize(delta, cap);
  if (toSummarize.length === 0) {
    session.summarize_pending = false;
    return { ok: true, didSummarize: false };
  }

  const reqBody = getNovaSummarizeDeltaRequestBody({
    modelId: summarizeModelId(),
    deltaMessages: toSummarize,
    max_tokens: 4096,
  });

  const inv = await invokeModel(reqBody);
  const deltaText = (inv.text || '').trim();
  if (!deltaText) {
    return { ok: false, error: 'empty_model_output' };
  }

  const rollingMax = novaSummarizeRollingMaxChars();
  session.summary = mergeNovaRollingSummary(session.summary ?? '', deltaText, rollingMax);
  session.summary_covered_message_count = covered + toSummarize.length;
  if (session.summary_covered_message_count > messages.length) {
    session.summary_covered_message_count = messages.length;
  }
  session.summarize_pending = false;
  return { ok: true, didSummarize: true };
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{ userId: string, chatId: string }} job
 * @returns {Promise<'ok' | 'skipped' | 'failed'>}
 */
export async function processNovaSummarizeJob(redis, supabaseAdmin, job) {
  const { userId, chatId } = job;
  const lockToken = await acquireNovaSummarizeLock(redis, userId, chatId);
  if (!lockToken) {
    return 'skipped';
  }

  try {
    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(
      supabaseAdmin,
      userId
    );
    if (!keyResult.success || !keyResult.masterKey) {
      console.error('[processNovaSummarizeJob] master key:', keyResult.error);
      return 'failed';
    }
    const masterKey = keyResult.masterKey;

    let session = await novaSessionGet(redis, userId, chatId);
    if (!session) {
      const loaded = await loadNovaChatSessionFromSupabase(supabaseAdmin, userId, chatId, masterKey);
      if (!loaded) {
        await clearNovaSummarizeDue(redis, userId, chatId);
        return 'skipped';
      }
      session = loaded.session;
      const ttl = novaSessionTtlSeconds();
      await novaSessionSave(redis, userId, session, ttl);
    }

    normalizeNovaSessionShape(session);

    let summarizeResult;
    try {
      summarizeResult = await applyNovaSummarizeDeltaWithModel(session, claudeInvokeModel);
    } catch (err) {
      console.error('[processNovaSummarizeJob] Bedrock failed:', err?.message || err);
      return 'failed';
    }

    if (!summarizeResult.ok) {
      console.warn('[processNovaSummarizeJob] summarize step failed:', summarizeResult.error);
      return 'failed';
    }

    if (!summarizeResult.didSummarize) {
      const ttl = novaSessionTtlSeconds();
      await novaSessionSave(redis, userId, session, ttl);
      await clearNovaSummarizeDue(redis, userId, chatId);
      return 'ok';
    }

    const persistResult = await persistNovaChatSession(supabaseAdmin, {
      chatId,
      userId,
      session,
      masterKey,
      messageSync: 'none',
      appendedMessages: undefined,
    });
    if (!persistResult.success) {
      console.error('[processNovaSummarizeJob] persist failed:', persistResult.error);
      return 'failed';
    }

    const ttl = novaSessionTtlSeconds();
    await novaSessionSave(redis, userId, session, ttl);
    await clearNovaSummarizeDue(redis, userId, chatId);
    return 'ok';
  } finally {
    releaseNovaSummarizeLock(redis, userId, chatId, lockToken);
  }
}
