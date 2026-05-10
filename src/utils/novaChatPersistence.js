/**
 * Supabase persistence for Nova chat: encrypt message/summary fields with the user's
 * wrapped master key (same AES pattern as notes).
 */
import * as encryptionUtils from './encryptionUtils.js';
import { createEmptyNovaSession, normalizeNovaSessionShape } from './novaRedisSession.js';

export const chatSessionsTable = 'chat_sessions';
export const chatMessagesTable = 'chat_messages';
export const chatTokenUsageTable = 'chat_token_usage';

/**
 * @param {string | null | undefined} plain
 * @param {Buffer} masterKey
 * @returns {{ encrypted: string | null, iv: string | null, error?: string }}
 */
export function encryptUtf8Field(plain, masterKey) {
  if (plain == null || plain === '') {
    return { encrypted: null, iv: null };
  }
  const enc = encryptionUtils.encryptNoteText({ text: plain }, masterKey);
  if (!enc.success) {
    return { encrypted: null, iv: null, error: enc.error || 'encrypt failed' };
  }
  return { encrypted: enc.value, iv: enc.iv };
}

/**
 * @param {string | null | undefined} encrypted
 * @param {string | null | undefined} iv
 * @param {Buffer} masterKey
 * @returns {{ text: string, error?: string }}
 */
export function decryptUtf8Field(encrypted, iv, masterKey) {
  if (!encrypted || !iv) {
    return { text: '' };
  }
  const dec = encryptionUtils.decryptNoteText(
    { encrypted_text: encrypted, text_iv: iv },
    masterKey
  );
  if (!dec.success) {
    return { text: '', error: dec.error || 'decrypt failed' };
  }
  return { text: dec.text ?? '' };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} chatId
 * @param {Buffer} masterKey
 * @returns {Promise<{ session: import('./novaRedisSession.js').NovaChatSession, organizationId: string } | null>}
 */
