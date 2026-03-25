#!/usr/bin/env node

/**
 * Migrate SOAP Notes to Notes Table
 * 
 * Changes:
 * - Column mapping: encrypted_soapNote_text → encrypted_text, iv → text_iv
 * - Encryption: Patient encounter AES key → User master key
 * - Each soapNote gets decrypted with patientEncounter's encrypted_aes_key
 * - Re-encrypted with user's master key
 * 
 * Process:
 * 1. Fetch all soapNotes with patientEncounter data
 * 2. Group by user_id and get/create master keys (avoid re-fetching)
 * 3. Batch decrypt (await.all) for optimal performance
 * 4. Save to CSV first as backup
 * 5. Insert into notes table
 * 
 * Usage: node sql/scripts/migrate-soapnotes-to-notes.js
 */

import { createClient } from '@supabase/supabase-js';
import * as encryptionUtils from '../../src/utils/encryptionUtils.js';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.local');

// Load environment
dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SIZE = 10; // Decrypt in batches

// TEST MODE: Set to limit number of records (e.g., 10, null = all)
const LIMIT = 10; // Change to 10 for testing
const TEST_MODE = LIMIT !== null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Helper: Convert array of objects to CSV
 * @param {Array} data - Array of objects
 * @returns {string} CSV string
 */
