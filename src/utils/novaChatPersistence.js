/**
 * Postgres persistence for Nova chat: encrypt message/summary fields with the user's
 * wrapped master key (same AES pattern as notes).
 */
import * as encryptionUtils from './encryptionUtils.js';
import { createEmptyNovaSession, normalizeNovaSessionShape } from './novaRedisSession.js';
import { NOVA_CHAT_DEFAULT_TITLE } from './novaChatTitle.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
  isPgUniqueViolation,
  toPgJsonbParam,
} from './pgQueryHelpers.js';

export const chatSessionsTable = 'chat_sessions';
export const chatMessagesTable = 'chat_messages';
export const chatTokenUsageTable = 'chat_token_usage';
export const novaChatCompletionJobsTable = 'nova_chat_completion_jobs';
export const preVisitSummariesTable = 'pre_visit_summaries';

/** @typedef {'exclude' | 'include' | 'only'} PreVisitSummaryListFilter */

/**
 * Resolve Nova chat list filter from query flags (default: exclude linked pre-visit summaries).
 *
 * @param {{ includePreVisitSummary?: boolean, onlyPreVisitSummary?: boolean }} opts
 * @returns {PreVisitSummaryListFilter}
 */
export function resolvePreVisitSummaryListFilter(opts) {
  if (opts.onlyPreVisitSummary) return 'only';
  if (opts.includePreVisitSummary) return 'include';
  return 'exclude';
}

/**
 * SQL fragment for filtering chat_sessions by linked pre_visit_summaries rows.
 *
 * @param {PreVisitSummaryListFilter} mode
 * @returns {string}
 */
export function preVisitSummaryFilterWhereClause(mode) {
  if (mode === 'include') return '';
  if (mode === 'only') {
    return `AND EXISTS (
      SELECT 1 FROM ${preVisitSummariesTable} p
       WHERE p.chat_id = ${chatSessionsTable}.id
    )`;
  }
  return `AND NOT EXISTS (
    SELECT 1 FROM ${preVisitSummariesTable} p
     WHERE p.chat_id = ${chatSessionsTable}.id
  )`;
}

const CHAT_SESSION_SORT_COLUMNS = new Set(['last_active_at', 'created_at', 'updated_at']);

function chatSessionOrderClause(sortBy, order) {
  const column = CHAT_SESSION_SORT_COLUMNS.has(sortBy) ? sortBy : 'last_active_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${direction}`;
}

/**
 * @param {Array<{
 *   chat_id: string,
 *   user_id: string,
 *   role: string,
 *   encrypted_content: string | null,
 *   content_iv: string | null,
 *   sort_order: number,
 * }>} rows
 */
