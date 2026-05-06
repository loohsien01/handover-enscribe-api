#!/usr/bin/env node

/**
 * Re-encrypt transcript bodies with each user's master key (userSecurityConfigs.wrapped_master_key),
 * same crypto as notes: encryptNoteText / decryptNoteText (AES-256-CBC + new IV per update).
 *
 * Flow per row:
 * 1. Read transcript_id from decrypted-transcripts export CSV (or similar).
 * 2. Load user master keys from a userSecurityConfigs CSV snapshot OR from DB (--keys-from-db).
 * 3. Fetch transcript from DB with recording → patientEncounter join (for legacy decrypt).
 * 4. Decrypt plaintext using encounter encrypted_aes_key (transcriptsController-style).
 * 5. Encrypt plaintext with user's unwrapped master key; UPDATE only encrypted_transcript_text, iv, updated_at.
 *
 * Idempotency: if legacy encounter decrypt fails but decrypt with master key succeeds, row is treated as
 * already migrated and skipped (unless --force-reencrypt). So a full re-run after a successful migration
 * does not re-update rows (no need for an exclude list unless you use --force-reencrypt).
 *
 * Avoiding duplicate work on partial runs / capped tests:
 *   - Use --success-log=path on dry-run or real run: writes one transcript id per line (successful decrypt+encrypt path).
 *   - Next run: --exclude-ids-file=that/path to skip those ids (e.g. finish the rest of a CSV after a failure).
 *   - Console always prints the list of successful ids at the end.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RSA_PRIVATE_KEY
 *
 * Usage:
 *   node sql/scripts/transcript-user-master-key-migration/migrate-transcripts-to-user-master-key.js \
 *     --transcripts-csv="sql/scripts/reports/decrypted-transcripts-2026-05-06T16-43-29-227Z.csv" \
 *     --user-security-configs-csv="sql/scripts/reports/userSecurityConfigs_rows_snapshot 6:5:2026 12.45pm.csv"
 *
 *   node sql/scripts/transcript-user-master-key-migration/migrate-transcripts-to-user-master-key.js --transcripts-csv=... --keys-from-db
 *
 *   Dry run: add --dry-run
 *   Limit:   --cap=10
 *   Log ids:  --success-log=sql/scripts/reports/migrate-would-update-ids.txt
 *   Skip ids: --exclude-ids-file=sql/scripts/reports/migrate-would-update-ids.txt
 */

import { createClient } from '@supabase/supabase-js';
import * as encryptionUtils from '../../../src/utils/encryptionUtils.js';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.local');
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function parseArgValue(prefix) {
  const entry = process.argv.find((a) => a.startsWith(prefix));
  if (!entry) return undefined;
  return entry.slice(prefix.length).trim();
}

function parseArgFlag(name) {
  return process.argv.includes(name);
}

function getCap() {
  const raw = parseArgValue('--cap=');
  if (raw === undefined || raw === '' || raw.toLowerCase() === 'null') return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Minimal RFC4180-ish CSV parse (quoted fields, doubled quotes).
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  return rows;
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .replace(/^\ufeff/, '')
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function csvRowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    if (line.every((c) => String(c).trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = line[c] != null ? line[c] : '';
    }
    out.push(obj);
  }
  return out;
}

function loadExcludeIds(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const set = new Set();
  for (const line of text.split(/\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const id = parseInt(s, 10);
    if (Number.isFinite(id)) set.add(id);
  }
  return set;
}

function loadTranscriptIdsFromExportCsv(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const rows = parseCSV(text);
  const objs = csvRowsToObjects(rows);
  const ids = [];
  for (const o of objs) {
    const idRaw = o.transcript_id ?? o.id ?? '';
    const id = parseInt(String(idRaw).trim(), 10);
    if (!Number.isFinite(id)) continue;

    const ds = String(o.decrypt_success ?? 'true').toLowerCase();
    if (ds === 'false' || ds === '0' || ds === 'no') continue;

    ids.push(id);
  }
  return ids;
}

function loadMasterKeysFromUserSecurityCsv(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const rows = parseCSV(text);
  const objs = csvRowsToObjects(rows);
  const map = new Map();

  for (const o of objs) {
    const uid = String(o.user_id ?? o.userid ?? '').trim();
    const wrapped = o.wrapped_master_key ?? o.wrappedmasterkey ?? '';
    if (!uid || uid === 'null' || uid.toLowerCase() === 'undefined') continue;
    if (!wrapped || String(wrapped).trim() === '') continue;

    try {
      const masterKey = encryptionUtils.decryptAESKey(String(wrapped).trim());
      map.set(uid, masterKey);
    } catch (err) {
      console.warn(`Skipping user_id ${uid}: failed to unwrap wrapped_master_key (${err.message})`);
    }
  }
  return map;
}

async function fetchMasterKeyFromDb(supabase, userId) {
  const { data, error } = await supabase
    .from('userSecurityConfigs')
    .select('wrapped_master_key')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`userSecurityConfigs fetch: ${error.message}`);
  if (!data?.wrapped_master_key) return null;
  return encryptionUtils.decryptAESKey(data.wrapped_master_key);
}

