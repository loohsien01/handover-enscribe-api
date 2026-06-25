import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../../utils/supabase.js';
import { getRedisClient } from '../../utils/redisClient.js';
import {
  createEmptyNovaSession,
  normalizeNovaSessionShape,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from '../../utils/novaRedisSession.js';
import {
  insertChatSessionRow,
  listChatSessionsForUser,
  loadNovaChatSessionFromSupabase,
  persistNovaChatSession,
  insertChatTokenUsageRow,
  novaChatCompletionJobsTable,
} from '../../utils/novaChatPersistence.js';
import { ensurePersonalOrganization } from '../../services/personalOrganization.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';
import { resolveNovaBedrockModelId } from '../../utils/bedrockClaudeModels.js';
import { novaChatCompletionProcessor } from '../processors/novaChatCompletionProcessor.js';
import { enrichNovaCompletionPollWithPartial } from '../../utils/novaCompletionPartial.js';
import { enrichNovaCompletionPollWithVisitPrepTitleDetails } from '../../utils/novaVisitPrepTitleDetailsCache.js';
import { NOVA_CHAT_DEFAULT_TITLE, normalizeNovaChatTitle } from '../../utils/novaChatTitle.js';
import {
  USAGE_METRICS,
  UsageLimitExceededError,
  assertUsageAllowedForUser,
} from '../../utils/billingUsage.js';
import { loadVisitPrepForPoll } from './visitPrepsController.js';

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
  const body = request.body ?? {};
  const sessionTitle = body.title != null ? normalizeNovaChatTitle(body.title) : NOVA_CHAT_DEFAULT_TITLE;

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
    title: sessionTitle,
  });
  if (!insertResult.success) {
    return reply.status(500).send({
      error: insertResult.error || 'Failed to persist chat session',
      code: 'NOVA_SESSION_PERSIST_FAILED',
    });
  }

  const session = createEmptyNovaSession(chatId, sessionTitle);
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
  if (body.title !== undefined) session.title = normalizeNovaChatTitle(body.title);
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
 * @param {import('redis').RedisClientType} redis
 * @param {{ id: string, status: string, error_code?: string | null }} job
 * @param {Record<string, unknown>} payload
 */
async function enrichNovaCompletionPollPayload(redis, job, payload) {
  let out = await enrichNovaCompletionPollWithPartial(redis, job, payload);
  out = await enrichNovaCompletionPollWithVisitPrepTitleDetails(redis, job, out);
  return out;
}

/**
 * Build JSON for GET …/completion-jobs/:jobId and for POST idempotent replay (200) when the job
 * already completed for the same `client_message_id`.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('redis').RedisClientType} redis
 * @param {string} userId
 * @param {string} chatId
 * @param {Buffer} masterKey
 * @param {{ id: string, status: string, usage?: object | null, visit_prep_id?: string | null, error_code?: string | null, error_message?: string | null }} job
 */
async function buildNovaCompletionPollPayload(request, redis, userId, chatId, masterKey, job) {
  if (job.status === 'pending' || job.status === 'running') {
    return enrichNovaCompletionPollWithPartial(redis, job, {
      id: job.id,
      status: job.status,
      chat_id: chatId,
    });
  }
  if (job.status === 'failed') {
    if (job.error_code === 'VISIT_PREP_PERSIST_FAILED') {
      const session = await loadSessionRedisThenSupabase(redis, request, userId, chatId, masterKey);
      const last = session?.messages?.[session.messages.length - 1];
      const assistantContent = last?.role === 'assistant' ? last.content : '';
      return enrichNovaCompletionPollPayload(redis, job, {
        id: job.id,
        status: 'failed',
        chat_id: chatId,
        code: job.error_code,
        error: job.error_message || 'Failed to persist visit prep',
        assistant: { role: 'assistant', content: assistantContent },
        usage: job.usage ?? null,
        session: session ?? null,
        visit_prep_id: null,
      });
    }

    return enrichNovaCompletionPollWithPartial(redis, job, {
      id: job.id,
      status: 'failed',
      chat_id: chatId,
      code: job.error_code || 'NOVA_COMPLETION_FAILED',
      error: job.error_message || 'Completion failed',
    });
  }
  const session = await loadSessionRedisThenSupabase(redis, request, userId, chatId, masterKey);
  if (!session) {
    return enrichNovaCompletionPollWithVisitPrepTitleDetails(redis, job, {
      id: job.id,
      status: 'complete',
      chat_id: chatId,
      assistant: { role: 'assistant', content: '' },
      usage: job.usage ?? null,
      session: null,
      code: 'NOVA_SESSION_NOT_FOUND',
      error: 'Session could not be loaded after completion',
    });
  }
  const last = session.messages?.[session.messages.length - 1];
  const assistantContent = last?.role === 'assistant' ? last.content : '';

  /** @type {Record<string, unknown>} */
  const payload = {
    id: job.id,
    status: 'complete',
    chat_id: chatId,
    assistant: { role: 'assistant', content: assistantContent },
    usage: job.usage ?? null,
    session,
  };

  if (job.visit_prep_id) {
    const supabase = getSupabaseClient(request.headers.authorization);
    const visitPrep = await loadVisitPrepForPoll(supabase, userId, job.visit_prep_id, masterKey);
    payload.visit_prep_id = job.visit_prep_id;
    if (visitPrep) {
      payload.visit_prep = visitPrep;
    }
  }

  return enrichNovaCompletionPollWithVisitPrepTitleDetails(redis, job, payload);
}

