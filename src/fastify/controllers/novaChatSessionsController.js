import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../../utils/supabase.js';
import { getRedisClient } from '../../utils/redisClient.js';
import {
  acquireNovaCompletionLock,
  releaseNovaCompletionLock,
} from '../../utils/novaCompletionLock.js';
import {
  createEmptyNovaSession,
  normalizeNovaSessionShape,
  novaPriorDialogMessagesForBedrock,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from '../../utils/novaRedisSession.js';
import { enqueueNovaSummarizeJob } from '../../utils/novaSummarizeQueue.js';
import { shouldEnqueueNovaSummarize } from '../../utils/novaSummarizeService.js';
import {
  insertChatSessionRow,
  listChatSessionsForUser,
  loadNovaChatSessionFromSupabase,
  persistNovaChatSession,
  insertChatTokenUsageRow,
} from '../../utils/novaChatPersistence.js';
import { ensurePersonalOrganization } from '../../services/personalOrganization.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';
import { getNovaChatCompletionRequestBody } from '../../utils/claudeRequestBody.js';
import { claudeInvokeModel } from '../../utils/bedrockClient.js';
import { resolveNovaBedrockModelId } from '../../utils/bedrockClaudeModels.js';

async function redisOr503(reply) {
  const redis = await getRedisClient();
  if (!redis) {
    reply.status(503).send({
      error: 'Redis is not configured',
      code: 'REDIS_UNAVAILABLE',
      detail: 'Set REDIS_URL in the environment to use Nova chat sessions.',
    });
    return null;
  }
  return redis;
}

/**
 * @param {import('fastify').FastifyRequest} request
 * @returns {Promise<Buffer | null>}
 */
async function userMasterKeyOr500(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(
    supabase,
    request.user.id
  );
  if (!keyResult.success) {
    reply.status(500).send({ error: keyResult.error || 'Failed to resolve encryption key' });
    return null;
  }
  return keyResult.masterKey;
}

/**
 * @param {import('redis').RedisClientType} redis
 * @param {import('fastify').FastifyRequest} request
 * @param {string} userId
 * @param {string} chatId
 * @param {Buffer} masterKey
 */
async function loadSessionRedisThenSupabase(redis, request, userId, chatId, masterKey) {
  const cached = await novaSessionGet(redis, userId, chatId);
  if (cached) {
    return cached;
  }
  const supabase = getSupabaseClient(request.headers.authorization);
  const loaded = await loadNovaChatSessionFromSupabase(supabase, userId, chatId, masterKey);
  if (!loaded) {
    return null;
  }
  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, loaded.session, ttl);
  return loaded.session;
}

/**
 * POST /api/nova/chat-sessions
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function createNovaChatSession(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const supabase = getSupabaseClient(request.headers.authorization);
  const userId = request.user.id;
  const chatId = randomUUID();

  let organizationId;
  try {
    const org = await ensurePersonalOrganization(userId);
    organizationId = org.organizationId;
  } catch (err) {
    console.error('[createNovaChatSession] ensurePersonalOrganization:', err);
    return reply.status(500).send({ error: 'Failed to resolve organization for chat session' });
  }

  const insertResult = await insertChatSessionRow(supabase, {
    chatId,
    userId,
    organizationId,
  });
  if (!insertResult.success) {
    return reply.status(500).send({
      error: insertResult.error || 'Failed to persist chat session',
      code: 'NOVA_SESSION_PERSIST_FAILED',
    });
  }

  const session = createEmptyNovaSession(chatId);
  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, session, ttl);

  return reply.status(201).send({ chatId, session });
}

/**
 * GET /api/nova/chat-sessions
 * Paginated session metadata from Supabase (no Redis required).
 */