async function decryptLegacyTranscriptPlaintext(row) {
  const transcript = {
    id: row.id,
    recording_id: row.recording_id,
    user_id: row.user_id,
    encrypted_transcript_text: row.encrypted_transcript_text,
    iv: row.iv,
    recording: row.recording,
  };

  const encryptedAESKey = transcript.recording?.patientEncounter?.encrypted_aes_key ?? null;
  if (!encryptedAESKey) {
    return { success: false, error: 'missing_encounter_aes_key', plaintext: null };
  }

  const result = await encryptionUtils.decryptField(transcript, 'transcript_text', encryptedAESKey);
  if (!result.success) {
    return { success: false, error: result.error || 'decryptField_failed', plaintext: null };
  }
  return { success: true, error: null, plaintext: transcript.transcript_text ?? '' };
}

function decryptWithMasterKeyRow(row, masterKey) {
  if (!row.encrypted_transcript_text || !row.iv) {
    return { success: true, plaintext: '' };
  }
  const shim = {
    encrypted_text: row.encrypted_transcript_text,
    text_iv: row.iv,
  };
  return encryptionUtils.decryptNoteText(shim, masterKey);
}

async function fetchTranscriptForMigrate(supabase, transcriptId) {
  const { data, error } = await supabase
    .from('transcripts')
    .select(
      `
      id,
      user_id,
      recording_id,
      encrypted_transcript_text,
      iv,
      recording:recording_id (
        id,
        patientEncounter:patientEncounter_id (
          id,
          encrypted_aes_key
        )
      )
    `
    )
    .eq('id', transcriptId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return { row: null, error: 'not_found' };
    return { row: null, error: error.message };
  }
  return { row: data, error: null };
}

