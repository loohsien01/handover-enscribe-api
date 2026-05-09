import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../../utils/supabase.js';
import { getRedisClient } from '../../utils/redisClient.js';
import {
  createEmptyNovaSession,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from '../../utils/novaRedisSession.js';
import {
  insertChatSessionRow,
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

  const priorMessages = session.messages || [];
  const reqBody = getNovaChatCompletionRequestBody({
    modelId,
    summary: session.summary ?? '',
    priorMessages,
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
  session.messages = [...priorMessages, ...appendedPlain];

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
}
