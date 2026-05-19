#!/usr/bin/env node

/**
 * Run an arbitrary SQL SELECT against Supabase Postgres, decrypt chosen ciphertext columns
 * with a user's unwrapped master key (same crypto as notes: decryptNoteText), write CSV.
 *
 * Configure at top of this file:
 *   - USER_EMAIL
 *   - SQL_QUERY (optional placeholder {{USER_ID}} → resolved auth user uuid)
 *   - COLS_TO_DECRYPT — [{ ciphertext, iv, outputKey? }] — default outputKey is `decrypted_<ciphertext>`
 *
 * Requires:
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (user id fallback + userSecurityConfigs)
 *   - RSA_PRIVATE_KEY (unwrap wrapped_master_key)
 *   - Postgres URL for raw SQL: SUPABASE_DB_DIRECT_URL (or DATABASE_URL / see supabasePostgresUrl.js)
 *
 * Usage:
 *   node sql/scripts/export-and-decrypt-by-user/export-and-decrypt-by-user.js
 */

import { createClient } from '@supabase/supabase-js';
import * as encryptionUtils from '../../../src/utils/encryptionUtils.js';
import { querySupabasePostgres, closeSupabasePostgresPool } from '../../../src/utils/supabasePostgresPool.js';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../../.env.local');
dotenv.config({ path: envPath });

// ---------------------------------------------------------------------------
// Edit these for your export
// ---------------------------------------------------------------------------

const USER_EMAIL = 'natfabi456@gmail.com';

/**
 * Raw SQL (SELECT only). If it contains `{{USER_ID}}`, it is replaced with the UUID
 * resolved from USER_EMAIL (must be a valid uuid after resolution).
 */
const SQL_QUERY = `
SELECT
    pol.polname AS policyname,
    pol.polcmd::text AS command,
    pg_get_expr(pol.polqual, pol.polrelid) AS using_clause,
    pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_clause,
    pol.polpermissive AS permissive
FROM pg_policy pol
JOIN pg_class cls
    ON cls.oid = pol.polrelid
JOIN pg_namespace nsp
    ON nsp.oid = cls.relnamespace
WHERE nsp.nspname = 'public'
  AND cls.relname = 'noteTemplateSections'
  AND pol.polname IN (
      'Users can delete their own sections',
      'Users can insert their own sections',
      'Users can update their own sections',
      'Users can view their own and system sections'
  );
`;

/**
 * Columns on each row that were encrypted with the user's master key (note-style).
 * ciphertext + iv column names must exist on the query result rows.
 */
const COLS_TO_DECRYPT = [
  {
    ciphertext: 'encrypted_trigger',
    iv: 'iv',
    // outputKey optional — defaults to decrypted_<ciphertext>, e.g. decrypted_encrypted_transcript_text
  },
];

// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Default CSV column for decrypted plaintext: `decrypted_` + original ciphertext column name. */
function defaultOutputKey(ciphertext) {
  return `decrypted_${ciphertext}`;
}

function objectArrayToCSV(data) {
  if (!data || data.length === 0) return '';

  const keys = Object.keys(data[0]);
  const header = keys.map((k) => `"${k}"`).join(',');
  const rows = data.map((row) =>
    keys
      .map((k) => {
        const val = row[k];
        if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
          return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        }
        if (typeof val === 'string') {
          return `"${val.replace(/"/g, '""')}"`;
        }
        if (val instanceof Date) {
          return `"${val.toISOString()}"`;
        }
        return val === null || val === undefined ? '' : `"${String(val)}"`;
      })
      .join(',')
  );

  return [header, ...rows].join('\n');
}

/**
 * @param {string} email
 * @returns {Promise<string | null>}
 */
async function getUserIdByEmailFromAuthUsers(email) {
  const { rows } = await querySupabasePostgres(
    'SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1',
    [email.trim()]
  );
  const id = rows[0]?.id;
  return id ? String(id) : null;
}

/**
 * Slow fallback if direct Postgres to auth.users is unavailable.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} email
 */
async function getUserIdByEmailAdminList(supabase, email) {
  const target = email.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`auth.admin.listUsers: ${error.message}`);
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit?.id) return String(hit.id);
    if (users.length < perPage) return null;
    page += 1;
    if (page > 50) {
      console.warn('listUsers fallback stopped after 50 pages; use Postgres URL for precise lookup.');
      return null;
    }
  }
}