async function insertChatMessagesBatch(rows) {
  if (!rows.length) return;

  const valueChunks = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    valueChunks.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`
    );
    params.push(
      row.chat_id,
      row.user_id,
      row.role,
      row.encrypted_content,
      row.content_iv,
      row.sort_order
    );
    idx += 6;
  }

  await querySupabasePostgres(
    `INSERT INTO ${chatMessagesTable}
       (chat_id, user_id, role, encrypted_content, content_iv, sort_order)
     VALUES ${valueChunks.join(', ')}`,
    params
  );
}

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
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {string} userId
 * @param {string} chatId
 * @param {Buffer} masterKey
 * @returns {Promise<{ session: import('./novaRedisSession.js').NovaChatSession, organizationId: string } | null>}
 */
export async function loadNovaChatSessionFromSupabase(_supabase, userId, chatId, masterKey) {
  const row = await pgQueryOne(
    `SELECT *
       FROM ${chatSessionsTable}
      WHERE id = $1 AND user_id = $2`,
    [chatId, userId]
  );

  if (!row) {
    return null;
  }

  const msgRows = await pgQueryRows(
    `SELECT role, encrypted_content, content_iv, sort_order
       FROM ${chatMessagesTable}
      WHERE chat_id = $1
      ORDER BY sort_order ASC`,
    [chatId]
  );

  const messages = [];
  for (const m of msgRows) {
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
    title: row.title ?? NOVA_CHAT_DEFAULT_TITLE,
    token_estimate: row.token_estimate ?? 0,
    last_active: lastActiveSec,
    summary_covered_message_count: sumStr ? messages.length : 0,
    summarize_pending: false,
  });

  return { session, organizationId: row.organization_id };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {{ chatId: string, userId: string, organizationId: string, title?: string }} ids
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function insertChatSessionRow(_supabase, ids) {
  try {
    await querySupabasePostgres(
      `INSERT INTO ${chatSessionsTable}
         (id, user_id, organization_id, title, encrypted_summary, summary_iv, token_estimate, total_tokens, last_active_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, 0, 0, $5)`,
      [
        ids.chatId,
        ids.userId,
        ids.organizationId,
        ids.title ?? NOVA_CHAT_DEFAULT_TITLE,
        new Date().toISOString(),
      ]
    );
    return { success: true };
  } catch (err) {
    console.error('[novaChatPersistence] insert session:', err);
    return { success: false, error: pgErrorMessage(err) };
  }
}

/**
 * List chat session rows for the current user (metadata only; no encrypted summary/messages).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {string} userId
 * @param {{ limit: number, offset: number, sortBy: 'last_active_at' | 'created_at' | 'updated_at', order: 'asc' | 'desc', preVisitSummaryFilter?: PreVisitSummaryListFilter }} opts
 * @returns {Promise<{ success: true, sessions: Array<{ chatId: string, organizationId: string, title: string, token_estimate: number, total_tokens: number, created_at: string, updated_at: string, last_active_at: string }>, total: number } | { success: false, error: string }>}
 */
export async function listChatSessionsForUser(_supabase, userId, opts) {
  const { limit, offset, sortBy, order } = opts;
  const preVisitSummaryFilter = opts.preVisitSummaryFilter ?? 'exclude';
  const orderClause = chatSessionOrderClause(sortBy, order);
  const preVisitFilterSql = preVisitSummaryFilterWhereClause(preVisitSummaryFilter);

  try {
    const countRow = await pgQueryOne(
      `SELECT COUNT(*)::int AS count
         FROM ${chatSessionsTable}
        WHERE user_id = $1
          ${preVisitFilterSql}`,
      [userId]
    );
    const total = countRow?.count ?? 0;

    const data = await pgQueryRows(
      `SELECT id, organization_id, title, token_estimate, total_tokens, created_at, updated_at, last_active_at
         FROM ${chatSessionsTable}
        WHERE user_id = $1
          ${preVisitFilterSql}
        ORDER BY ${orderClause}
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const sessions = data.map((row) => ({
      chatId: row.id,
      organizationId: row.organization_id,
      title: row.title ?? NOVA_CHAT_DEFAULT_TITLE,
      token_estimate: row.token_estimate ?? 0,
      total_tokens:
        typeof row.total_tokens === 'string' ? Number(row.total_tokens) : row.total_tokens ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_active_at: row.last_active_at,
    }));

    return { success: true, sessions, total };
  } catch (err) {
    console.error('[novaChatPersistence] list sessions:', err);
    return { success: false, error: pgErrorMessage(err) };
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {object} args
 * @param {string} args.chatId
 * @param {string} args.userId
 * @param {import('./novaRedisSession.js').NovaChatSession} args.session
 * @param {Buffer} args.masterKey
 * @param {'none' | 'full' | 'append'} args.messageSync
 * @param {Array<{ role: string, content: string }> | undefined} args.appendedMessages
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function persistNovaChatSession(_supabase, args) {
  const { chatId, userId, session, masterKey, messageSync, appendedMessages } = args;

  const { encrypted: encSummary, iv: ivSummary, error: sumErr } = encryptUtf8Field(
    session.summary ?? '',
    masterKey
  );
  if (sumErr) {
    return { success: false, error: sumErr };
  }

  try {
    const { rowCount } = await querySupabasePostgres(
      `UPDATE ${chatSessionsTable}
          SET encrypted_summary = $3,
              summary_iv = $4,
              token_estimate = $5,
              title = $6,
              last_active_at = $7
        WHERE id = $1 AND user_id = $2`,
      [
        chatId,
        userId,
        encSummary,
        ivSummary,
        session.token_estimate ?? 0,
        session.title ?? NOVA_CHAT_DEFAULT_TITLE,
        new Date().toISOString(),
      ]
    );

    if (!rowCount) {
      return { success: false, error: 'Chat session not found' };
    }

    if (messageSync === 'full') {
      await querySupabasePostgres(`DELETE FROM ${chatMessagesTable} WHERE chat_id = $1`, [chatId]);

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

      await insertChatMessagesBatch(rows);
    } else if (messageSync === 'append' && appendedMessages?.length) {
      const maxRow = await pgQueryOne(
        `SELECT sort_order
           FROM ${chatMessagesTable}
          WHERE chat_id = $1
          ORDER BY sort_order DESC
          LIMIT 1`,
        [chatId]
      );

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

      await insertChatMessagesBatch(rows);
    }

    return { success: true };
  } catch (err) {
    console.error('[novaChatPersistence] persist session:', err);
    return { success: false, error: pgErrorMessage(err) };
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {object} args
 * @returns {Promise<{ success: boolean, error?: string, total_tokens?: number }>}
 */
export async function insertChatTokenUsageRow(_supabase, args) {
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

  try {
    await querySupabasePostgres(
      `INSERT INTO ${chatTokenUsageTable}
         (chat_id, user_id, organization_id, input_tokens, output_tokens, total_tokens, model, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        chatId,
        userId,
        organizationId,
        input_tokens,
        output_tokens,
        total_tokens,
        model ?? null,
        cost_usd ?? null,
      ]
    );

    const sess = await pgQueryOne(
      `SELECT total_tokens
         FROM ${chatSessionsTable}
        WHERE id = $1 AND user_id = $2`,
      [chatId, userId]
    );

    if (!sess) {
      return { success: true, total_tokens };
    }

    const nextTotal = Number(sess.total_tokens ?? 0) + total_tokens;
    await querySupabasePostgres(
      `UPDATE ${chatSessionsTable}
          SET total_tokens = $3
        WHERE id = $1 AND user_id = $2`,
      [chatId, userId, nextTotal]
    );

    return { success: true, total_tokens };
  } catch (err) {
    console.error('[novaChatPersistence] token usage insert:', err);
    return { success: false, error: pgErrorMessage(err) };
  }
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<string | null>}
 */
export async function loadChatSessionOrganizationId(userId, chatId) {
  const row = await pgQueryOne(
    `SELECT organization_id
       FROM ${chatSessionsTable}
      WHERE id = $1 AND user_id = $2`,
    [chatId, userId]
  );
  return row?.organization_id ?? null;
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<boolean>}
 */
export async function chatSessionExistsForUser(userId, chatId) {
  const row = await pgQueryOne(
    `SELECT id
       FROM ${chatSessionsTable}
      WHERE id = $1 AND user_id = $2`,
    [chatId, userId]
  );
  return Boolean(row);
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<string | null>}
 */
export async function loadChatSessionTitle(userId, chatId) {
  const row = await pgQueryOne(
    `SELECT title
       FROM ${chatSessionsTable}
      WHERE id = $1 AND user_id = $2`,
    [chatId, userId]
  );
  return row?.title ?? null;
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @param {string} status
 * @returns {Promise<number>}
 */
export async function countNovaCompletionJobsByStatus(userId, chatId, status) {
  const row = await pgQueryOne(
    `SELECT COUNT(*)::int AS count
       FROM ${novaChatCompletionJobsTable}
      WHERE chat_id = $1 AND user_id = $2 AND status = $3`,
    [chatId, userId, status]
  );
  return row?.count ?? 0;
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<number>}
 */
export async function countNovaPreVisitPersistFailedJobs(userId, chatId) {
  const row = await pgQueryOne(
    `SELECT COUNT(*)::int AS count
       FROM ${novaChatCompletionJobsTable}
      WHERE chat_id = $1 AND user_id = $2 AND status = 'failed' AND error_code = 'PRE_VISIT_SUMMARY_PERSIST_FAILED'`,
    [chatId, userId]
  );
  return row?.count ?? 0;
}

/**
 * @param {string} userId
 * @param {string} jobId
 * @param {Record<string, unknown>} patch
 */
export async function updateNovaCompletionJob(userId, jobId, patch) {
  const allowed = [
    'status',
    'started_at',
    'completed_at',
    'error_code',
    'error_message',
    'usage',
    'pre_visit_summary_id',
  ];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;

  const sets = entries.map(([key], i) => `${key} = $${i + 3}`);
  const params = [jobId, userId];
  for (const [key, value] of entries) {
    params.push(key === 'usage' ? toPgJsonbParam(value) : value);
  }

  try {
    await querySupabasePostgres(
      `UPDATE ${novaChatCompletionJobsTable}
          SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $2`,
      params
    );
  } catch (err) {
    console.error(`[novaChatPersistence] update completion job ${jobId}:`, err);
  }
}

/**
 * @param {string} userId
 * @param {string} jobId
 * @returns {Promise<{ id: string, model: string } | null>}
 */
export async function claimNovaCompletionJob(userId, jobId) {
  try {
    const row = await pgQueryOne(
      `UPDATE ${novaChatCompletionJobsTable}
          SET status = 'running',
              started_at = $3
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING id, model`,
      [jobId, userId, new Date().toISOString()]
    );
    return row;
  } catch (err) {
    console.error(`[novaChatPersistence] claim completion job ${jobId}:`, err);
    return null;
  }
}

/**
 * @param {string} userId
 * @param {string} jobId
 */
export async function deleteNovaCompletionJob(userId, jobId) {
  try {
    await querySupabasePostgres(
      `DELETE FROM ${novaChatCompletionJobsTable} WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
  } catch (err) {
    console.error(`[novaChatPersistence] delete completion job ${jobId}:`, err);
  }
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @param {string} model
 * @param {string} clientMessageId
 * @returns {Promise<{ id: string } | { error: import('pg').DatabaseError }>}
 */
export async function insertNovaCompletionJob(userId, chatId, model, clientMessageId) {
  try {
    const row = await pgQueryOne(
      `INSERT INTO ${novaChatCompletionJobsTable}
         (user_id, chat_id, client_message_id, model, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [userId, chatId, clientMessageId, model]
    );
    return { id: row.id };
  } catch (err) {
    return { error: err };
  }
}

export { isPgUniqueViolation };
