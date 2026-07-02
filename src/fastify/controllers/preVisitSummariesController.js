/**
 * Pre-Visit Summaries — encrypted pre-visit summary documents (user master key).
 * `createPreVisitSummary` is the single write path for new rows (POST handler + Nova save processor).
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
} from '../../utils/pgQueryHelpers.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { chatSessionsTable } from '../../utils/novaChatPersistence.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';

const preVisitSummariesTable = 'pre_visit_summaries';

const PRE_VISIT_SUMMARY_SORT_COLUMNS = new Set(['created_at', 'updated_at', 'id']);

/**
 * @param {string} id
 */
function isValidUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function preVisitSummaryOrderClause(sortBy, order) {
  const column = PRE_VISIT_SUMMARY_SORT_COLUMNS.has(sortBy) ? sortBy : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${direction}`;
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
 * @param {string} userId
 * @param {string} chatId
 */
async function verifyOwnedChatSession(userId, chatId) {
  try {
    const data = await pgQueryOne(
      `SELECT id
         FROM ${chatSessionsTable}
        WHERE id = $1 AND user_id = $2`,
      [chatId, userId]
    );

    if (!data) {
      return {
        success: false,
        error: 'Chat session not found',
        code: 'PRE_VISIT_SUMMARY_CHAT_NOT_FOUND',
      };
    }

    return { success: true };
  } catch (error) {
    console.error('[createPreVisitSummary] chat session lookup failed:', error);
    return {
      success: false,
      error: pgErrorMessage(error) || 'Failed to verify chat session',
      code: 'PRE_VISIT_SUMMARY_CHAT_LOOKUP_FAILED',
    };
  }
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

  const chatCheck = await verifyOwnedChatSession(userId, chatId);
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

  try {
    const row = await pgQueryOne(
      `INSERT INTO ${preVisitSummariesTable} (
         user_id, chat_id, encrypted_text, text_iv
       ) VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, chatId, encryptedText, textIv]
    );

    if (!row) {
      return {
        success: false,
        error: 'Failed to create Pre-Visit Summary',
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
  } catch (error) {
    console.error('[createPreVisitSummary] insert failed:', error);
    return {
      success: false,
      error: pgErrorMessage(error) || 'Failed to create Pre-Visit Summary',
      code: 'PRE_VISIT_SUMMARY_INSERT_FAILED',
    };
  }
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
  const orderClause = preVisitSummaryOrderClause(sortBy, order);

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  try {
    const data = await pgQueryRows(
      `SELECT *
         FROM ${preVisitSummariesTable}
        WHERE user_id = $1
        ORDER BY ${orderClause}
        LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    );

    const preVisitSummaries = [];
    for (const row of data) {
      const formatted = formatPreVisitSummaryRow(row, keyResult.masterKey);
      if (!formatted.success) {
        return reply.status(400).send({ error: formatted.error });
      }
      preVisitSummaries.push(formatted.preVisitSummary);
    }

    return reply.status(200).send(preVisitSummaries);
  } catch (error) {
    console.error('[listPreVisitSummaries] fetch failed:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
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

  const row = await pgQueryOne(
    `SELECT *
       FROM ${preVisitSummariesTable}
      WHERE id = $1 AND user_id = $2`,
    [id, user.id]
  );

  if (!row) {
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

  const existing = await pgQueryOne(
    `SELECT *
       FROM ${preVisitSummariesTable}
      WHERE id = $1 AND user_id = $2`,
    [id, user.id]
  );

  if (!existing) {
    return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
  }

  const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
  if (!encryptResult.success) {
    return reply.status(500).send({ error: encryptResult.error });
  }

  try {
    const updated = await pgQueryOne(
      `UPDATE ${preVisitSummariesTable}
          SET encrypted_text = $1,
              text_iv = $2,
              updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING *`,
      [encryptResult.value, encryptResult.iv, id, user.id]
    );

    if (!updated) {
      return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
    }

    const formatted = formatPreVisitSummaryRow(updated, keyResult.masterKey, text);
    if (!formatted.success) {
      return reply.status(400).send({ error: formatted.error });
    }

    return reply.status(200).send(formatted.preVisitSummary);
  } catch (updateError) {
    console.error('[updatePreVisitSummary] update failed:', updateError);
    return reply.status(500).send({ error: pgErrorMessage(updateError) });
  }
}

/**
 * DELETE /api/pre-visit-summaries/:id
 */
export async function deletePreVisitSummary(request, reply) {
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary ID format' });
  }

  try {
    const data = await pgQueryOne(
      `DELETE FROM ${preVisitSummariesTable}
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
    }

    return reply.status(200).send({ success: true, id: data.id });
  } catch (error) {
    console.error('[deletePreVisitSummary] delete failed:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Load pre-visit summary for Nova completion poll (decrypted).
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {string} userId
 * @param {string} preVisitSummaryId
 * @param {Buffer} masterKey
 */
export async function loadPreVisitSummaryForPoll(_supabase, userId, preVisitSummaryId, masterKey) {
  const row = await pgQueryOne(
    `SELECT *
       FROM ${preVisitSummariesTable}
      WHERE id = $1 AND user_id = $2`,
    [preVisitSummaryId, userId]
  );

  if (!row) {
    return null;
  }

  const formatted = formatPreVisitSummaryRow(row, masterKey);
  if (!formatted.success) {
    return null;
  }

  return formatted.preVisitSummary;
}
