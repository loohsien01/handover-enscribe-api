/**
 * Pre-Visit Summary Templates — encrypted default instruction blocks (user + system master keys).
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
  isPgUniqueViolation,
} from '../../utils/pgQueryHelpers.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import {
  getOrCreateUserMasterKey,
  getSystemMasterKey,
} from './userSecurityConfigController.js';

const preVisitSummaryTemplatesTable = 'pre_visit_summary_templates';

const PRE_VISIT_TEMPLATE_SORT_COLUMNS = new Set(['created_at', 'updated_at', 'name', 'id']);

/**
 * @param {string} id
 */
function isValidUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function preVisitTemplateOrderClause(sortBy, order) {
  const column = PRE_VISIT_TEMPLATE_SORT_COLUMNS.has(sortBy) ? sortBy : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${direction}`;
}

/**
 * @param {object} row
 */
function isSystemTemplate(row) {
  return row.user_id === null;
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
 * @param {string} [textOverride]
 */
function formatTemplateRow(row, masterKey, textOverride) {
  const formatted = stripEncryptionFields(row);

  if (textOverride !== undefined) {
    formatted.text = textOverride;
    return { success: true, template: formatted };
  }

  if (!row.encrypted_text) {
    formatted.text = '';
    return { success: true, template: formatted };
  }

  const decryptResult = encryptionUtils.decryptNoteText(row, masterKey);
  if (!decryptResult.success) {
    return { success: false, error: decryptResult.error };
  }

  formatted.text = decryptResult.text ?? '';
  return { success: true, template: formatted };
}

/**
 * @param {string} userId
 */
async function clearUserDefaultTemplate(userId) {
  try {
    await pgQueryOne(
      `UPDATE ${preVisitSummaryTemplatesTable}
          SET is_default = false
        WHERE user_id = $1 AND is_default = true
        RETURNING id`,
      [userId]
    );
    return { success: true };
  } catch (error) {
    console.error('[preVisitSummaryTemplates] clear default failed:', error);
    return { success: false, error: pgErrorMessage(error) || 'Failed to clear default template' };
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {object} row
 * @param {{ userKeyResult?: object, systemKeyResult?: object }} keyCache
 */
async function resolveMasterKeyForRow(supabase, userId, row, keyCache = {}) {
  if (isSystemTemplate(row)) {
    if (!keyCache.systemKeyResult) {
      keyCache.systemKeyResult = await getSystemMasterKey();
    }
    return keyCache.systemKeyResult;
  }

  if (!keyCache.userKeyResult) {
    keyCache.userKeyResult = await getOrCreateUserMasterKey(supabase, userId);
  }
  return keyCache.userKeyResult;
}

/**
 * @param {unknown} dbError
 */
function mapDuplicateNameError(dbError) {
  if (isPgUniqueViolation(dbError)) {
    return {
      status: 409,
      body: {
        error: 'A template with this name already exists for your account',
        message: 'A template with this name already exists for your account',
        field: 'name',
      },
    };
  }
  return null;
}

/**
 * POST /api/pre-visit-summary-templates
 */
export async function createPreVisitSummaryTemplate(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { name, text = '', is_default: isDefault = false } = request.body;

  const keyResult = await getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  if (isDefault) {
    const clearResult = await clearUserDefaultTemplate(user.id);
    if (!clearResult.success) {
      return reply.status(500).send({ error: clearResult.error });
    }
  }

  let encryptedText = null;
  let textIv = null;

  if (text) {
    const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
    if (!encryptResult.success) {
      return reply.status(500).send({ error: encryptResult.error || 'Failed to encrypt template text' });
    }
    encryptedText = encryptResult.value;
    textIv = encryptResult.iv;
  }

  try {
    const row = await pgQueryOne(
      `INSERT INTO ${preVisitSummaryTemplatesTable} (
         user_id, name, encrypted_text, text_iv, is_default
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user.id, name, encryptedText, textIv, isDefault]
    );

    const formatted = formatTemplateRow(row, keyResult.masterKey, text);
    if (!formatted.success) {
      return reply.status(400).send({ error: formatted.error });
    }

    return reply.status(201).send(formatted.template);
  } catch (error) {
    console.error('[createPreVisitSummaryTemplate] insert failed:', error);
    const duplicate = mapDuplicateNameError(error);
    if (duplicate) {
      return reply.status(duplicate.status).send(duplicate.body);
    }
    return reply.status(500).send({ error: pgErrorMessage(error) || 'Failed to create template' });
  }
}

/**
 * GET /api/pre-visit-summary-templates
 */