export async function listNovaChatSessions(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const userId = request.user.id;
  const q = request.query;

  const result = await listChatSessionsForUser(supabase, userId, {
    limit: q.limit,
    offset: q.offset,
    sortBy: q.sortBy,
    order: q.order,
  });

  if (!result.success) {
    return reply.status(500).send({
      error: result.error || 'Failed to list chat sessions',
      code: 'NOVA_SESSION_LIST_FAILED',
    });
  }

  return reply.send({
    sessions: result.sessions,
    total: result.total,
    limit: q.limit,
    offset: q.offset,
  });
}

/**
 * GET /api/nova/chat-sessions/:chatId
 */
export async function getNovaChatSession(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId } = request.params;

  const cached = await novaSessionGet(redis, userId, chatId);
  if (cached) {
    const ttl = novaSessionTtlSeconds();
    await novaSessionSave(redis, userId, cached, ttl);
    return reply.send({ session: cached });
  }

  const masterKey = await userMasterKeyOr500(request, reply);
  if (!masterKey) return;

  const loaded = await loadNovaChatSessionFromSupabase(
    getSupabaseClient(request.headers.authorization),
    userId,
    chatId,
    masterKey
  );
  if (!loaded) {
    return reply.status(404).send({ error: 'Chat session not found or expired', code: 'NOVA_SESSION_NOT_FOUND' });
  }

  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, loaded.session, ttl);

  return reply.send({ session: loaded.session });
}

/**
 * PATCH /api/nova/chat-sessions/:chatId
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function patchNovaChatSession(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId } = request.params;
  const body = request.body;

  const masterKey = await userMasterKeyOr500(request, reply);
  if (!masterKey) return;

  let session = await loadSessionRedisThenSupabase(redis, request, userId, chatId, masterKey);
  if (!session) {
    return reply.status(404).send({ error: 'Chat session not found or expired', code: 'NOVA_SESSION_NOT_FOUND' });
  }

  let messageSync = 'none';
  /** @type {Array<{ role: string, content: string }> | undefined} */
  let appendedPlain;

  if (body.summary !== undefined) session.summary = body.summary;
  if (body.token_estimate !== undefined) session.token_estimate = body.token_estimate;
  if (body.messages !== undefined) {
    session.messages = body.messages;
    messageSync = 'full';
  }
  if (body.appendMessages?.length) {
    appendedPlain = body.appendMessages;
    session.messages = [...session.messages, ...body.appendMessages];
    messageSync = 'append';
  }
  if (messageSync === 'full') {
    session.summary_covered_message_count = 0;
  }

  const supabase = getSupabaseClient(request.headers.authorization);
  const persistResult = await persistNovaChatSession(supabase, {
    chatId,
    userId,
    session,
    masterKey,
    messageSync,
    appendedMessages: appendedPlain,
  });
  if (!persistResult.success) {
    return reply.status(500).send({
      error: persistResult.error || 'Failed to persist chat session',
      code: 'NOVA_SESSION_PERSIST_FAILED',
    });
  }

  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, session, ttl);

  return reply.send({ session });
}

/**
 * POST /api/nova/chat-sessions/:chatId/token-usage
 */
export async function postNovaChatTokenUsage(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const userId = request.user.id;
  const { chatId } = request.params;
  const body = request.body;

  const { data: sess, error } = await supabase
    .from('chat_sessions')
    .select('organization_id')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !sess) {
    return reply.status(404).send({ error: 'Chat session not found', code: 'NOVA_SESSION_NOT_FOUND' });
  }

  const result = await insertChatTokenUsageRow(supabase, {
    chatId,
    userId,
    organizationId: sess.organization_id,
    input_tokens: body.input_tokens,
    output_tokens: body.output_tokens,
    model: body.model,
    cost_usd: body.cost_usd,
  });

  if (!result.success) {
    return reply.status(500).send({
      error: result.error || 'Failed to record token usage',
      code: 'NOVA_TOKEN_USAGE_FAILED',
    });
  }

  return reply.status(201).send({
    ok: true,
    total_tokens: result.total_tokens,
  });
}

/**
 * POST /api/nova/chat-sessions/:chatId/completions
 * One user turn: Bedrock Claude → append user + assistant messages, persist, record token usage.
 */