function objectArrayToCSV(data) {
  if (!data || data.length === 0) return '';

  const keys = Object.keys(data[0]);
  const header = keys.map((k) => `"${k}"`).join(',');
  const rows = data.map((row) =>
    keys
      .map((k) => {
        const val = row[k];
        // Escape quotes and wrap strings
        if (typeof val === 'string') {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val === null || val === undefined ? '' : `"${val}"`;
      })
      .join(',')
  );

  return [header, ...rows].join('\n');
}

/**
 * Get or create user master key
 * Caches master keys to avoid re-fetching
 * @param {string} userId - User ID
 * @param {Map} masterKeyCache - Cache for master keys
 * @returns {Promise<Buffer>} Decrypted master key
 */
async function getOrCreateUserMasterKey(userId, masterKeyCache) {
  // Check cache first
  if (masterKeyCache.has(userId)) {
    console.log(`  ✓ Using cached master key for ${userId}`);
    return masterKeyCache.get(userId);
  }

  console.log(`  ⚙️  Fetching/creating master key for ${userId}...`);
  
  // Get existing user security config
  const { data: existingConfig, error: fetchError } = await supabase
    .from('userSecurityConfigs')
    .select('wrapped_master_key')
    .eq('user_id', userId)
    .single();

  let wrappedMasterKey;

  if (fetchError && fetchError.code !== 'PGRST116') {
    throw new Error(`Failed to fetch user security config: ${fetchError.message}`);
  }

  if (!existingConfig) {
    // Create new master key
    console.log(`    Creating new master key...`);
    const { aesKey } = encryptionUtils.generateAESKeyAndIV();
    wrappedMasterKey = encryptionUtils.encryptAESKey(aesKey);

    const { data: newConfig, error: insertError } = await supabase
      .from('userSecurityConfigs')
      .insert([{ user_id: userId, wrapped_master_key: wrappedMasterKey }])
      .select('wrapped_master_key')
      .single();

    if (insertError) {
      throw new Error(`Failed to create user security config: ${insertError.message}`);
    }

    wrappedMasterKey = newConfig.wrapped_master_key;
  } else {
    wrappedMasterKey = existingConfig.wrapped_master_key;
  }

  // Decrypt the master key
  const masterKey = encryptionUtils.decryptAESKey(wrappedMasterKey);
  
  // Cache it
  masterKeyCache.set(userId, masterKey);
  console.log(`  ✓ Master key ready for ${userId}`);

  return masterKey;
}

/**
 * Decrypt a single SOAP note
 * @param {object} soapNote - SOAP note with encrypted_soapNote_text
 * @returns {string} Decrypted text or empty string on error
 */
function decryptSoapNote(soapNote) {
  try {
    const encryptedAESKey = soapNote.patientEncounter?.encrypted_aes_key;
    if (!encryptedAESKey) {
      console.error(`  ✗ Missing encrypted_aes_key for soapNote ${soapNote.id}`);
      return '';
    }

    const aesKey = encryptionUtils.decryptAESKey(encryptedAESKey);
    const plainText = encryptionUtils.decryptText(
      soapNote.encrypted_soapNote_text,
      aesKey,
      soapNote.iv
    );

    return plainText;
  } catch (err) {
    console.error(`  ✗ Failed to decrypt soapNote ${soapNote.id}:`, err.message);
    return '';
  }
}

/**
 * Main migration function
 */
async function migrateSoapNotesToNotes() {
  let rawCSVPath = null;
  let csvFilePath = null;

  try {
    console.log('🔄 Starting SOAP Notes → Notes migration...\n');
    
    if (TEST_MODE) {
      console.log(`⚠️  TEST MODE: Limiting to ${LIMIT} records only\n`);
    }

    // Step 1: Fetch all SOAP notes with patientEncounter data
    console.log('📥 Step 1: Fetching all SOAP notes...');
    let query = supabase
      .from('soapNotes')
      .select(`
        id,
        user_id,
        patientEncounter_id,
        encrypted_soapNote_text,
        iv,
        created_at,
        updated_at,
        patientEncounter:patientEncounter_id (
          encrypted_aes_key
        )
      `)
      .order('created_at', { ascending: true });

    // Apply limit for testing
    if (LIMIT) {
      query = query.limit(LIMIT);
    }

    const { data: soapNotes, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch SOAP notes: ${fetchError.message}`);
    }

    if (!soapNotes || soapNotes.length === 0) {
      console.log('  ℹ️  No SOAP notes to migrate. Exiting.\n');
      return;
    }

    console.log(`  ✓ Fetched ${soapNotes.length} SOAP notes\n`);

    // Step 1.5: Save raw soapNotes to CSV as reference (includes encrypted_aes_key)
    console.log('💾 Step 1.5: Saving raw soapNotes to CSV (reference)...');
    const rawDataForCSV = soapNotes.map((sn) => ({
      soapNoteId: sn.id,
      patientEncounterId: sn.patientEncounter_id,
      iv: sn.iv,
      encrypted_aes_key: sn.patientEncounter?.encrypted_aes_key || 'MISSING',
      encrypted_soapNote_text: sn.encrypted_soapNote_text,
    }));

    rawCSVPath = path.resolve(
      __dirname,
      `../../test-results/migration-raw-soapnotes-${Date.now()}.csv`
    );
    const rawCSVContent = objectArrayToCSV(rawDataForCSV);
    writeFileSync(rawCSVPath, rawCSVContent, 'utf-8');
    console.log(`  ✓ Raw data saved to ${rawCSVPath}`);
    console.log(`    → Columns: soapNoteId, patientEncounterId, iv, encrypted_aes_key, encrypted_soapNote_text\n`);

    // Step 2: Group by user_id and fetch/create master keys
    console.log('🔑 Step 2: Getting/creating user master keys...');
    const userIds = [...new Set(soapNotes.map((sn) => sn.user_id))];
    const masterKeyCache = new Map();

    for (const userId of userIds) {
      try {
        await getOrCreateUserMasterKey(userId, masterKeyCache);
      } catch (err) {
        console.error(`  ✗ Failed to get master key for ${userId}:`, err.message);
        throw err;
      }
    }
    console.log(`  ✓ Master keys ready for ${userIds.length} users\n`);

    // Step 3: Batch decrypt SOAP notes
    console.log(`🔐 Step 3: Decrypting SOAP notes (batch size: ${BATCH_SIZE})...`);
    const decryptedNotes = [];

    for (let i = 0; i < soapNotes.length; i += BATCH_SIZE) {
      const batch = soapNotes.slice(i, i + BATCH_SIZE);
      const decryptedBatch = batch.map((soapNote) => ({
        ...soapNote,
        decryptedText: decryptSoapNote(soapNote),
      }));

      decryptedNotes.push(...decryptedBatch);
      console.log(`  ✓ Decrypted batch ${Math.ceil((i + BATCH_SIZE) / BATCH_SIZE)}/${Math.ceil(soapNotes.length / BATCH_SIZE)}`);
    }
    console.log(`  ✓ All ${decryptedNotes.length} SOAP notes decrypted\n`);

    // Step 4: Re-encrypt with user master keys
    console.log('🔐 Step 4: Re-encrypting with user master keys...');
    const notesForInsert = [];

    for (let i = 0; i < decryptedNotes.length; i++) {
      const soapNote = decryptedNotes[i];
      const masterKey = masterKeyCache.get(soapNote.user_id);

      if (!masterKey) {
        console.error(`  ✗ No master key found for user ${soapNote.user_id}, skipping soapNote ${soapNote.id}`);
        continue;
      }

      if (!soapNote.decryptedText) {
        console.error(`  ✗ Failed to decrypt soapNote ${soapNote.id}, skipping`);
        continue;
      }

      // Re-encrypt with user master key
      const noteObj = { text: soapNote.decryptedText };
      const encryptResult = encryptionUtils.encryptNoteText(noteObj, masterKey);

      if (!encryptResult.success) {
        console.error(`  ✗ Failed to re-encrypt soapNote ${soapNote.id}: ${encryptResult.error}`);
        continue;
      }

      notesForInsert.push({
        user_id: soapNote.user_id,
        patientEncounter_id: soapNote.patientEncounter_id,
        encrypted_text: encryptResult.value,
        text_iv: encryptResult.iv,
        created_at: soapNote.created_at,
        updated_at: soapNote.updated_at,
      });
    }

    console.log(`  ✓ Re-encrypted ${notesForInsert.length} notes\n`);

    // Step 5: Check for duplicates and insert into notes table
    console.log('📤 Step 5: Checking for duplicates and inserting notes into database...');
    
    // Filter out notes that already exist (duplicate check by patientEncounter_id + user_id)
    const notesToInsert = [];
    let skippedCount = 0;

    for (const note of notesForInsert) {
      // Check if a note already exists for this user + encounter
      const { data: existing, error: checkError } = await supabase
        .from('notes')
        .select('id')
        .eq('user_id', note.user_id)
        .eq('patientEncounter_id', note.patientEncounter_id)
        .single();

      if (checkError && checkError.code !== 'PGRST116') {
        // PGRST116 = not found, which is expected
        console.error(`  ✗ Error checking for duplicates for note (user ${note.user_id}, encounter ${note.patientEncounter_id}): ${checkError.message}`);
        continue;
      }

      if (existing) {
        // Note already exists, skip
        console.log(`  ⏭️  Skipped: Note already exists for user ${note.user_id}, encounter ${note.patientEncounter_id}`);
        skippedCount++;
      } else {
        // Note doesn't exist, add to insert list
        notesToInsert.push(note);
      }
    }

    console.log(`  ℹ️  Skipped ${skippedCount} duplicate notes\n`);

    if (notesToInsert.length === 0) {
      console.log('  ℹ️  No new notes to insert. All notes already exist.\n');
    } else {
      // Insert in batches to avoid timeout
      const insertBatchSize = 50;
      for (let i = 0; i < notesToInsert.length; i += insertBatchSize) {
        const batch = notesToInsert.slice(i, i + insertBatchSize);
        const { error: insertError, count } = await supabase
          .from('notes')
          .insert(batch);

        if (insertError) {
          console.error(`  ✗ Batch insert failed:`, insertError);
          throw insertError;
        }

        console.log(`  ✓ Inserted batch ${Math.ceil((i + insertBatchSize) / insertBatchSize)}/${Math.ceil(notesToInsert.length / insertBatchSize)} (${count || batch.length} records)`);
      }
    }

    console.log(`\n✅ Migration complete!`);
    console.log(`   Total processed: ${notesForInsert.length}`);
    console.log(`   Inserted: ${notesToInsert.length}`);
    console.log(`   Skipped (duplicates): ${skippedCount}`);
    console.log(`\n📄 Audit CSV:`);
    console.log(`   Raw soapNotes data: ${rawCSVPath}\n`);
    
    if (TEST_MODE) {
      console.log(`⚠️  TEST MODE: Only processed ${LIMIT} records. Remove .limit() on line to process all.\n`);
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run migration
migrateSoapNotesToNotes();
