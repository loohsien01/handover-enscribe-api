/**
 * Async Nova chat completion (Bedrock) — mirrors prompt-llm: `setImmediate` from the POST handler,
 * runs in-process with the caller's JWT for Supabase RLS + encryption.
 *
 * On failure the **user** message remains in `chat_messages` / session (no rollback); the job row
 * is marked `failed` for polling / retry semantics.
 */

import { getSupabaseClient } from '../../utils/supabase.js';
import { getRedisClient } from '../../utils/redisClient.js';
import {
  normalizeNovaSessionShape,
  novaPriorDialogMessagesForBedrock,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from '../../utils/novaRedisSession.js';
import { enqueueNovaSummarizeJob } from '../../utils/novaSummarizeQueue.js';
import { shouldEnqueueNovaSummarize } from '../../utils/novaSummarizeService.js';
import {
  loadNovaChatSessionFromSupabase,
  persistNovaChatSession,
  insertChatTokenUsageRow,
  novaChatCompletionJobsTable,
} from '../../utils/novaChatPersistence.js';
import * as userSecurityConfigController from '../controllers/userSecurityConfigController.js';
import { getNovaChatCompletionRequestBody } from '../../utils/claudeRequestBody.js';
import { claudeInvokeModel, claudeStreamModel } from '../../utils/bedrockClient.js';
import {
  createNovaCompletionPartialWriter,
  deleteNovaCompletionPartial,
  isNovaCompletionPartialEnabled,
} from '../../utils/novaCompletionPartial.js';
import { resolveNovaBedrockModelId } from '../../utils/bedrockClaudeModels.js';
import {
  USAGE_METRICS,
  UsageLimitExceededError,
  assertUsageAllowed,
  recordUsageSuccess,
  resolveBillingContext,
} from '../../utils/billingUsage.js';
import { maybeRunNovaChatTitleAfterFirstCompletion } from '../../utils/novaChatTitleService.js';
import { createVisitPrep } from '../controllers/visitPrepsController.js';

/**
 * @param {import('redis').RedisClientType} redis
 * @param {string} authorizationHeader
 * @param {string} userId
 * @param {string} chatId
 * @param {Buffer} masterKey
 */
async function loadSessionRedisThenSupabaseForJob(redis, authorizationHeader, userId, chatId, masterKey) {
  const cached = await novaSessionGet(redis, userId, chatId);
  if (cached) {
    return cached;
  }
  const supabase = getSupabaseClient(authorizationHeader);
  const loaded = await loadNovaChatSessionFromSupabase(supabase, userId, chatId, masterKey);
  if (!loaded) {
    return null;
  }
  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, loaded.session, ttl);
  return loaded.session;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} jobId
 * @param {string} userId
 * @param {string} status
 * @param {Record<string, unknown>} [extra]
 */
async function updateJobRow(supabase, jobId, userId, status, extra = {}) {
  const { error } = await supabase
    .from(novaChatCompletionJobsTable)
    .update({
      status,
      ...extra,
    })
    .eq('id', jobId)
    .eq('user_id', userId);

  if (error) {
    console.error(`[novaChatCompletionProcessor] update job ${jobId}:`, error);
  }
}

/**
 * @param {string} jobId
 * @param {string} userId
 * @param {string} chatId
 * @param {string} authorizationHeader - e.g. `Bearer <jwt>`
 * @param {{ saveVisitPrep?: boolean }} [options]
 */