export async function postNovaChatCompletion(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId } = request.params;
  const body = request.body;

  const modelId = resolveNovaBedrockModelId(body.model);
  if (!modelId) {
    return reply.status(400).send({ error: 'Invalid model', code: 'NOVA_MODEL_INVALID' });
  }

  const masterKey = await userMasterKeyOr500(request, reply);
  if (!masterKey) return;

  const lockToken = await acquireNovaCompletionLock(redis, userId, chatId);
  if (!lockToken) {
    return reply.status(409).send({
      error: 'Another completion is in progress for this chat',
      code: 'NOVA_COMPLETION_IN_FLIGHT',
    });
  }

  try {
    let session = await loadSessionRedisThenSupabase(redis, request, userId, chatId, masterKey);
    if (!session) {
      return reply.status(404).send({ error: 'Chat session not found or expired', code: 'NOVA_SESSION_NOT_FOUND' });
    }

    const supabase = getSupabaseClient(request.headers.authorization);

    const { data: orgRow, error: orgErr } = await supabase
      .from('chat_sessions')
      .select('organization_id')
      .eq('id', chatId)
      .eq('user_id', userId)
      .maybeSingle();

    if (orgErr || !orgRow) {
      return reply.status(404).send({ error: 'Chat session not found', code: 'NOVA_SESSION_NOT_FOUND' });
    }

    normalizeNovaSessionShape(session);
    /** Dialog tail for Bedrock only — full transcript stays in `session.messages`. */
    const dialogTailForBedrock = novaPriorDialogMessagesForBedrock(session);
    const reqBody = getNovaChatCompletionRequestBody({
      modelId,
      summary: session.summary ?? '',
      priorMessages: dialogTailForBedrock,
      userMessage: body.message,
    });

    let inv;
    try {
      inv = await claudeInvokeModel(reqBody);
    } catch (err) {
      console.error('[postNovaChatCompletion] Bedrock invoke failed:', err);
      return reply.status(502).send({
        error: 'Model request failed',
        code: 'NOVA_BEDROCK_FAILED',
        detail: process.env.NODE_ENV !== 'production' ? String(err?.message || err) : undefined,
      });
    }

    const assistantText = inv.text;
    const appendedPlain = [
      { role: 'user', content: body.message },
      { role: 'assistant', content: assistantText },
    ];
    session.messages = [...(session.messages || []), ...appendedPlain];

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
      appendedMessages: appendedPlain,
    });
    if (!persistResult.success) {
      return reply.status(500).send({
        error: persistResult.error || 'Failed to persist chat session',
        code: 'NOVA_SESSION_PERSIST_FAILED',
      });
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
        console.error('[postNovaChatCompletion] token usage insert failed:', tokenResult.error);
      }
    }

    normalizeNovaSessionShape(session);
    /** Non-production only: integration tests enqueue without hitting ~70% context (see `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE`). */
    const testForceSummarizeEnqueue =
      process.env.NODE_ENV !== 'production' &&
      process.env.NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE === '1';
    const thresholdEnqueue = shouldEnqueueNovaSummarize(session, inv.usage, body.model);
    if (!session.summarize_pending && (testForceSummarizeEnqueue || thresholdEnqueue)) {
      session.summarize_pending = true;
      await enqueueNovaSummarizeJob(redis, { userId, chatId });
    }

    const ttl = novaSessionTtlSeconds();
    await novaSessionSave(redis, userId, session, ttl);

    return reply.send({
      assistant: { role: 'assistant', content: assistantText },
      usage: inv.usage
        ? {
            input_tokens: inv.usage.input_tokens,
            output_tokens: inv.usage.output_tokens,
            total_tokens: inv.usage.input_tokens + inv.usage.output_tokens,
            model: inv.modelId,
          }
        : null,
      session,
    });
  } finally {
    await releaseNovaCompletionLock(redis, userId, chatId, lockToken);
  }
}
