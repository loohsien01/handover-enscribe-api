/**
 * Fire-and-forget pre-visit summary title-field extraction (Haiku + JSON schema).
 * @see docs/PRE_VISIT_SUMMARY_ARCHITECTURE.md — Session title
 */
import { getSupabaseClient } from './supabase.js';
import { getRedisClient } from './redisClient.js';
import { claudeInvokeModel } from './bedrockClient.js';
import { getNovaPreVisitSummaryTitleDetailsRequestBody } from './claudeRequestBody.js';
import {
  PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA,
  novaPreVisitSummaryTitleDetailsModelId,
  postProcessPreVisitSummaryTitleDetails,
} from './novaPreVisitSummaryTitleDetails.js';
import {
  pickFirstTurnForNovaChatTitle,
  truncateNovaChatTitlePromptText,
} from './novaChatTitle.js';
import {
  loadNovaChatSessionFromSupabase,
  countNovaCompletionJobsByStatus,
  countNovaPreVisitPersistFailedJobs,
} from './novaChatPersistence.js';
import {
  normalizeNovaSessionShape,
  novaSessionGet,
} from './novaRedisSession.js';
import { writePreVisitSummaryTitleDetails } from './novaPreVisitSummaryTitleDetailsCache.js';
import * as userSecurityConfigController from '../fastify/controllers/userSecurityConfigController.js';

/**
 * True when this chat has exactly one successful Nova turn (complete or pre-visit-summary save failure).
 *
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<boolean>}
 */
async function isFirstSuccessfulNovaTurnForChat(userId, chatId) {
  const completeCount = await countNovaCompletionJobsByStatus(userId, chatId, 'complete');
  const vpFailCount = await countNovaPreVisitPersistFailedJobs(userId, chatId);
  return completeCount + vpFailCount === 1;
}

/**
 * @param {string} userMessage
 * @param {string | null | undefined} assistantMessage
 * @param {(reqBody: object) => Promise<{ text?: string }>} [invokeModel]
 * @returns {Promise<{ patient_display_name: string, visit_kind: 'F/U' | 'NP' } | null>}
 */
export async function extractPreVisitSummaryTitleDetailsWithModel(
  userMessage,
  assistantMessage,
  invokeModel = claudeInvokeModel
) {
  const modelId = novaPreVisitSummaryTitleDetailsModelId();
  const reqBody = getNovaPreVisitSummaryTitleDetailsRequestBody({
    modelId,
    userMessage: truncateNovaChatTitlePromptText(userMessage),
    assistantMessage:
      assistantMessage != null ? truncateNovaChatTitlePromptText(assistantMessage) : undefined,
    outputSchema: PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA,
  });
  const inv = await invokeModel(reqBody);
  return postProcessPreVisitSummaryTitleDetails(inv.text ?? '');
}

/**
 * After the first successful Nova turn on the save route, extract title fields for poll delivery.
 * Fail open — logs errors, never throws to caller.
 *
 * @param {{ userId: string, chatId: string, jobId: string, authorizationHeader: string }} args
 */
export async function maybeRunPreVisitSummaryTitleDetailsExtraction(args) {
  const { userId, chatId, jobId, authorizationHeader } = args;
  const supabase = getSupabaseClient(authorizationHeader);

  const isFirstTurn = await isFirstSuccessfulNovaTurnForChat(userId, chatId);
  if (!isFirstTurn) {
    return;
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, userId);
  if (!keyResult.success) {
    console.error('[novaPreVisitSummaryTitleDetails] master key:', keyResult.error);
    return;
  }
  const masterKey = keyResult.masterKey;

  const redis = await getRedisClient();
  if (!redis) {
    console.error('[novaPreVisitSummaryTitleDetails] Redis unavailable');
    return;
  }

  /** @type {import('./novaRedisSession.js').NovaChatSession | null} */
  let session = await novaSessionGet(redis, userId, chatId);
  if (!session) {
    const loaded = await loadNovaChatSessionFromSupabase(supabase, userId, chatId, masterKey);
    session = loaded?.session ?? null;
  }
  if (!session) {
    console.error('[novaPreVisitSummaryTitleDetails] session not found for job', jobId);
    return;
  }
  normalizeNovaSessionShape(session);

  const { userMessage, assistantMessage } = pickFirstTurnForNovaChatTitle(session.messages);
  if (!userMessage) {
    return;
  }

  let details;
  try {
    details = await extractPreVisitSummaryTitleDetailsWithModel(userMessage, assistantMessage);
  } catch (err) {
    console.error('[novaPreVisitSummaryTitleDetails] Bedrock invoke failed:', err);
    return;
  }
  if (!details) {
    return;
  }

  try {
    await writePreVisitSummaryTitleDetails(redis, jobId, details);
  } catch (err) {
    console.error('[novaPreVisitSummaryTitleDetails] Redis write failed:', err);
  }
}
