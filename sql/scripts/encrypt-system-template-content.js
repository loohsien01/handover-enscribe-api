#!/usr/bin/env node

/**
 * Encrypt system-owned template plaintext with the **system** master AES key and print JSON
 * for manual DB updates.
 *
 * Usage:
 *   node sql/scripts/encrypt-system-template-content.js
 *
 * Set `TARGET` below to choose output shape:
 *   - `noteTemplateSection` → `encrypted_details`, `details_iv` on `noteTemplateSections`
 *   - `preVisitSummaryTemplate` → `encrypted_text`, `text_iv` on `pre_visit_summary_templates`
 *
 * Requires `.env.local`: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RSA_PRIVATE_KEY
 * (same unwrap path as `seed-system-templates.js` and `getSystemMasterKey()` in the API).
 *
 * Uses the same helpers as the API, then round-trip decrypts with the unwrapped system key
 * `Buffer` (not a re-encoded base64 round-trip) and asserts plaintext matches each input.
 *
 * If manual DB updates still fail in the API but this script passes, the running server
 * is likely using a different Supabase project or RSA key than `.env.local`.
 *
 * Edit the input array for your `TARGET`, run, copy stdout into your migration or editor.
 *
 * Multiline plaintext: use template literals (backticks) for `details` / `text`. Encryption is
 * UTF-8 end-to-end (same as notes.encrypted_text) — `\n` round-trips unchanged.
 */

import * as encryptionUtils from '../../src/utils/encryptionUtils.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

/** @typedef {'noteTemplateSection' | 'preVisitSummaryTemplate'} EncryptTarget */

/** @type {EncryptTarget} — switch target table / crypto helpers */
// const TARGET = 'noteTemplateSection';
const TARGET = 'preVisitSummaryTemplate';

/** @typedef {{ name: string, layout: string, details: string }} NoteTemplateSectionInput */

/** @type {NoteTemplateSectionInput[]} — used when TARGET = 'noteTemplateSection' */
const noteTemplateSections = [
  {
    name: 'Example Section',
    layout: 'paragraph',
    details:
      'Current medications. Apply medication-name exception: speech-to-text often garbles drug names — prefer dotphrase text or standard names when clearly identified; omit or use generic class if ambiguous. Do not add meds not discussed.',
  },
];

/** @typedef {{ name: string, text: string, is_default?: boolean }} PreVisitSummaryTemplateInput */

/** @type {PreVisitSummaryTemplateInput[]} — used when TARGET = 'preVisitSummaryTemplate' */
const preVisitSummaryTemplates = [
  {
    name: 'Default instructions',
    text: 
      `1. Patient name, age, sex,
      2. relevant past medical history
      3. reason for follow-up
      4. summary of findings
      5. current symptoms and clinical status
      6. active medications
      7. current plan: including any pending items.
      8. Vocabulary section to show correct spelling (any niche words to help AI avoid misspelling, e.g. medications, doctor/patient names)`,
    is_default: false,
  },
];

const SCRIPT_NAME = 'encrypt-system-template-content';

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
function buildEncryptedNoteTemplateSectionRows(inputs, systemMasterKeyBuffer) {
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
 * Build DB-shaped rows using `encryptNoteText` (same as pre-visit summary templates API).
 */
function buildEncryptedPreVisitSummaryTemplateRows(inputs, systemMasterKeyBuffer) {
  return inputs.map((row) => {
    let encryptedText = null;
    let textIv = null;

    if (row.text) {
      const enc = encryptionUtils.encryptNoteText({ text: row.text }, systemMasterKeyBuffer);
      if (!enc.success) {
        throw new Error(`encryptNoteText failed for "${row.name}": ${enc.error}`);
      }
      encryptedText = enc.value;
      textIv = enc.iv;
    }

    const out = {
      name: row.name,
      encrypted_text: encryptedText,
      text_iv: textIv,
      user_id: null,
    };
    if (row.is_default !== undefined) {
      out.is_default = row.is_default;
    }
    return out;
  });
}

function assertDecryptNoteTemplateSectionDetailsMatchesInput(inputs, rows, systemMasterKeyBuffer) {
  console.error(
    `[${SCRIPT_NAME}] Round-trip: decryptNoteTemplateSectionDetails (same helper as GET /api/note-template-sections)…`
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
      `[${SCRIPT_NAME}]   OK "${row.name}": decryptNoteTemplateSectionDetails recovered details: "${result.section.details}"\n`
    );
  }
  console.error(
    `[${SCRIPT_NAME}] Round-trip passed for ${rows.length} noteTemplateSection row(s); stdout JSON is safe to paste into DB.`
  );
}

function assertDecryptPreVisitSummaryTemplateTextMatchesInput(inputs, rows, systemMasterKeyBuffer) {
  console.error(
    `[${SCRIPT_NAME}] Round-trip: decryptNoteText (same helper as GET /api/pre-visit-summary-templates/:id)…`
  );
  for (let i = 0; i < rows.length; i++) {
    const input = inputs[i];
    const row = rows[i];
    const template = {
      encrypted_text: row.encrypted_text,
      text_iv: row.text_iv,
    };
    const result = encryptionUtils.decryptNoteText(template, systemMasterKeyBuffer);
    if (!result.success) {
      throw new Error(`decryptNoteText failed for "${row.name}": ${result.error}`);
    }
    const expectedText = input.text ?? '';
    if ((result.text ?? '') !== expectedText) {
      throw new Error(`Decrypted text mismatch for "${row.name}" (API decrypt path)`);
    }
    console.error(
      `[${SCRIPT_NAME}]   OK "${row.name}": decryptNoteText recovered text: "${result.text ?? ''}"\n`
    );
  }
  console.error(
    `[${SCRIPT_NAME}] Round-trip passed for ${rows.length} preVisitSummaryTemplate row(s); stdout JSON is safe to paste into DB.`
  );
}

async function main() {
  const systemMasterKeyBuffer = await getSystemMasterKeyBufferFromDb();

  if (TARGET === 'noteTemplateSection') {
    const out = buildEncryptedNoteTemplateSectionRows(noteTemplateSections, systemMasterKeyBuffer);
    assertDecryptNoteTemplateSectionDetailsMatchesInput(
      noteTemplateSections,
      out,
      systemMasterKeyBuffer
    );
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  if (TARGET === 'preVisitSummaryTemplate') {
    const out = buildEncryptedPreVisitSummaryTemplateRows(
      preVisitSummaryTemplates,
      systemMasterKeyBuffer
    );
    assertDecryptPreVisitSummaryTemplateTextMatchesInput(
      preVisitSummaryTemplates,
      out,
      systemMasterKeyBuffer
    );
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown TARGET "${TARGET}" — use noteTemplateSection or preVisitSummaryTemplate`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
