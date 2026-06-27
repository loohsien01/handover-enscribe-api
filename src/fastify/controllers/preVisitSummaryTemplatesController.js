/**
 * Pre-Visit Summary Templates — encrypted default instruction blocks (user + system master keys).
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import {
  getOrCreateUserMasterKey,
  getSystemMasterKey,
} from './userSecurityConfigController.js';

const preVisitSummaryTemplatesTable = 'pre_visit_summary_templates';

/**
 * @param {string} id
 */
function isValidUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
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
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 */
async function clearUserDefaultTemplate(supabase, userId) {
  const { error } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .update({ is_default: false })
    .eq('user_id', userId)
    .eq('is_default', true);

  if (error) {
    console.error('[preVisitSummaryTemplates] clear default failed:', error);
    return { success: false, error: error.message || 'Failed to clear default template' };
  }

  return { success: true };
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
 * @param {object} dbError
 */
function mapDuplicateNameError(dbError) {
  if (dbError?.code === '23505') {
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
    const clearResult = await clearUserDefaultTemplate(supabase, user.id);
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

  const { data: row, error } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .insert({
      user_id: user.id,
      name,
      encrypted_text: encryptedText,
      text_iv: textIv,
      is_default: isDefault,
    })
    .select()
    .single();

  if (error) {
    console.error('[createPreVisitSummaryTemplate] insert failed:', error);
    const duplicate = mapDuplicateNameError(error);
    if (duplicate) {
      return reply.status(duplicate.status).send(duplicate.body);
    }
    return reply.status(500).send({ error: error.message || 'Failed to create template' });
  }

  const formatted = formatTemplateRow(row, keyResult.masterKey, text);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(201).send(formatted.template);
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

  const { data, error } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .select('*')
    .order(sortBy, { ascending: order === 'asc' })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[listPreVisitSummaryTemplates] fetch failed:', error);
    return reply.status(500).send({ error: error.message });
  }

  if (!decryptText) {
    return reply.status(200).send((data ?? []).map(stripEncryptionFields));
  }

  const keyCache = {};
  const templates = [];

  for (const row of data ?? []) {
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

  const { data: row, error } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !row) {
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

  const { data: existing, error: fetchError } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchError || !existing) {
    return reply.status(404).send({ error: 'Pre-Visit Summary Template not found' });
  }

  if (isDefault === true) {
    const clearResult = await clearUserDefaultTemplate(supabase, user.id);
    if (!clearResult.success) {
      return reply.status(500).send({ error: clearResult.error });
    }
  }

  /** @type {Record<string, unknown>} */
  const updatePayload = {};

  if (name !== undefined) {
    updatePayload.name = name;
  }

  if (text !== undefined) {
    if (text) {
      const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
      if (!encryptResult.success) {
        return reply.status(500).send({ error: encryptResult.error || 'Failed to encrypt template text' });
      }
      updatePayload.encrypted_text = encryptResult.value;
      updatePayload.text_iv = encryptResult.iv;
    } else {
      updatePayload.encrypted_text = null;
      updatePayload.text_iv = null;
    }
  }

  if (isDefault !== undefined) {
    updatePayload.is_default = isDefault;
  }

  const { data: updated, error: updateError } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .update(updatePayload)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (updateError) {
    console.error('[updatePreVisitSummaryTemplate] update failed:', updateError);
    const duplicate = mapDuplicateNameError(updateError);
    if (duplicate) {
      return reply.status(duplicate.status).send(duplicate.body);
    }
    return reply.status(500).send({ error: updateError.message });
  }

  const textOverride = text !== undefined ? text : undefined;
  const formatted = formatTemplateRow(updated, keyResult.masterKey, textOverride);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(200).send(formatted.template);
}

/**
 * DELETE /api/pre-visit-summary-templates/:id
 */
export async function deletePreVisitSummaryTemplate(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid Pre-Visit Summary Template ID format' });
  }

  const { data, error } = await supabase
    .from(preVisitSummaryTemplatesTable)
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return reply.status(404).send({ error: 'Pre-Visit Summary Template not found' });
    }
    console.error('[deletePreVisitSummaryTemplate] delete failed:', error);
    return reply.status(500).send({ error: error.message });
  }

  return reply.status(200).send({ success: true, id: data.id });
}
