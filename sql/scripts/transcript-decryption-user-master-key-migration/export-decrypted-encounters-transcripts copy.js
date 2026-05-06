#!/usr/bin/env node

/**
 * Export decrypted patient encounter names and transcript text to CSV under sql/scripts/reports/
 * (shared with other sql tooling). Part of transcript → user master key migration; pair with
 * migrate-transcripts-to-user-master-key.js in this folder.
 * Decryption matches API logic: transcriptsController (decryptField + encounter encrypted_aes_key),
 * patientEncountersController (decryptAESKey + decryptText for name).
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RSA_PRIVATE_KEY (same as encryptionUtils.decryptAESKey).
 *
 * Transcript limit for smoke tests:
 *   - Default: no cap (full export, paginated).
 *   - Edit TRANSCRIPTS_CAP below, or run: EXPORT_TRANSCRIPTS_CAP=10 node sql/scripts/transcript-user-master-key-migration/export-decrypted-encounters-transcripts.js
 *   - Or: node sql/scripts/transcript-user-master-key-migration/export-decrypted-encounters-transcripts.js --cap=10
 *   - --cap=null clears override when using env in shell — use explicit full export by omitting --cap.
 *
 * Usage:
 *   node sql/scripts/transcript-user-master-key-migration/export-decrypted-encounters-transcripts.js
 *   node sql/scripts/transcript-user-master-key-migration/export-decrypted-encounters-transcripts.js --cap=10
 */

import { createClient } from '@supabase/supabase-js';
import * as encryptionUtils from '../../../src/utils/encryptionUtils.js';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.local');
dotenv.config({ path: envPath });

/** Max transcripts to fetch (null = all). Overridable via EXPORT_TRANSCRIPTS_CAP or --cap=N */
const TRANSCRIPTS_CAP = null;