/** @param {string} userId */
function assertUuid(userId) {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Resolved user id is not a valid UUID: ${userId}`);
  }
}

/**
 * @param {string} sql
 * @param {string} userId
 */
function applyUserIdPlaceholder(sql, userId) {
  if (!sql.includes('{{USER_ID}}')) return sql;
  assertUuid(userId);
  return sql.split('{{USER_ID}}').join(userId);
}

/**
 * @param {Record<string, unknown>} row
 * @param {Buffer} masterKey
 * @param {{ ciphertext: string; iv: string; outputKey?: string }} spec
 */
function decryptColumnPair(row, masterKey, spec) {
  const outKey = spec.outputKey || defaultOutputKey(spec.ciphertext);
  const ct = row[spec.ciphertext];
  const iv = row[spec.iv];
  const ctStr = ct == null || ct === '' ? '' : String(ct);
  const ivStr = iv == null || iv === '' ? '' : String(iv);

  if (!ctStr && !ivStr) {
    return { outputKey: outKey, plaintext: '', error: '' };
  }
  if (!ctStr || !ivStr) {
    return {
      outputKey: outKey,
      plaintext: '',
      error: 'missing_ciphertext_or_iv',
    };
  }

  const shim = { encrypted_text: ctStr, text_iv: ivStr };
  const result = encryptionUtils.decryptNoteText(shim, masterKey);
  if (!result.success) {
    return { outputKey: outKey, plaintext: '', error: result.error || 'decrypt_failed' };
  }
  return { outputKey: outKey, plaintext: result.text ?? '', error: '' };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Buffer>}
 */
async function unwrapUserMasterKey(supabase, userId) {
  const { data, error } = await supabase
    .from('userSecurityConfigs')
    .select('wrapped_master_key')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`userSecurityConfigs: ${error.message}`);
  if (!data?.wrapped_master_key) {
    throw new Error('No wrapped_master_key for this user (userSecurityConfigs row missing?)');
  }
  return encryptionUtils.decryptAESKey(data.wrapped_master_key);
}

async function main() {
  if (!USER_EMAIL || USER_EMAIL === 'change-me@example.com') {
    console.error('Set USER_EMAIL at the top of export-and-decrypt-by-user.js');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!process.env.RSA_PRIVATE_KEY) {
    console.error('Missing RSA_PRIVATE_KEY (required to unwrap user master key)');
    process.exit(1);
  }
  if (!COLS_TO_DECRYPT.length) {
    console.error('COLS_TO_DECRYPT is empty; add at least one { ciphertext, iv } entry.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let userId;
  try {
    userId = await getUserIdByEmailFromAuthUsers(USER_EMAIL);
  } catch (err) {
    console.warn(`auth.users lookup via Postgres failed (${err.message}); trying auth.admin.listUsers…`);
    userId = null;
  }
  if (!userId) {
    userId = await getUserIdByEmailAdminList(supabase, USER_EMAIL);
  }
  if (!userId) {
    console.error(`No auth user found for email: ${USER_EMAIL}`);
    process.exit(1);
  }
  assertUuid(userId);
  console.log(`Resolved user id: ${userId}`);

  const masterKey = await unwrapUserMasterKey(supabase, userId);
  console.log('Unwrapped user master key.');

  const sqlFinal = applyUserIdPlaceholder(SQL_QUERY.trim(), userId);
  const { rows } = await querySupabasePostgres(sqlFinal);
  console.log(`Query returned ${rows.length} row(s).`);

  const outRows = [];
  for (const row of rows) {
    /** @type {Record<string, unknown>} */
    const flat = { ...row };
    for (const k of Object.keys(flat)) {
      const v = flat[k];
      if (typeof v === 'bigint') flat[k] = v.toString();
    }

    for (const spec of COLS_TO_DECRYPT) {
      const { outputKey, plaintext, error } = decryptColumnPair(flat, masterKey, spec);
      flat[outputKey] = plaintext;
      flat[`${outputKey}_decrypt_error`] = error;
    }
    outRows.push(flat);
  }

  const reportsDir = path.join(__dirname, '..', 'reports', 'export-and-decrypt-by-user');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeEmail = USER_EMAIL.replace(/[^a-z0-9@._+-]+/gi, '_');
  const outPath = path.join(reportsDir, `export-decrypt-${safeEmail}-${stamp}.csv`);
  writeFileSync(outPath, objectArrayToCSV(outRows), 'utf-8');
  console.log(`Wrote: ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await closeSupabasePostgresPool().catch(() => {});
  });
