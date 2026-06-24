#!/usr/bin/env node

/**
 * Encrypt noteTemplateSections[].details with the **system** master AES key and print JSON
 * for manual DB updates (`encrypted_details`, `details_iv` on `noteTemplateSections`).
 *
 * Usage:
 *   node sql/scripts/encrypt-note-template-section-details.js
 *
 * Requires `.env.local`: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RSA_PRIVATE_KEY
 * (same unwrap path as `seed-system-templates.js` and `getSystemMasterKey()` in the API).
 *
 * Uses the same helpers as the API: `encryptNoteTemplateSectionDetails` then
 * `decryptNoteTemplateSectionDetails` with the unwrapped system key `Buffer` (not a
 * re-encoded base64 round-trip), and asserts decrypted `details` match each input.
 *
 * If manual DB updates still fail in the API but this script passes, the running server
 * is likely using a different Supabase project or RSA key than `.env.local`.
 *
 * Edit `noteTemplateSections` below, run, copy stdout into your migration or editor.
 */

import * as encryptionUtils from '../../src/utils/encryptionUtils.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

/** @typedef {{ name: string, layout: string, details: string }} NoteTemplateSectionInput */

/** @type {NoteTemplateSectionInput[]} — replace or extend as needed */
const noteTemplateSections = [
  {
    name: 'Example Section',
    layout: 'paragraph',
    details: 'Current medications. Apply medication-name exception: speech-to-text often garbles drug names — prefer dotphrase text or standard names when clearly identified; omit or use generic class if ambiguous. Do not add meds not discussed.',
  },
];

/** Same material as `getSystemMasterKey().masterKey` in the API. */
async function getSystemMasterKeyBufferFromDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env.local');
  }
  if (!process.env.RSA_PRIVATE_KEY) {
    throw new Error('RSA_PRIVATE_KEY required in .env.local to unwrap system master key');
  }
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  const { data, error } = await supabase
    .from('userSecurityConfigs')
    .select('wrapped_master_key')
    .is('user_id', null)
    .single();
  if (error || !data?.wrapped_master_key) {
    throw new Error('System wrapped_master_key not found (run generate-system-key if needed)');
  }
  return encryptionUtils.decryptAESKey(data.wrapped_master_key);
}

/**
 * Build DB-shaped rows using `encryptNoteTemplateSectionDetails` (same as create/update API).
 */
function buildEncryptedRows(inputs, systemMasterKeyBuffer) {
  return inputs.map((row) => {
    const section = {
      name: row.name,
      layout: row.layout,
      details: row.details,
      user_id: null,
    };
    const enc = encryptionUtils.encryptNoteTemplateSectionDetails(section, systemMasterKeyBuffer);
    if (!enc.success) {
      throw new Error(`encryptNoteTemplateSectionDetails failed for "${row.name}": ${enc.error}`);
    }
    return {
      name: enc.section.name,
      layout: enc.section.layout,
      encrypted_details: enc.section.encrypted_details,
      details_iv: enc.section.details_iv,
      user_id: null,
    };
  });
}

/**
 * Verify each printed row with `decryptNoteTemplateSectionDetails` + same `Buffer` the API uses,
 * and that plaintext matches the corresponding input `details`.
 */
function assertDecryptNoteTemplateSectionDetailsMatchesInput(inputs, rows, systemMasterKeyBuffer) {
  console.error(
    '[encrypt-note-template-section-details] Round-trip: decryptNoteTemplateSectionDetails (same helper as GET /api/note-template-sections)…'
  );
  for (let i = 0; i < rows.length; i++) {
    const input = inputs[i];
    const row = rows[i];
    const section = {
      encrypted_details: row.encrypted_details,
      details_iv: row.details_iv,
    };
    const result = encryptionUtils.decryptNoteTemplateSectionDetails(section, systemMasterKeyBuffer);
    if (!result.success) {
      throw new Error(
        `decryptNoteTemplateSectionDetails failed for "${row.name}": ${result.error}${result.cause ? ` (${result.cause})` : ''}`
      );
    }
    if (result.section.details !== input.details) {
      throw new Error(`Decrypted details mismatch for "${row.name}" (API decrypt path)`);
    }
    console.error(
      `[encrypt-note-template-section-details]   OK "${row.name}": decryptNoteTemplateSectionDetails recovered details: "${result.section.details}"\n`
    );
  }
  console.error(
    `[encrypt-note-template-section-details] Round-trip passed for ${rows.length} row(s); stdout JSON is safe to paste into DB.`
  );
}

async function main() {
  const systemMasterKeyBuffer = await getSystemMasterKeyBufferFromDb();
  const out = buildEncryptedRows(noteTemplateSections, systemMasterKeyBuffer);
  assertDecryptNoteTemplateSectionDetailsMatchesInput(noteTemplateSections, out, systemMasterKeyBuffer);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