export async function loadNovaChatSessionFromSupabase(supabase, userId, chatId, masterKey) {
  const { data: row, error } = await supabase
    .from(chatSessionsTable)
    .select('*')
    .eq('id', chatId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !row) {
    return null;
  }

  const { data: msgRows, error: msgErr } = await supabase
    .from(chatMessagesTable)
    .select('role, encrypted_content, content_iv, sort_order')
    .eq('chat_id', chatId)
    .order('sort_order', { ascending: true });

  if (msgErr) {
    console.error('[novaChatPersistence] load messages:', msgErr);
    return null;
  }

  const messages = [];
  for (const m of msgRows || []) {
    const dec = decryptUtf8Field(m.encrypted_content, m.content_iv, masterKey);
    if (dec.error) {
      console.error('[novaChatPersistence] decrypt message failed:', dec.error);
      return null;
    }
    messages.push({ role: m.role, content: dec.text });
  }

  const sumDec = decryptUtf8Field(row.encrypted_summary, row.summary_iv, masterKey);
  if (sumDec.error) {
    console.error('[novaChatPersistence] decrypt summary failed:', sumDec.error);
    return null;
  }

  const lastActiveSec = row.last_active_at
    ? Math.floor(new Date(row.last_active_at).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const sumStr = (sumDec.text ?? '').trim();
  const session = normalizeNovaSessionShape({
    chat_id: row.id,
    messages,
    summary: sumDec.text ?? '',
    token_estimate: row.token_estimate ?? 0,
    last_active: lastActiveSec,
    summary_covered_message_count: sumStr ? messages.length : 0,
    summarize_pending: false,
  });

  return { session, organizationId: row.organization_id };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ chatId: string, userId: string, organizationId: string }} ids
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function insertChatSessionRow(supabase, ids) {
  const { error } = await supabase.from(chatSessionsTable).insert({
    id: ids.chatId,
    user_id: ids.userId,
    organization_id: ids.organizationId,
    encrypted_summary: null,
    summary_iv: null,
    token_estimate: 0,
    total_tokens: 0,
    last_active_at: new Date().toISOString(),
  });

  if (error) {
    console.error('[novaChatPersistence] insert session:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} args
 * @param {string} args.chatId
 * @param {string} args.userId
 * @param {import('./novaRedisSession.js').NovaChatSession} args.session
 * @param {Buffer} args.masterKey
 * @param {'none' | 'full' | 'append'} args.messageSync
 * @param {Array<{ role: string, content: string }> | undefined} args.appendedMessages
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function persistNovaChatSession(supabase, args) {
  const { chatId, userId, session, masterKey, messageSync, appendedMessages } = args;

  const { encrypted: encSummary, iv: ivSummary, error: sumErr } = encryptUtf8Field(
    session.summary ?? '',
    masterKey
  );
  if (sumErr) {
    return { success: false, error: sumErr };
  }

  const { error: upErr } = await supabase
    .from(chatSessionsTable)
    .update({
      encrypted_summary: encSummary,
      summary_iv: ivSummary,
      token_estimate: session.token_estimate ?? 0,
      last_active_at: new Date().toISOString(),
    })
    .eq('id', chatId)
    .eq('user_id', userId);

  if (upErr) {
    console.error('[novaChatPersistence] update session:', upErr);
    return { success: false, error: upErr.message };
  }

  if (messageSync === 'full') {
    const { error: delErr } = await supabase.from(chatMessagesTable).delete().eq('chat_id', chatId);
    if (delErr) {
      console.error('[novaChatPersistence] delete messages:', delErr);
      return { success: false, error: delErr.message };
    }

    const rows = [];
    let i = 0;
    for (const m of session.messages || []) {
      const { encrypted, iv, error: eErr } = encryptUtf8Field(m.content, masterKey);
      if (eErr) {
        return { success: false, error: eErr };
      }
      rows.push({
        chat_id: chatId,
        user_id: userId,
        role: m.role,
        encrypted_content: encrypted,
        content_iv: iv,
        sort_order: i,
      });
      i += 1;
    }

    if (rows.length > 0) {
      const { error: insErr } = await supabase.from(chatMessagesTable).insert(rows);
      if (insErr) {
        console.error('[novaChatPersistence] insert messages:', insErr);
        return { success: false, error: insErr.message };
      }
    }
  } else if (messageSync === 'append' && appendedMessages?.length) {
    const { data: maxRow } = await supabase
      .from(chatMessagesTable)
      .select('sort_order')
      .eq('chat_id', chatId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    let order = (maxRow?.sort_order ?? -1) + 1;
    const rows = [];
    for (const m of appendedMessages) {
      const { encrypted, iv, error: eErr } = encryptUtf8Field(m.content, masterKey);
      if (eErr) {
        return { success: false, error: eErr };
      }
      rows.push({
        chat_id: chatId,
        user_id: userId,
        role: m.role,
        encrypted_content: encrypted,
        content_iv: iv,
        sort_order: order,
      });
      order += 1;
    }

    const { error: insErr } = await supabase.from(chatMessagesTable).insert(rows);
    if (insErr) {
      console.error('[novaChatPersistence] append messages:', insErr);
      return { success: false, error: insErr.message };
    }
  }

  return { success: true };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} args
 * @returns {Promise<{ success: boolean, error?: string, total_tokens?: number }>}
 */
export async function insertChatTokenUsageRow(supabase, args) {
  const {
    chatId,
    userId,
    organizationId,
    input_tokens,
    output_tokens,
    model,
    cost_usd,
  } = args;
  const total_tokens = input_tokens + output_tokens;

  const { error: insErr } = await supabase.from(chatTokenUsageTable).insert({
    chat_id: chatId,
    user_id: userId,
    organization_id: organizationId,
    input_tokens,
    output_tokens,
    total_tokens,
    model: model ?? null,
    cost_usd: cost_usd ?? null,
  });

  if (insErr) {
    console.error('[novaChatPersistence] token usage insert:', insErr);
    return { success: false, error: insErr.message };
  }

  const { data: sess, error: selErr } = await supabase
    .from(chatSessionsTable)
    .select('total_tokens')
    .eq('id', chatId)
    .eq('user_id', userId)
    .single();

  if (selErr || !sess) {
    return { success: true, total_tokens };
  }

  const nextTotal = Number(sess.total_tokens ?? 0) + total_tokens;
  const { error: upErr } = await supabase
    .from(chatSessionsTable)
    .update({ total_tokens: nextTotal })
    .eq('id', chatId)
    .eq('user_id', userId);

  if (upErr) {
    console.error('[novaChatPersistence] session total_tokens update:', upErr);
    return { success: false, error: upErr.message };
  }

  return { success: true, total_tokens };
}
