/**
 * Pre-Visit Summaries — encrypted pre-visit summary documents (user master key).
 * `createPreVisitSummary` is the single write path for new rows (POST handler + Nova save processor).
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { chatSessionsTable } from '../../utils/novaChatPersistence.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';

const preVisitSummariesTable = 'pre_visit_summaries';

/**
 * @param {string} id
 */
function isValidUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * @param {object} row
 */
function stripEncryptionFields(row) {
  const { encrypted_text, text_iv, ...stripped } = row;
  return stripped;
}

/**
 * @param {object} row
 * @param {Buffer} masterKey
 */
function formatPreVisitSummaryRow(row, masterKey, textOverride) {
  const decryptResult = encryptionUtils.decryptNoteText(row, masterKey);
  if (!decryptResult.success) {
    return { success: false, error: decryptResult.error };
  }
  const formatted = stripEncryptionFields(row);
  formatted.text = textOverride !== undefined ? textOverride : decryptResult.text ?? '';
  return { success: true, preVisitSummary: formatted };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} chatId
 */
async function verifyOwnedChatSession(supabase, userId, chatId) {
  const { data, error } = await supabase
    .from(chatSessionsTable)
    .select('id')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[createPreVisitSummary] chat session lookup failed:', error);
    return {
      success: false,
      error: error.message || 'Failed to verify chat session',
      code: 'PRE_VISIT_SUMMARY_CHAT_LOOKUP_FAILED',
    };
  }

  if (!data) {
    return {
      success: false,
      error: 'Chat session not found',
      code: 'PRE_VISIT_SUMMARY_CHAT_NOT_FOUND',
    };
  }

  return { success: true };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {Buffer} masterKey
 * @param {{ text?: string, chatId: string }} input
 */
export async function createPreVisitSummary(supabase, userId, masterKey, input) {
  const { text = '', chatId } = input;

  if (!chatId || !isValidUuid(chatId)) {
    return {
      success: false,
      error: 'chat_id is required',
      code: 'PRE_VISIT_SUMMARY_CHAT_ID_REQUIRED',
    };
  }

  const chatCheck = await verifyOwnedChatSession(supabase, userId, chatId);
  if (!chatCheck.success) {
    return chatCheck;
  }

  let encryptedText = null;
  let textIv = null;

  if (text) {
    const encryptResult = encryptionUtils.encryptNoteText({ text }, masterKey);
    if (!encryptResult.success) {
      return {
        success: false,
        error: encryptResult.error || 'Failed to encrypt pre-visit summary text',
        code: 'PRE_VISIT_SUMMARY_ENCRYPT_FAILED',
      };
    }
    encryptedText = encryptResult.value;
    textIv = encryptResult.iv;
  }

  const { data: row, error } = await supabase
    .from(preVisitSummariesTable)
    .insert({
      user_id: userId,
      chat_id: chatId,
      encrypted_text: encryptedText,
      text_iv: textIv,
    })
    .select()
    .single();

  if (error) {
    console.error('[createPreVisitSummary] insert failed:', error);
    return {
      success: false,
      error: error.message || 'Failed to create Pre-Visit Summary',
      code: 'PRE_VISIT_SUMMARY_INSERT_FAILED',
    };
  }

  const formatted = formatPreVisitSummaryRow(row, masterKey, text);
  if (!formatted.success) {
    return {
      success: false,
      error: formatted.error || 'Failed to decrypt Pre-Visit Summary after insert',
      code: 'PRE_VISIT_SUMMARY_DECRYPT_FAILED',
    };
  }

  return { success: true, preVisitSummary: formatted.preVisitSummary };
}

/**
 * POST /api/pre-visit-summaries
 */
export async function createPreVisitSummaryHandler(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { text = '', chat_id: chatId } = request.body;

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const result = await createPreVisitSummary(supabase, user.id, keyResult.masterKey, { text, chatId });

  if (!result.success) {
    if (result.code === 'PRE_VISIT_SUMMARY_CHAT_NOT_FOUND') {
      return reply.status(404).send({ error: result.error, code: result.code });
    }
    if (result.code === 'PRE_VISIT_SUMMARY_CHAT_ID_REQUIRED') {
      return reply.status(400).send({ error: result.error, code: result.code });
    }
    return reply.status(500).send({ error: result.error, code: result.code });
  }

  return reply.status(201).send(result.preVisitSummary);
}

/**
 * GET /api/pre-visit-summaries
 */
export async function listPreVisitSummaries(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { limit, offset, sortBy, order } = request.query;

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const { data, error } = await supabase
    .from(preVisitSummariesTable)
    .select('*')
    .eq('user_id', user.id)
    .order(sortBy, { ascending: order === 'asc' })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[listPreVisitSummaries] fetch failed:', error);
    return reply.status(500).send({ error: error.message });
  }

  const preVisitSummaries = [];
  for (const row of data) {
    const formatted = formatPreVisitSummaryRow(row, keyResult.masterKey);
    if (!formatted.success) {
      return reply.status(400).send({ error: formatted.error });
    }
    preVisitSummaries.push(formatted.preVisitSummary);
  }

  return reply.status(200).send(preVisitSummaries);
}

/**
 * GET /api/pre-visit-summaries/:id
 */
export async function getPreVisitSummary(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary ID format' });
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const { data: row, error } = await supabase
    .from(preVisitSummariesTable)
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !row) {
    return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
  }

  const formatted = formatPreVisitSummaryRow(row, keyResult.masterKey);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(200).send(formatted.preVisitSummary);
}

/**
 * PATCH /api/pre-visit-summaries/:id
 */
export async function updatePreVisitSummary(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary ID format' });
  }

  const { text } = request.body;

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const { data: existing, error: fetchError } = await supabase
    .from(preVisitSummariesTable)
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchError || !existing) {
    return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
  }

  const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
  if (!encryptResult.success) {
    return reply.status(500).send({ error: encryptResult.error });
  }

  const { data: updated, error: updateError } = await supabase
    .from(preVisitSummariesTable)
    .update({
      encrypted_text: encryptResult.value,
      text_iv: encryptResult.iv,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    console.error('[updatePreVisitSummary] update failed:', updateError);
    return reply.status(500).send({ error: updateError.message });
  }

  const formatted = formatPreVisitSummaryRow(updated, keyResult.masterKey, text);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(200).send(formatted.preVisitSummary);
}

/**
 * DELETE /api/pre-visit-summaries/:id
 */
export async function deletePreVisitSummary(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary ID format' });
  }

  const { data, error } = await supabase
    .from(preVisitSummariesTable)
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
    }
    console.error('[deletePreVisitSummary] delete failed:', error);
    return reply.status(500).send({ error: error.message });
  }

  return reply.status(200).send({ success: true, id: data.id });
}

/**
 * Load pre-visit summary for Nova completion poll (decrypted).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} preVisitSummaryId
 * @param {Buffer} masterKey
 */
export async function loadPreVisitSummaryForPoll(supabase, userId, preVisitSummaryId, masterKey) {
  const { data: row, error } = await supabase
    .from(preVisitSummariesTable)
    .select('*')
    .eq('id', preVisitSummaryId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !row) {
    return null;
  }

  const formatted = formatPreVisitSummaryRow(row, masterKey);
  if (!formatted.success) {
    return null;
  }

  return formatted.preVisitSummary;
}