/**
 * POST /api/nova/chat-sessions/:chatId/completions
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {{ saveVisitPrep?: boolean }} [completionOptions]
 */
export async function postNovaChatCompletion(request, reply, completionOptions = {}) {
  const { saveVisitPrep = false } = completionOptions;
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId } = request.params;
  const body = request.body;

  const modelId = resolveNovaBedrockModelId(body.model);
  if (!modelId) {
    return reply.status(400).send({ error: 'Invalid model', code: 'NOVA_MODEL_INVALID' });
  }

  const supabase = getSupabaseClient(request.headers.authorization);

  const { data: sessionExists, error: sessionCheckErr } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();

  if (sessionCheckErr || !sessionExists) {
    return reply.status(404).send({
      error: 'Chat session not found or expired',
      code: 'NOVA_SESSION_NOT_FOUND',
    });
  }

  const { data: doneJob } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id, status, usage, visit_prep_id, error_code, error_message')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .eq('client_message_id', body.client_message_id)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (doneJob) {
    const masterKey = await userMasterKeyOr500(request, reply);
    if (!masterKey) return;
    const payload = await buildNovaCompletionPollPayload(request, redis, userId, chatId, masterKey, doneJob);
    return reply.status(200).send(payload);
  }

  const { data: activeJob } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id, client_message_id, status')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .in('status', ['pending', 'running'])
    .maybeSingle();

  if (activeJob) {
    if (activeJob.client_message_id === body.client_message_id) {
      return reply.status(202).send({
        id: activeJob.id,
        status: activeJob.status,
        chat_id: chatId,
      });
    }
    return reply.status(409).send({
      error: 'Another completion is in progress for this chat',
      code: 'NOVA_COMPLETION_IN_FLIGHT',
    });
  }

  const { data: latestFailedForClientId } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .eq('client_message_id', body.client_message_id)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const hasFailedRetry = Boolean(latestFailedForClientId?.id);

  try {
    await assertUsageAllowedForUser(userId, USAGE_METRICS.NOVA_RESPONSE);
  } catch (err) {
    if (err instanceof UsageLimitExceededError) {
      return reply.status(402).send(err.toJSON());
    }
    throw err;
  }

  const { data: newJob, error: insErr } = await supabase
    .from(novaChatCompletionJobsTable)
    .insert({
      user_id: userId,
      chat_id: chatId,
      client_message_id: body.client_message_id,
      model: body.model,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insErr) {
    if (insErr.code === '23503') {
      return reply.status(404).send({
        error: 'Chat session not found or expired',
        code: 'NOVA_SESSION_NOT_FOUND',
      });
    }
    if (insErr.code === '23505') {
      const { data: again } = await supabase
        .from(novaChatCompletionJobsTable)
        .select('id, client_message_id, status')
        .eq('chat_id', chatId)
        .eq('user_id', userId)
        .in('status', ['pending', 'running'])
        .maybeSingle();
      if (again?.client_message_id === body.client_message_id) {
        return reply.status(202).send({ id: again.id, status: again.status, chat_id: chatId });
      }
      return reply.status(409).send({
        error: 'Another completion is in progress for this chat',
        code: 'NOVA_COMPLETION_IN_FLIGHT',
      });
    }
    console.error('[postNovaChatCompletion] insert job:', insErr);
    return reply.status(500).send({ error: 'Failed to create completion job' });
  }

  const masterKey = await userMasterKeyOr500(request, reply);
  if (!masterKey) {
    await supabase.from(novaChatCompletionJobsTable).delete().eq('id', newJob.id).eq('user_id', userId);
    return;
  }

  let session = await loadSessionRedisThenSupabase(redis, request, userId, chatId, masterKey);
  if (!session) {
    await supabase.from(novaChatCompletionJobsTable).delete().eq('id', newJob.id).eq('user_id', userId);
    return reply.status(404).send({ error: 'Chat session not found or expired', code: 'NOVA_SESSION_NOT_FOUND' });
  }

  normalizeNovaSessionShape(session);
  const msgs = session.messages || [];
  const last = msgs[msgs.length - 1];

  let skipUserAppend = false;
  if (hasFailedRetry) {
    if (last?.role === 'user' && last.content === body.message) {
      skipUserAppend = true;
    } else if (last?.role === 'user') {
      await supabase.from(novaChatCompletionJobsTable).delete().eq('id', newJob.id).eq('user_id', userId);
      return reply.status(400).send({
        error: 'client_message_id retry requires the same message as the pending user turn',
        code: 'NOVA_CLIENT_MESSAGE_MISMATCH',
      });
    } else {
      await supabase.from(novaChatCompletionJobsTable).delete().eq('id', newJob.id).eq('user_id', userId);
      return reply.status(400).send({
        error:
          'Cannot retry this client_message_id: session does not end with the expected user message. Reload the thread or use a new client_message_id.',
        code: 'NOVA_COMPLETION_RETRY_INVALID_STATE',
      });
    }
  }

  if (!skipUserAppend) {
    const userAppend = [{ role: 'user', content: body.message }];
    session.messages = [...msgs, ...userAppend];

    const persistResult = await persistNovaChatSession(supabase, {
      chatId,
      userId,
      session,
      masterKey,
      messageSync: 'append',
      appendedMessages: userAppend,
    });

    if (!persistResult.success) {
      await supabase.from(novaChatCompletionJobsTable).delete().eq('id', newJob.id).eq('user_id', userId);
      return reply.status(500).send({
        error: persistResult.error || 'Failed to persist chat session',
        code: 'NOVA_SESSION_PERSIST_FAILED',
      });
    }
  }

  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, session, ttl);

  const authHeader = request.headers.authorization;
  const extractTitleDetails = saveVisitPrep && body.extract_title_details !== false;
  const processorOptions = saveVisitPrep ? { saveVisitPrep: true, extractTitleDetails } : {};
  setImmediate(() => {
    novaChatCompletionProcessor(newJob.id, userId, chatId, authHeader, processorOptions).catch((err) => {
      console.error(`[novaChatCompletionProcessor] Unhandled error for job ${newJob.id}:`, err);
    });
  });

  return reply.status(202).send({
    id: newJob.id,
    status: 'pending',
    chat_id: chatId,
  });
}

