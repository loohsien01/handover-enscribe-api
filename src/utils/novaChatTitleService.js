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
  novaChatCompletionJobsTable,
  persistNovaChatSession,
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

  const { count, error: countErr } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .eq('status', 'complete');

  if (countErr) {
    console.error('[novaChatTitle] count complete jobs:', countErr);
    return;
  }
  if (count !== 1) {
    return;
  }

  const { data: titleRow, error: titleErr } = await supabase
    .from('chat_sessions')
    .select('title')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();

  if (titleErr || !titleRow) {
    if (titleErr) console.error('[novaChatTitle] load title:', titleErr);
    return;
  }
  if (titleRow.title !== NOVA_CHAT_DEFAULT_TITLE) {
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

  const { data: freshTitleRow } = await supabase
    .from('chat_sessions')
    .select('title')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!freshTitleRow || freshTitleRow.title !== NOVA_CHAT_DEFAULT_TITLE) {
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
