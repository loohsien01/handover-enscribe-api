/**
 * Visit preps — encrypted visit preparation documents (user master key).
 * `createVisitPrep` is the single write path for new rows (POST handler + Nova save processor).
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';

const visitPrepsTable = 'visit_preps';

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
function formatVisitPrepRow(row, masterKey, textOverride) {
  const decryptResult = encryptionUtils.decryptNoteText(row, masterKey);
  if (!decryptResult.success) {
    return { success: false, error: decryptResult.error };
  }
  const formatted = stripEncryptionFields(row);
  formatted.text = textOverride !== undefined ? textOverride : decryptResult.text ?? '';
  return { success: true, visitPrep: formatted };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {Buffer} masterKey
 * @param {{ text?: string }} input
 */
export async function createVisitPrep(supabase, userId, masterKey, input) {
  const { text = '' } = input;

  let encryptedText = null;
  let textIv = null;

  if (text) {
    const encryptResult = encryptionUtils.encryptNoteText({ text }, masterKey);
    if (!encryptResult.success) {
      return {
        success: false,
        error: encryptResult.error || 'Failed to encrypt visit prep text',
        code: 'VISIT_PREP_ENCRYPT_FAILED',
      };
    }
    encryptedText = encryptResult.value;
    textIv = encryptResult.iv;
  }

  const { data: row, error } = await supabase
    .from(visitPrepsTable)
    .insert({
      user_id: userId,
      encrypted_text: encryptedText,
      text_iv: textIv,
    })
    .select()
    .single();

  if (error) {
    console.error('[createVisitPrep] insert failed:', error);
    return {
      success: false,
      error: error.message || 'Failed to create visit prep',
      code: 'VISIT_PREP_INSERT_FAILED',
    };
  }

  const formatted = formatVisitPrepRow(row, masterKey, text);
  if (!formatted.success) {
    return {
      success: false,
      error: formatted.error || 'Failed to decrypt visit prep after insert',
      code: 'VISIT_PREP_DECRYPT_FAILED',
    };
  }

  return { success: true, visitPrep: formatted.visitPrep };
}

/**
 * POST /api/visit-preps
 */
export async function createVisitPrepHandler(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { text = '' } = request.body;

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const result = await createVisitPrep(supabase, user.id, keyResult.masterKey, { text });

  if (!result.success) {
    return reply.status(500).send({ error: result.error, code: result.code });
  }

  return reply.status(201).send(result.visitPrep);
}

/**
 * GET /api/visit-preps
 */
export async function listVisitPreps(request, reply) {
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
    .from(visitPrepsTable)
    .select('*')
    .eq('user_id', user.id)
    .order(sortBy, { ascending: order === 'asc' })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[listVisitPreps] fetch failed:', error);
    return reply.status(500).send({ error: error.message });
  }

  const visitPreps = [];
  for (const row of data) {
    const formatted = formatVisitPrepRow(row, keyResult.masterKey);
    if (!formatted.success) {
      return reply.status(400).send({ error: formatted.error });
    }
    visitPreps.push(formatted.visitPrep);
  }

  return reply.status(200).send(visitPreps);
}

/**
 * GET /api/visit-preps/:id
 */
export async function getVisitPrep(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid visit prep ID format' });
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const { data: row, error } = await supabase
    .from(visitPrepsTable)
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !row) {
    return reply.status(404).send({ error: 'Visit prep not found' });
  }

  const formatted = formatVisitPrepRow(row, keyResult.masterKey);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(200).send(formatted.visitPrep);
}

/**
 * PATCH /api/visit-preps/:id
 */
export async function updateVisitPrep(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid visit prep ID format' });
  }

  const { text } = request.body;

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    return reply.status(500).send({ error: keyResult.error });
  }

  const { data: existing, error: fetchError } = await supabase
    .from(visitPrepsTable)
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchError || !existing) {
    return reply.status(404).send({ error: 'Visit prep not found' });
  }

  const encryptResult = encryptionUtils.encryptNoteText({ text }, keyResult.masterKey);
  if (!encryptResult.success) {
    return reply.status(500).send({ error: encryptResult.error });
  }

  const { data: updated, error: updateError } = await supabase
    .from(visitPrepsTable)
    .update({
      encrypted_text: encryptResult.value,
      text_iv: encryptResult.iv,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    console.error('[updateVisitPrep] update failed:', updateError);
    return reply.status(500).send({ error: updateError.message });
  }

  const formatted = formatVisitPrepRow(updated, keyResult.masterKey, text);
  if (!formatted.success) {
    return reply.status(400).send({ error: formatted.error });
  }

  return reply.status(200).send(formatted.visitPrep);
}

/**
 * DELETE /api/visit-preps/:id
 */
export async function deleteVisitPrep(request, reply) {
  const supabase = getSupabaseClient(request.headers.authorization);
  const user = request.user;
  if (!user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const { id } = request.params;
  if (!isValidUuid(id)) {
    return reply.status(400).send({ error: 'Invalid visit prep ID format' });
  }

  const { data, error } = await supabase
    .from(visitPrepsTable)
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return reply.status(404).send({ error: 'Visit prep not found' });
    }
    console.error('[deleteVisitPrep] delete failed:', error);
    return reply.status(500).send({ error: error.message });
  }

  return reply.status(200).send({ success: true, id: data.id });
}

/**
 * Load visit prep for Nova completion poll (decrypted).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} visitPrepId
 * @param {Buffer} masterKey
 */
export async function loadVisitPrepForPoll(supabase, userId, visitPrepId, masterKey) {
  const { data: row, error } = await supabase
    .from(visitPrepsTable)
    .select('*')
    .eq('id', visitPrepId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !row) {
    return null;
  }

  const formatted = formatVisitPrepRow(row, masterKey);
  if (!formatted.success) {
    return null;
  }

  return formatted.visitPrep;
}