/**
 * POST /api/nova/chat-sessions/:chatId/completions-and-save-visit-prep
 */
export async function postNovaChatCompletionAndSaveVisitPrep(request, reply) {
  return postNovaChatCompletion(request, reply, { saveVisitPrep: true });
}

/**
 * GET /api/nova/chat-sessions/:chatId/completion-jobs/:jobId
 */
export async function getNovaChatCompletionJob(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId, jobId } = request.params;
  const supabase = getSupabaseClient(request.headers.authorization);

  const { data: job, error } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id, chat_id, status, usage, visit_prep_id, error_code, error_message')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !job || job.chat_id !== chatId) {
    return reply.status(404).send({
      error: 'Job not found',
      code: 'NOVA_COMPLETION_JOB_NOT_FOUND',
    });
  }

  const masterKey = await userMasterKeyOr500(request, reply);
  if (!masterKey) return;

  const payload = await buildNovaCompletionPollPayload(request, redis, userId, chatId, masterKey, job);
  return reply.send(payload);
}

/**
 * GET /api/nova/chat-sessions/:chatId/completion-jobs/:jobId/visit-prep
 */
export async function getNovaChatCompletionJobVisitPrep(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId, jobId } = request.params;
  const supabase = getSupabaseClient(request.headers.authorization);

  const { data: job, error } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id, chat_id, visit_prep_id')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !job || job.chat_id !== chatId) {
    return reply.status(404).send({
      error: 'Job not found',
      code: 'NOVA_COMPLETION_JOB_NOT_FOUND',
    });
  }

  if (!job.visit_prep_id) {
    return reply.status(404).send({
      error: 'No visit prep saved for this job',
      code: 'VISIT_PREP_NOT_FOUND',
    });
  }

  const masterKey = await userMasterKeyOr500(request, reply);
  if (!masterKey) return;

  const visitPrep = await loadVisitPrepForPoll(supabase, userId, job.visit_prep_id, masterKey);
  if (!visitPrep) {
    return reply.status(404).send({
      error: 'Visit prep not found',
      code: 'VISIT_PREP_NOT_FOUND',
    });
  }

  return reply.send(visitPrep);
}
