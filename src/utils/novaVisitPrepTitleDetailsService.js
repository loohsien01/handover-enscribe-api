/**
 * Fire-and-forget visit prep title-field extraction (Haiku + JSON schema).
 * @see docs/VISIT_PREP_ARCHITECTURE.md — Session title
 */
import { getSupabaseClient } from './supabase.js';
import { getRedisClient } from './redisClient.js';
import { claudeInvokeModel } from './bedrockClient.js';
import { getNovaVisitPrepTitleDetailsRequestBody } from './claudeRequestBody.js';
import {
  VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA,
  novaVisitPrepTitleDetailsModelId,
  postProcessVisitPrepTitleDetails,
} from './novaVisitPrepTitleDetails.js';
import {
  pickFirstTurnForNovaChatTitle,
  truncateNovaChatTitlePromptText,
} from './novaChatTitle.js';
import {
  loadNovaChatSessionFromSupabase,
  novaChatCompletionJobsTable,
} from './novaChatPersistence.js';
import {
  normalizeNovaSessionShape,
  novaSessionGet,
} from './novaRedisSession.js';
import { writeVisitPrepTitleDetails } from './novaVisitPrepTitleDetailsCache.js';
import * as userSecurityConfigController from '../fastify/controllers/userSecurityConfigController.js';

/**
 * True when this chat has exactly one successful Nova turn (complete or visit-prep save failure).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<boolean>}
 */
async function isFirstSuccessfulNovaTurnForChat(supabase, userId, chatId) {
  const { count: completeCount, error: completeErr } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .eq('status', 'complete');

  if (completeErr) {
    console.error('[novaVisitPrepTitleDetails] count complete jobs:', completeErr);
    return false;
  }

  const { count: vpFailCount, error: vpFailErr } = await supabase
    .from(novaChatCompletionJobsTable)
    .select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .eq('status', 'failed')
    .eq('error_code', 'VISIT_PREP_PERSIST_FAILED');

  if (vpFailErr) {
    console.error('[novaVisitPrepTitleDetails] count visit prep failed jobs:', vpFailErr);
    return false;
  }

  return (completeCount ?? 0) + (vpFailCount ?? 0) === 1;
}

/**
 * @param {string} userMessage
 * @param {string | null | undefined} assistantMessage
 * @param {(reqBody: object) => Promise<{ text?: string }>} [invokeModel]
 * @returns {Promise<{ patient_display_name: string, visit_kind: 'F/U' | 'NP' } | null>}
 */
export async function extractVisitPrepTitleDetailsWithModel(
  userMessage,
  assistantMessage,
  invokeModel = claudeInvokeModel
) {
  const modelId = novaVisitPrepTitleDetailsModelId();
  const reqBody = getNovaVisitPrepTitleDetailsRequestBody({
    modelId,
    userMessage: truncateNovaChatTitlePromptText(userMessage),
    assistantMessage:
      assistantMessage != null ? truncateNovaChatTitlePromptText(assistantMessage) : undefined,
    outputSchema: VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA,
  });
  const inv = await invokeModel(reqBody);
  return postProcessVisitPrepTitleDetails(inv.text ?? '');
}

/**
 * After the first successful Nova turn on the save route, extract title fields for poll delivery.
 * Fail open — logs errors, never throws to caller.
 *
 * @param {{ userId: string, chatId: string, jobId: string, authorizationHeader: string }} args
 */
export async function maybeRunVisitPrepTitleDetailsExtraction(args) {
  const { userId, chatId, jobId, authorizationHeader } = args;
  const supabase = getSupabaseClient(authorizationHeader);

  const isFirstTurn = await isFirstSuccessfulNovaTurnForChat(supabase, userId, chatId);
  if (!isFirstTurn) {
    return;
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, userId);
  if (!keyResult.success) {
    console.error('[novaVisitPrepTitleDetails] master key:', keyResult.error);
    return;
  }
  const masterKey = keyResult.masterKey;

  const redis = await getRedisClient();
  if (!redis) {
    console.error('[novaVisitPrepTitleDetails] Redis unavailable');
    return;
  }

  /** @type {import('./novaRedisSession.js').NovaChatSession | null} */
  let session = await novaSessionGet(redis, userId, chatId);
  if (!session) {
    const loaded = await loadNovaChatSessionFromSupabase(supabase, userId, chatId, masterKey);
    session = loaded?.session ?? null;
  }
  if (!session) {
    console.error('[novaVisitPrepTitleDetails] session not found for job', jobId);
    return;
  }
  normalizeNovaSessionShape(session);

  const { userMessage, assistantMessage } = pickFirstTurnForNovaChatTitle(session.messages);
  if (!userMessage) {
    return;
  }

  let details;
  try {
    details = await extractVisitPrepTitleDetailsWithModel(userMessage, assistantMessage);
  } catch (err) {
    console.error('[novaVisitPrepTitleDetails] Bedrock invoke failed:', err);
    return;
  }
  if (!details) {
    return;
  }

  try {
    await writeVisitPrepTitleDetails(redis, jobId, details);
  } catch (err) {
    console.error('[novaVisitPrepTitleDetails] Redis write failed:', err);
  }
}
