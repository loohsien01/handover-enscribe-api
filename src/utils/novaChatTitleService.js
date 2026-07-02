/**
 * Fire-and-forget Nova chat session title generation (Haiku, after first successful completion).
 */
import { getSupabaseClient } from './supabase.js';
import { getRedisClient } from './redisClient.js';
import { claudeInvokeModel } from './bedrockClient.js';
import { getNovaChatTitleRequestBody } from './claudeRequestBody.js';
import {
  NOVA_CHAT_DEFAULT_TITLE,
  novaChatTitleModelId,
  pickFirstTurnForNovaChatTitle,
  postProcessAiNovaChatTitle,
  truncateNovaChatTitlePromptText,
} from './novaChatTitle.js';
import {
  loadNovaChatSessionFromSupabase,
  persistNovaChatSession,
  countNovaCompletionJobsByStatus,
  loadChatSessionTitle,
} from './novaChatPersistence.js';
import {
  normalizeNovaSessionShape,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from './novaRedisSession.js';
import * as userSecurityConfigController from '../fastify/controllers/userSecurityConfigController.js';

/**
 * @param {string} userMessage
 * @param {string} assistantMessage
 * @param {(reqBody: object) => Promise<{ text?: string }>} [invokeModel]
 * @returns {Promise<string | null>}
 */
export async function generateNovaChatTitleWithModel(
  userMessage,
  assistantMessage,
  invokeModel = claudeInvokeModel
) {
  const modelId = novaChatTitleModelId();
  const reqBody = getNovaChatTitleRequestBody({
    modelId,
    userMessage: truncateNovaChatTitlePromptText(userMessage),
    assistantMessage: truncateNovaChatTitlePromptText(assistantMessage),
  });
  const inv = await invokeModel(reqBody);
  const processed = postProcessAiNovaChatTitle(inv.text ?? '');
  if (!processed || processed === NOVA_CHAT_DEFAULT_TITLE) {
    return null;
  }
  return processed;
}

/**
 * After the first successful completion, generate a sidebar title when still default.
 * Fail open — logs errors, never throws to caller.
 *
 * @param {{ userId: string, chatId: string, authorizationHeader: string }} args
 */
export async function maybeRunNovaChatTitleAfterFirstCompletion(args) {
  const { userId, chatId, authorizationHeader } = args;
  const supabase = getSupabaseClient(authorizationHeader);

  const completeCount = await countNovaCompletionJobsByStatus(userId, chatId, 'complete');
  if (completeCount !== 1) {
    return;
  }

  const title = await loadChatSessionTitle(userId, chatId);
  if (!title) {
    return;
  }
  if (title !== NOVA_CHAT_DEFAULT_TITLE) {
    return;
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, userId);
  if (!keyResult.success) {
    console.error('[novaChatTitle] master key:', keyResult.error);
    return;
  }
  const masterKey = keyResult.masterKey;

  const redis = await getRedisClient();
  /** @type {import('./novaRedisSession.js').NovaChatSession | null} */
  let session = redis ? await novaSessionGet(redis, userId, chatId) : null;
  if (!session) {
    const loaded = await loadNovaChatSessionFromSupabase(supabase, userId, chatId, masterKey);
    session = loaded?.session ?? null;
  }
  if (!session) {
    console.error('[novaChatTitle] session not found for title generation');
    return;
  }
  normalizeNovaSessionShape(session);

  const { userMessage, assistantMessage } = pickFirstTurnForNovaChatTitle(session.messages);
  if (!userMessage || !assistantMessage) {
    return;
  }

  let generated;
  try {
    generated = await generateNovaChatTitleWithModel(userMessage, assistantMessage);
  } catch (err) {
    console.error('[novaChatTitle] Bedrock invoke failed:', err);
    return;
  }
  if (!generated) {
    return;
  }

  const freshTitle = await loadChatSessionTitle(userId, chatId);
  if (!freshTitle || freshTitle !== NOVA_CHAT_DEFAULT_TITLE) {
    return;
  }

  session.title = generated;
  const persistResult = await persistNovaChatSession(supabase, {
    chatId,
    userId,
    session,
    masterKey,
    messageSync: 'none',
  });
  if (!persistResult.success) {
    console.error('[novaChatTitle] persist failed:', persistResult.error);
    return;
  }

  if (redis) {
    const ttl = novaSessionTtlSeconds();
    await novaSessionSave(redis, userId, session, ttl);
  }
}