export async function novaChatCompletionProcessor(jobId, userId, chatId, authorizationHeader, options = {}) {
  const { saveVisitPrep = false } = options;
  const supabase = getSupabaseClient(authorizationHeader);

  const { data: claimed, error: claimErr } = await supabase
    .from(novaChatCompletionJobsTable)
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id, model')
    .maybeSingle();

  if (claimErr) {
    console.error(`[novaChatCompletionProcessor] claim job ${jobId}:`, claimErr);
    return;
  }
  if (!claimed?.id) {
    return;
  }

  const redis = await getRedisClient();
  if (!redis) {
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'REDIS_UNAVAILABLE',
      error_message: 'Redis is not configured',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, userId);
  if (!keyResult.success) {
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_MASTER_KEY_FAILED',
      error_message: keyResult.error || 'Failed to resolve encryption key',
      completed_at: new Date().toISOString(),
    });
    return;
  }
  const masterKey = keyResult.masterKey;

  const { data: orgRow, error: orgErr } = await supabase
    .from('chat_sessions')
    .select('organization_id')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();

  if (orgErr || !orgRow) {
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_SESSION_NOT_FOUND',
      error_message: 'Chat session not found',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const billingCtx = await resolveBillingContext(userId);
  try {
    await assertUsageAllowed({
      organizationId: orgRow.organization_id,
      metric: USAGE_METRICS.NOVA_RESPONSE,
      bypassUsageLimits: billingCtx.bypassUsageLimits,
      planKeyForLimits: billingCtx.planKeyForLimits,
    });
  } catch (err) {
    if (err instanceof UsageLimitExceededError) {
      await updateJobRow(supabase, jobId, userId, 'failed', {
        error_code: err.code,
        error_message: err.message,
        completed_at: new Date().toISOString(),
      });
      return;
    }
    throw err;
  }

  let session = await loadSessionRedisThenSupabaseForJob(redis, authorizationHeader, userId, chatId, masterKey);
  if (!session) {
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_SESSION_NOT_FOUND',
      error_message: 'Chat session not found or expired',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  normalizeNovaSessionShape(session);
  const tail = novaPriorDialogMessagesForBedrock(session);
  const lastMsg = tail.length > 0 ? tail[tail.length - 1] : null;
  const priorForBedrock = lastMsg?.role === 'user' ? tail.slice(0, -1) : tail;
  const userMessageForBedrock = lastMsg?.role === 'user' ? lastMsg.content : '';

  if (!userMessageForBedrock || typeof userMessageForBedrock !== 'string') {
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_COMPLETION_INVALID_STATE',
      error_message: 'Expected last session message to be the pending user turn',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const modelId = resolveNovaBedrockModelId(claimed.model);
  if (!modelId) {
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_MODEL_INVALID',
      error_message: 'Invalid model preset on job row',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const reqBody = getNovaChatCompletionRequestBody({
    modelId,
    summary: session.summary ?? '',
    priorMessages: priorForBedrock,
    userMessage: userMessageForBedrock,
  });

  let inv;
  const partialEnabled = isNovaCompletionPartialEnabled();
  const partialWriter = partialEnabled ? createNovaCompletionPartialWriter(redis, jobId) : null;
  try {
    if (partialEnabled) {
      inv = await claudeStreamModel(reqBody, {
        onText: (accumulated) => partialWriter.onText(accumulated),
      });
      await partialWriter.flush(inv.text);
    } else {
      inv = await claudeInvokeModel(reqBody);
    }
  } catch (err) {
    console.error('[novaChatCompletionProcessor] Bedrock invoke failed:', err);
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_BEDROCK_FAILED',
      error_message: process.env.NODE_ENV !== 'production' ? String(err?.message || err) : 'Model request failed',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  const assistantText = inv.text;
  const appendedAssistant = [{ role: 'assistant', content: assistantText }];
  session.messages = [...(session.messages || []), ...appendedAssistant];

  if (inv.usage) {
    const add = inv.usage.input_tokens + inv.usage.output_tokens;
    session.token_estimate = (session.token_estimate ?? 0) + add;
  }

  const persistResult = await persistNovaChatSession(supabase, {
    chatId,
    userId,
    session,
    masterKey,
    messageSync: 'append',
    appendedMessages: appendedAssistant,
  });
  if (!persistResult.success) {
    console.error('[novaChatCompletionProcessor] persist failed:', persistResult.error);
    await updateJobRow(supabase, jobId, userId, 'failed', {
      error_code: 'NOVA_SESSION_PERSIST_FAILED',
      error_message: persistResult.error || 'Failed to persist chat session',
      completed_at: new Date().toISOString(),
    });
    return;
  }

  if (inv.usage) {
    const tokenResult = await insertChatTokenUsageRow(supabase, {
      chatId,
      userId,
      organizationId: orgRow.organization_id,
      input_tokens: inv.usage.input_tokens,
      output_tokens: inv.usage.output_tokens,
      model: inv.modelId,
      cost_usd: undefined,
    });
    if (!tokenResult.success) {
      console.error('[novaChatCompletionProcessor] token usage insert failed:', tokenResult.error);
    }
  }

  normalizeNovaSessionShape(session);
  const testForceSummarizeEnqueue =
    process.env.NODE_ENV !== 'production' && process.env.NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE === '1';
  const thresholdEnqueue = shouldEnqueueNovaSummarize(session, inv.usage, claimed.model);
  if (!session.summarize_pending && (testForceSummarizeEnqueue || thresholdEnqueue)) {
    session.summarize_pending = true;
    await enqueueNovaSummarizeJob(redis, { userId, chatId });
  }

  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, session, ttl);

  const usagePayload = inv.usage
    ? {
        input_tokens: inv.usage.input_tokens,
        output_tokens: inv.usage.output_tokens,
        total_tokens: inv.usage.input_tokens + inv.usage.output_tokens,
        model: inv.modelId,
      }
    : null;

  const recordNovaUsage = () =>
    recordUsageSuccess({
      organizationId: orgRow.organization_id,
      userId,
      metric: USAGE_METRICS.NOVA_RESPONSE,
      idempotencyKey: `nova_response:job:${jobId}`,
      metadata: { chat_id: chatId, job_id: jobId },
      bypassUsageLimits: billingCtx.bypassUsageLimits,
    });

  if (saveVisitPrep) {
    const createResult = await createVisitPrep(supabase, userId, masterKey, {
      text: assistantText,
    });

    if (!createResult.success) {
      console.error('[novaChatCompletionProcessor] createVisitPrep failed:', createResult.error);
      await recordNovaUsage();
      await updateJobRow(supabase, jobId, userId, 'failed', {
        error_code: 'VISIT_PREP_PERSIST_FAILED',
        error_message: createResult.error || 'Failed to persist visit prep',
        usage: usagePayload,
        completed_at: new Date().toISOString(),
      });
      if (partialEnabled) {
        await deleteNovaCompletionPartial(redis, jobId);
      }
      return;
    }

    await recordNovaUsage();
    await updateJobRow(supabase, jobId, userId, 'complete', {
      visit_prep_id: createResult.visitPrep.id,
      usage: usagePayload,
      error_code: null,
      error_message: null,
      completed_at: new Date().toISOString(),
    });

    if (partialEnabled) {
      await deleteNovaCompletionPartial(redis, jobId);
    }

    setImmediate(() => {
      maybeRunNovaChatTitleAfterFirstCompletion({ userId, chatId, authorizationHeader }).catch((err) => {
        console.error(`[novaChatTitle] Unhandled error for chat ${chatId}:`, err);
      });
    });
    return;
  }

  await recordNovaUsage();

  await updateJobRow(supabase, jobId, userId, 'complete', {
    usage: usagePayload,
    error_code: null,
    error_message: null,
    completed_at: new Date().toISOString(),
  });

  if (partialEnabled) {
    await deleteNovaCompletionPartial(redis, jobId);
  }

  setImmediate(() => {
    maybeRunNovaChatTitleAfterFirstCompletion({ userId, chatId, authorizationHeader }).catch((err) => {
      console.error(`[novaChatTitle] Unhandled error for chat ${chatId}:`, err);
    });
  });
}