const PAGE_SIZE = 500;
const BATCH_SIZE = 10;
const PREVIEW_LEN = 200;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getTranscriptCap() {
  const capFlag = process.argv.find((a) => a.startsWith('--cap='));
  if (capFlag !== undefined) {
    const raw = capFlag.slice('--cap='.length).trim();
    if (raw === '' || raw.toLowerCase() === 'null') return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.warn('Invalid --cap value; exporting all transcripts (paginated).');
      return null;
    }
    return n;
  }
  if (process.env.EXPORT_TRANSCRIPTS_CAP != null && String(process.env.EXPORT_TRANSCRIPTS_CAP).trim() !== '') {
    const n = parseInt(process.env.EXPORT_TRANSCRIPTS_CAP, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return TRANSCRIPTS_CAP;
}

function objectArrayToCSV(data) {
  if (!data || data.length === 0) return '';

  const keys = Object.keys(data[0]);
  const header = keys.map((k) => `"${k}"`).join(',');
  const rows = data.map((row) =>
    keys
      .map((k) => {
        const val = row[k];
        if (typeof val === 'string') {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val === null || val === undefined ? '' : `"${String(val)}"`;
      })
      .join(',')
  );

  return [header, ...rows].join('\n');
}

function previewText(text, maxLen = PREVIEW_LEN) {
  if (text == null) return '';
  const s = String(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

/**
 * Lightweight check that plaintext looks like readable text (not exhaustive).
 */
function plaintextHeuristic(text) {
  if (text == null || text === '') {
    return { ok: true, detail: 'empty' };
  }
  if (text.includes('\uFFFD')) {
    return { ok: false, detail: 'replacement_char' };
  }
  let printable = 0;
  for (const c of text) {
    const cp = c.codePointAt(0);
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp !== 0x7f)) {
      printable++;
    }
  }
  const ratio = printable / text.length;
  if (ratio >= 0.92) return { ok: true, detail: `printable_ratio_${ratio.toFixed(3)}` };
  return { ok: false, detail: `low_printable_ratio_${ratio.toFixed(3)}` };
}

async function decryptTranscriptLikeController(row) {
  const transcript = {
    id: row.id,
    recording_id: row.recording_id,
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    encrypted_transcript_text: row.encrypted_transcript_text,
    iv: row.iv,
    recording: row.recording,
  };

  const patientEncounterId =
    transcript.recording?.patientEncounter_id ?? transcript.recording?.patientEncounter?.id ?? null;

  const encryptedAESKey = transcript.recording?.patientEncounter?.encrypted_aes_key ?? null;

  if (!encryptedAESKey) {
    return {
      success: false,
      error: 'missing_encounter_aes_key',
      transcript_text: null,
      patient_encounter_id: patientEncounterId,
    };
  }

  const result = await encryptionUtils.decryptField(transcript, 'transcript_text', encryptedAESKey);
  if (!result.success) {
    return {
      success: false,
      error: result.error || 'decryptField_failed',
      transcript_text: null,
      patient_encounter_id: patientEncounterId,
    };
  }

  return {
    success: true,
    error: null,
    transcript_text: transcript.transcript_text ?? null,
    patient_encounter_id: patientEncounterId,
  };
}

function decryptEncounterNameLikeController(encounter) {
  const id = encounter.id;
  try {
    if (!encounter.encrypted_aes_key || !encounter.iv) {
      return { success: false, error: 'missing_aes_key_or_iv', name: null };
    }
    if (!encounter.encrypted_name) {
      return { success: true, error: null, name: null, no_encrypted_name: true };
    }
    const aesKey = encryptionUtils.decryptAESKey(encounter.encrypted_aes_key);
    const name = encryptionUtils.decryptText(encounter.encrypted_name, aesKey, encounter.iv);
    return { success: true, error: null, name };
  } catch (err) {
    return { success: false, error: err.message || String(err), name: null, encounter_id: id };
  }
}

async function fetchAllTranscripts(supabase, cap) {
  const select = `
    id,
    user_id,
    recording_id,
    encrypted_transcript_text,
    iv,
    created_at,
    updated_at,
    recording:recording_id (
      id,
      patientEncounter_id,
      patientEncounter:patientEncounter_id (
        id,
        encrypted_aes_key
      )
    )
  `;

  const rows = [];
  if (cap != null) {
    const { data, error } = await supabase
      .from('transcripts')
      .select(select)
      .order('id', { ascending: true })
      .limit(cap);

    if (error) throw new Error(`transcripts fetch: ${error.message}`);
    return data || [];
  }

  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('transcripts')
      .select(select)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`transcripts fetch: ${error.message}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function fetchEncountersByIds(supabase, ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (unique.length === 0) return [];

  const rows = [];
  const chunk = 200;
  for (let i = 0; i < unique.length; i += chunk) {
    const slice = unique.slice(i, i + chunk);
    const { data, error } = await supabase
      .from('patientEncounters')
      .select('id, user_id, encrypted_name, encrypted_aes_key, iv, created_at, updated_at')
      .in('id', slice);

    if (error) throw new Error(`patientEncounters by id: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function fetchAllEncounters(supabase) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('patientEncounters')
      .select('id, user_id, encrypted_name, encrypted_aes_key, iv, created_at, updated_at')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`patientEncounters fetch: ${error.message}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function main() {
  const transcriptCap = getTranscriptCap();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!process.env.RSA_PRIVATE_KEY) {
    console.error('Missing RSA_PRIVATE_KEY (required to unwrap encounter AES keys)');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const reportsDir = path.join(__dirname, '..', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log('Export decrypted encounters + transcripts');
  if (transcriptCap != null) {
    console.log(`Transcript cap: ${transcriptCap} (encounters limited to those linked from this batch)`);
  } else {
    console.log('Transcript cap: none (full export)');
  }

  console.log('Fetching transcripts…');
  const transcriptRows = await fetchAllTranscripts(supabase, transcriptCap);
  console.log(`  ${transcriptRows.length} transcript row(s)`);

  let encounterRows;
  if (transcriptCap != null) {
    const ids = transcriptRows.map(
      (r) => r.recording?.patientEncounter_id ?? r.recording?.patientEncounter?.id
    );
    encounterRows = await fetchEncountersByIds(supabase, ids);
    console.log(`Fetching encounters referenced by batch: ${encounterRows.length} row(s)`);
  } else {
    encounterRows = await fetchAllEncounters(supabase);
    console.log(`  ${encounterRows.length} encounter row(s)`);
  }

  const encounterResults = [];
  for (let i = 0; i < encounterRows.length; i += BATCH_SIZE) {
    const batch = encounterRows.slice(i, i + BATCH_SIZE);
    for (const enc of batch) {
      const dec = decryptEncounterNameLikeController(enc);
      const name = dec.name;
      const h = plaintextHeuristic(name ?? '');
      encounterResults.push({
        encounter_id: enc.id,
        user_id: enc.user_id,
        created_at: enc.created_at,
        updated_at: enc.updated_at,
        decrypt_success: dec.success,
        decrypt_error: dec.success ? (dec.no_encrypted_name ? 'no_encrypted_name' : '') : dec.error,
        heuristic_ok: dec.success && (dec.no_encrypted_name || h.ok),
        heuristic_detail: dec.no_encrypted_name ? 'no_name_field' : h.detail,
        name_preview: previewText(name),
        name_length: name != null ? name.length : '',
      });
    }
  }

  const transcriptResults = [];
  for (let i = 0; i < transcriptRows.length; i += BATCH_SIZE) {
    const batch = transcriptRows.slice(i, i + BATCH_SIZE);
    const decrypted = await Promise.all(batch.map((row) => decryptTranscriptLikeController(row)));
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const dec = decrypted[j];
      const text = dec.transcript_text;
      const h = plaintextHeuristic(text ?? '');
      transcriptResults.push({
        transcript_id: row.id,
        recording_id: row.recording_id,
        patient_encounter_id: dec.patient_encounter_id ?? '',
        user_id: row.user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        decrypt_success: dec.success,
        decrypt_error: dec.success ? '' : dec.error,
        heuristic_ok: dec.success ? h.ok : false,
        heuristic_detail: dec.success ? h.detail : '',
        text_preview: previewText(text),
        text_length: text != null ? text.length : '',
      });
    }
  }

  const encPath = path.join(reportsDir, `decrypted-encounters-${stamp}.csv`);
  const trPath = path.join(reportsDir, `decrypted-transcripts-${stamp}.csv`);
  writeFileSync(encPath, objectArrayToCSV(encounterResults), 'utf-8');
  writeFileSync(trPath, objectArrayToCSV(transcriptResults), 'utf-8');

  const encFail = encounterResults.filter((r) => !r.decrypt_success).length;
  const trFail = transcriptResults.filter((r) => !r.decrypt_success).length;
  const encHeurFail = encounterResults.filter((r) => r.decrypt_success && !r.heuristic_ok).length;
  const trHeurFail = transcriptResults.filter((r) => r.decrypt_success && !r.heuristic_ok).length;

  console.log('\nWrote:');
  console.log(`  ${encPath}`);
  console.log(`  ${trPath}`);
  console.log('\nSummary:');
  console.log(
    `  Encounters: ${encounterResults.length} rows, decrypt_fail=${encFail}, heuristic_warn=${encHeurFail}`
  );
  console.log(
    `  Transcripts: ${transcriptResults.length} rows, decrypt_fail=${trFail}, heuristic_warn=${trHeurFail}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