async function main() {
  const transcriptsCsv =
    parseArgValue('--transcripts-csv=') || String(process.env.TRANSCRIPTS_EXPORT_CSV || '').trim();
  const userSecCsv =
    parseArgValue('--user-security-configs-csv=') ||
    String(process.env.USER_SECURITY_CONFIGS_CSV || '').trim();
  const keysFromDb = parseArgFlag('--keys-from-db');
  const dryRun = parseArgFlag('--dry-run');
  const forceReencrypt = parseArgFlag('--force-reencrypt');
  const cap = getCap();
  const successLogArg =
    parseArgValue('--success-log=') || String(process.env.MIGRATE_TRANSCRIPTS_SUCCESS_LOG || '').trim();
  const excludeIdsArg =
    parseArgValue('--exclude-ids-file=') ||
    String(process.env.MIGRATE_TRANSCRIPTS_EXCLUDE_IDS_FILE || '').trim();

  if (!transcriptsCsv) {
    console.error('Provide --transcripts-csv=path/to/decrypted-transcripts-....csv');
    process.exit(1);
  }
  if (!keysFromDb && !userSecCsv) {
    console.error('Provide --user-security-configs-csv=... or --keys-from-db');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!process.env.RSA_PRIVATE_KEY) {
    console.error('Missing RSA_PRIVATE_KEY');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let masterKeyByUser = new Map();
  if (!keysFromDb) {
    const secPath = path.isAbsolute(userSecCsv) ? userSecCsv : path.resolve(process.cwd(), userSecCsv);
    masterKeyByUser = loadMasterKeysFromUserSecurityCsv(secPath);
    console.log(`Loaded ${masterKeyByUser.size} user master key(s) from CSV`);
  }

  const trPath = path.isAbsolute(transcriptsCsv)
    ? transcriptsCsv
    : path.resolve(process.cwd(), transcriptsCsv);
  let transcriptIds = loadTranscriptIdsFromExportCsv(trPath);

  if (excludeIdsArg) {
    const exPath = path.isAbsolute(excludeIdsArg)
      ? excludeIdsArg
      : path.resolve(process.cwd(), excludeIdsArg);
    const excludeSet = loadExcludeIds(exPath);
    const before = transcriptIds.length;
    transcriptIds = transcriptIds.filter((id) => !excludeSet.has(id));
    console.log(`Exclude list ${exPath}: skipping ${before - transcriptIds.length} id(s), ${transcriptIds.length} remain`);
  }

  if (cap != null) {
    transcriptIds = transcriptIds.slice(0, cap);
  }

  console.log(`Transcripts to process: ${transcriptIds.length}${cap != null ? ` (cap=${cap})` : ''}`);
  if (dryRun) console.log('DRY RUN — no database updates');

  let updated = 0;
  let wouldUpdate = 0;
  let skipped = 0;
  let skippedAlready = 0;
  let failed = 0;
  /** Ids that completed decrypt+encrypt (dry-run or DB update), for logging / exclude lists */
  const successfulIds = [];

  for (const transcriptId of transcriptIds) {
    const { row, error: fetchErr } = await fetchTranscriptForMigrate(supabase, transcriptId);
    if (fetchErr === 'not_found' || !row) {
      console.warn(`[${transcriptId}] skip: not found`);
      skipped++;
      continue;
    }
    if (fetchErr) {
      console.error(`[${transcriptId}] fetch error: ${fetchErr}`);
      failed++;
      continue;
    }

    const userId = row.user_id;
    if (!userId) {
      console.warn(`[${transcriptId}] skip: missing user_id`);
      skipped++;
      continue;
    }

    let masterKey = masterKeyByUser.get(userId);
    if (!masterKey) {
      if (keysFromDb) {
        try {
          masterKey = await fetchMasterKeyFromDb(supabase, userId);
        } catch (e) {
          console.error(`[${transcriptId}] master key DB error: ${e.message}`);
          failed++;
          continue;
        }
      }
      if (!masterKey) {
        console.warn(`[${transcriptId}] skip: no master key for user ${userId}`);
        skipped++;
        continue;
      }
      masterKeyByUser.set(userId, masterKey);
    }

    const legacy = await decryptLegacyTranscriptPlaintext(row);
    let plaintext = null;

    if (legacy.success) {
      plaintext = legacy.plaintext;
    } else {
      const masterDec = decryptWithMasterKeyRow(row, masterKey);
      if (masterDec.success && !forceReencrypt) {
        console.log(`[${transcriptId}] already master-key encrypted — skip`);
        skippedAlready++;
        continue;
      }
      if (!masterDec.success) {
        console.error(`[${transcriptId}] decrypt failed (legacy: ${legacy.error}, master: ${masterDec.error})`);
        failed++;
        continue;
      }
      plaintext = masterDec.text ?? '';
    }

    const notePayload = { text: plaintext };
    const enc = encryptionUtils.encryptNoteText(notePayload, masterKey);
    if (!enc.success) {
      console.error(`[${transcriptId}] encrypt failed: ${enc.error}`);
      failed++;
      continue;
    }

    const nextCipher = enc.value;
    const nextIv = enc.iv;

    if (dryRun) {
      console.log(
        `[${transcriptId}] dry-run OK user=${userId} plaintext_len=${plaintext != null ? plaintext.length : 0}`
      );
      successfulIds.push(transcriptId);
      wouldUpdate++;
      continue;
    }

    const { error: upErr } = await supabase
      .from('transcripts')
      .update({
        encrypted_transcript_text: nextCipher,
        iv: nextIv,
        updated_at: new Date().toISOString(),
      })
      .eq('id', transcriptId);

    if (upErr) {
      console.error(`[${transcriptId}] update failed: ${upErr.message}`);
      failed++;
      continue;
    }

    console.log(`[${transcriptId}] updated`);
    successfulIds.push(transcriptId);
    updated++;
  }

  console.log('\nDone.');
  if (dryRun) {
    console.log(`  would update: ${wouldUpdate}`);
  } else {
    console.log(`  updated: ${updated}`);
  }
  console.log(`  skipped (not found / no key / decrypt_success=false in csv): ${skipped}`);
  console.log(`  skipped (already master-key): ${skippedAlready}`);
  console.log(`  failed: ${failed}`);

  if (successfulIds.length > 0) {
    const label = dryRun ? 'Dry-run (would update)' : 'Updated';
    console.log(`\n${label} transcript IDs (${successfulIds.length}):`);
    console.log(successfulIds.join(', '));
  } else {
    console.log(`\nNo successful ${dryRun ? 'dry-run' : 'update'} ids this run.`);
  }

  if (successLogArg) {
    const logPath = path.isAbsolute(successLogArg)
      ? successLogArg
      : path.resolve(process.cwd(), successLogArg);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, successfulIds.map(String).join('\n') + (successfulIds.length ? '\n' : ''), 'utf-8');
    console.log(`\nWrote ${successfulIds.length} id(s) to ${logPath} (use with --exclude-ids-file=... on a later run)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
