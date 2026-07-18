/**
 * Pre-Visit Summaries — encrypted pre-visit summary documents (user master key).
 * `createPreVisitSummary` is the single write path for new rows (POST handler + Nova save processor).
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
  pgCoerceBigIntFields,
} from '../../utils/pgQueryHelpers.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import {
  chatSessionsTable,
  deleteOwnedNovaChatSession,
} from '../../utils/novaChatPersistence.js';
import {
  PRE_VISIT_SUMMARY_DEFAULT_TITLE,
  normalizeNovaChatTitle,
} from '../../utils/novaChatTitle.js';
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
  formatted.title = row.title ?? PRE_VISIT_SUMMARY_DEFAULT_TITLE;
  const coerced = pgCoerceBigIntFields(row, ['patientEncounter_id']);
  formatted.patientEncounter_id = coerced.patientEncounter_id ?? null;
  return { success: true, preVisitSummary: formatted };
}

/**
 * Enqueue-time guard for prompt-llm jobs: summary must exist, be owned, and not yet linked to an encounter.
 *
 * @param {string} userId
 * @param {string} preVisitSummaryId
 */
export async function validatePreVisitSummaryForNoteGeneration(userId, preVisitSummaryId) {
  if (!preVisitSummaryId) {
    return { success: true };
  }

  if (!isValidUuid(preVisitSummaryId)) {
    return {
      success: false,
      status: 400,
      error: 'Invalid pre_visit_summary_id',
      code: 'PRE_VISIT_SUMMARY_INVALID_ID',
    };
  }

  const row = await pgQueryOne(
    `SELECT id, "patientEncounter_id"
       FROM ${preVisitSummariesTable}
      WHERE id = $1 AND user_id = $2`,
    [preVisitSummaryId, userId]
  );

  if (!row) {
    return {
      success: false,
      status: 404,
      error: 'Pre-Visit Summary not found',
      code: 'PRE_VISIT_SUMMARY_NOT_FOUND',
    };
  }

  if (row.patientEncounter_id != null) {
    return {
      success: false,
      status: 409,
      error: 'Pre-Visit Summary is already linked to a patient encounter',
      code: 'PRE_VISIT_SUMMARY_ALREADY_LINKED',
    };
  }

  return { success: true };
}

/**
 * Set encounter link after successful generate-and-save-note (first consumption only).
 *
 * @param {string} userId
 * @param {string} preVisitSummaryId
 * @param {bigint|number|string} patientEncounterId
 */
export async function linkPreVisitSummaryToPatientEncounter(userId, preVisitSummaryId, patientEncounterId) {
  if (!preVisitSummaryId || !patientEncounterId) {
    return { success: false };
  }

  try {
    const updated = await pgQueryOne(
      `UPDATE ${preVisitSummariesTable}
          SET "patientEncounter_id" = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3 AND "patientEncounter_id" IS NULL
        RETURNING id`,
      [patientEncounterId, preVisitSummaryId, userId]
    );

    if (!updated) {
      console.warn(
        `[linkPreVisitSummaryToPatientEncounter] No row updated for summary ${preVisitSummaryId} (already linked or not found)`
      );
      return { success: false };
    }

    return { success: true };
  } catch (error) {
    console.error('[linkPreVisitSummaryToPatientEncounter] update failed:', error);
    return { success: false, error: pgErrorMessage(error) };
  }
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
 * @param {{ text?: string, chatId: string, title?: string }} input
 */
export async function createPreVisitSummary(supabase, userId, masterKey, input) {
  const { text = '', chatId, title } = input;

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
    const insertColumns = ['user_id', 'chat_id', 'encrypted_text', 'text_iv'];
    const insertValues = [userId, chatId, encryptedText, textIv];
    if (title != null) {
      insertColumns.push('title');
      insertValues.push(normalizeNovaChatTitle(title));
    }
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');

    const row = await pgQueryOne(
      `INSERT INTO ${preVisitSummariesTable} (${insertColumns.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      insertValues
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

  const { text = '', chat_id: chatId, title } = request.body;

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const result = await createPreVisitSummary(supabase, user.id, keyResult.masterKey, {
    text,
    chatId,
    title,
  });

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

  const { text, title } = request.body;

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

  const setClauses = [];
  const queryParams = [];
  let paramIndex = 1;

  if (text !== undefined) {
    const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
    if (!encryptResult.success) {
      return reply.status(500).send({ error: encryptResult.error });
    }
    setClauses.push(`encrypted_text = $${paramIndex++}`);
    queryParams.push(encryptResult.value);
    setClauses.push(`text_iv = $${paramIndex++}`);
    queryParams.push(encryptResult.iv);
  }

  if (title !== undefined) {
    setClauses.push(`title = $${paramIndex++}`);
    queryParams.push(normalizeNovaChatTitle(title));
  }

  setClauses.push('updated_at = NOW()');
  queryParams.push(id, user.id);

  try {
    const updated = await pgQueryOne(
      `UPDATE ${preVisitSummariesTable}
          SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex++} AND user_id = $${paramIndex++}
        RETURNING *`,
      queryParams
    );

    if (!updated) {
      return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
    }

    const formatted = formatPreVisitSummaryRow(
      updated,
      keyResult.masterKey,
      text !== undefined ? text : undefined
    );
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
 * Also hard-deletes the linked Nova chat session (messages / jobs cascade; Redis cache cleared).
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
        RETURNING id, chat_id`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Pre-Visit Summary not found' });
    }

    const chatId = typeof data.chat_id === 'string' ? data.chat_id : null;
    if (chatId) {
      try {
        await deleteOwnedNovaChatSession(user.id, chatId);
      } catch (chatErr) {
        console.error('[deletePreVisitSummary] linked chat delete failed:', chatErr);
        return reply.status(500).send({ error: pgErrorMessage(chatErr) });
      }
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