export async function listPreVisitSummaryTemplates(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { limit, offset, sortBy, order, decrypt_text: decryptText } = request.query;
  const orderClause = preVisitTemplateOrderClause(sortBy, order);

  try {
    const data = await pgQueryRows(
      `SELECT *
         FROM ${preVisitSummaryTemplatesTable}
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY ${orderClause}
        LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    );

    if (!decryptText) {
      return reply.status(200).send(data.map(stripEncryptionFields));
    }

    const keyCache = {};
    const templates = [];

    for (const row of data) {
      const keyResult = await resolveMasterKeyForRow(supabase, user.id, row, keyCache);
      if (!keyResult.success) {
        return reply.status(500).send({ error: keyResult.error });
      }

      const formatted = formatTemplateRow(row, keyResult.masterKey);
      if (!formatted.success) {
        return reply.status(400).send({ error: formatted.error });
      }

      templates.push(formatted.template);
    }

    return reply.status(200).send(templates);
  } catch (error) {
    console.error('[listPreVisitSummaryTemplates] fetch failed:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * GET /api/pre-visit-summary-templates/:id
 */
export async function getPreVisitSummaryTemplate(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary Template ID format' });
  }

  const row = await pgQueryOne(
    `SELECT *
       FROM ${preVisitSummaryTemplatesTable}
      WHERE id = $1
        AND (user_id = $2 OR user_id IS NULL)`,
    [id, user.id]
  );

  if (!row) {
    return reply.status(404).send({ error: 'Pre-Visit Summary Template not found' });
  }

  const keyResult = await resolveMasterKeyForRow(supabase, user.id, row);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const formatted = formatTemplateRow(row, keyResult.masterKey);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(200).send(formatted.template);
}

/**
 * PATCH /api/pre-visit-summary-templates/:id
 */
export async function updatePreVisitSummaryTemplate(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary Template ID format' });
  }

  const { name, text, is_default: isDefault } = request.body;

  const keyResult = await getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const existing = await pgQueryOne(
    `SELECT *
       FROM ${preVisitSummaryTemplatesTable}
      WHERE id = $1 AND user_id = $2`,
    [id, user.id]
  );

  if (!existing) {
    return reply.status(404).send({ error: 'Pre-Visit Summary Template not found' });
  }

  if (isDefault === true) {
    const clearResult = await clearUserDefaultTemplate(user.id);
    if (!clearResult.success) {
      return reply.status(500).send({ error: clearResult.error });
    }
  }

  const setClauses = [];
  const params = [];
  let paramIndex = 1;

  if (name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    params.push(name);
  }

  if (text !== undefined) {
    if (text) {
      const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
      if (!encryptResult.success) {
        return reply.status(500).send({ error: encryptResult.error || 'Failed to encrypt template text' });
      }
      setClauses.push(`encrypted_text = $${paramIndex++}`);
      params.push(encryptResult.value);
      setClauses.push(`text_iv = $${paramIndex++}`);
      params.push(encryptResult.iv);
    } else {
      setClauses.push(`encrypted_text = $${paramIndex++}`);
      params.push(null);
      setClauses.push(`text_iv = $${paramIndex++}`);
      params.push(null);
    }
  }

  if (isDefault !== undefined) {
    setClauses.push(`is_default = $${paramIndex++}`);
    params.push(isDefault);
  }

  if (setClauses.length === 0) {
    const formatted = formatTemplateRow(existing, keyResult.masterKey);
    if (!formatted.success) {
      return reply.status(400).send({ error: formatted.error });
    }
    return reply.status(200).send(formatted.template);
  }

  setClauses.push('updated_at = NOW()');
  params.push(id, user.id);

  try {
    const updated = await pgQueryOne(
      `UPDATE ${preVisitSummaryTemplatesTable}
          SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex++} AND user_id = $${paramIndex}
        RETURNING *`,
      params
    );

    if (!updated) {
      return reply.status(404).send({ error: 'Pre-Visit Summary Template not found' });
    }

    const textOverride = text !== undefined ? text : undefined;
    const formatted = formatTemplateRow(updated, keyResult.masterKey, textOverride);
    if (!formatted.success) {
      return reply.status(400).send({ error: formatted.error });
    }

    return reply.status(200).send(formatted.template);
  } catch (updateError) {
    console.error('[updatePreVisitSummaryTemplate] update failed:', updateError);
    const duplicate = mapDuplicateNameError(updateError);
    if (duplicate) {
      return reply.status(duplicate.status).send(duplicate.body);
    }
    return reply.status(500).send({ error: pgErrorMessage(updateError) });
  }
}

/**
 * DELETE /api/pre-visit-summary-templates/:id
 */
export async function deletePreVisitSummaryTemplate(request, reply) {
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary Template ID format' });
  }

  try {
    const data = await pgQueryOne(
      `DELETE FROM ${preVisitSummaryTemplatesTable}
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Pre-Visit Summary Template not found' });
    }

    return reply.status(200).send({ success: true, id: data.id });
  } catch (error) {
    console.error('[deletePreVisitSummaryTemplate] delete failed:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}
