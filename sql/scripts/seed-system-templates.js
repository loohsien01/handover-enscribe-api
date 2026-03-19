#!/usr/bin/env node

/**
 * Seed system templates with encrypted details
 * Usage: node sql/scripts/seed-system-templates.js
 * 
 * This script:
 * 1. Loads system master key from database (user_id = NULL)
 * 2. Defines system template sections from 001_system_templates.sql
 * 3. Encrypts each section's details
 * 4. Inserts/updates them in noteTemplateSections table
 */

import { createClient } from '@supabase/supabase-js';
import * as encryptionUtils from '../../src/utils/encryptionUtils.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.local');

// Load environment
dotenv.config({ path: envPath });

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env.local');
  process.exit(1);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * System template sections with their details
 * Based on claudeRequestBody.js and sql/seeds/001_system_templates.sql
 * Layout field specifies type (paragraph or bullet points)
 */
const systemTemplateSections = [
  // Subjective sections
  {
    name: 'Chief Complaint',
    layout: 'paragraph',
    details: 'Chief complaint of the patient',
  },
  {
    name: 'History of Present Illness',
    layout: 'paragraph',
    details: 'History of Present Illnesses',
  },
  {
    name: 'Past Medical/Surgical/Family/Social History',
    layout: 'bullet points',
    details: 'Past medical, surgical, family, and social history',
  },
  {
    name: 'Review of Systems',
    layout: 'bullet points',
    details: 'Review of Systems',
  },
  {
    name: 'Medications',
    layout: 'bullet points',
    details: 'Current medications',
  },
  {
    name: 'Allergies',
    layout: 'bullet points',
    details: 'Known allergies',
  },
  // Objective sections
  {
    name: 'General Exam',
    layout: 'paragraph',
    details: 'General exam findings',
  },
  {
    name: 'HEENT',
    layout: 'bullet points',
    details: 'HEENT (Head, Eyes, Ears, Nose, Throat) exam findings. If not mentioned, assume normal.',
  },
  {
    name: 'Cardiovascular',
    layout: 'bullet points',
    details: 'Cardiovascular exam findings',
  },
  {
    name: 'Musculoskeletal',
    layout: 'bullet points',
    details: 'Musculoskeletal exam findings',
  },
  {
    name: 'Other Findings',
    layout: 'bullet points',
    details: 'Other objective findings (vitals, physical exam, lab results)',
  },
  // Assessment & Plan sections
  {
    name: 'Assessment',
    layout: 'paragraph',
    details: 'Clinical assessment and diagnosis based on subjective and objective findings',
  },
  {
    name: 'Plan',
    layout: 'bullet points',
    details: 'Treatment plan, medications, follow-up instructions and next steps. Base solely on transcript - do not include assumptions. Only output data if present in transcript.',
  },
  // Billing section
  {
    name: 'Billing - ICD-10 Codes',
    layout: 'bullet points',
    details: 'ICD-10 codes with description (format: \'CODE - Description\'). Max 4, can have additional supporting codes. Example: \'M79.3 - Panniculitis, unspecified\'',
  },
  {
    name: 'Billing - CPT Codes',
    layout: 'bullet points',
    details: 'CPT codes for services provided. Use 99202–99205 for new patients / 99211–99215 for established patients with justification',
  },
  {
    name: 'Additional Inquiries',
    layout: 'paragraph',
    details: 'Doctor\'s additional areas of investigation for the patient to increase doctor\'s billing level',
  },
];

/**
 * Main execution
 */
async function seedSystemTemplates() {
  console.log('🔐 Seeding system template sections...\n');

  // Get system master key
  const { data: keyData, error: keyError } = await supabaseAdmin
    .from('userSecurityConfigs')
    .select('wrapped_master_key')
    .is('user_id', null)
    .single();

  if (keyError || !keyData) {
    console.error('❌ System key not found in database');
    console.error('   Run: node sql/scripts/generate-system-key.js first');
    process.exit(1);
  }

  // Decrypt system master key
  let systemMasterKey;
  try {
    systemMasterKey = encryptionUtils.decryptAESKey(keyData.wrapped_master_key);
    console.log('✅ Retrieved and decrypted system master key\n');
  } catch (err) {
    console.error('❌ Failed to decrypt system key:', err.message);
    process.exit(1);
  }

  const aesKeyBase64 = systemMasterKey.toString('base64');

  // Encrypt and insert/update each template section
  let successCount = 0;
  let failureCount = 0;

  for (const template of systemTemplateSections) {
    try {
      const ivBase64 = encryptionUtils.generateRandomIVBase64();
      const encrypted_details = encryptionUtils.encryptText(
        template.details,
        aesKeyBase64,
        ivBase64
      );

      const { error: upsertError } = await supabaseAdmin
        .from('noteTemplateSections')
        .upsert(
          {
            name: template.name,
            layout: template.layout,
            encrypted_details,
            details_iv: ivBase64,
            user_id: null, // System template
          },
          { onConflict: 'name,user_id' }
        );

      if (upsertError) {
        console.error(`❌ Failed to upsert ${template.name}:`, upsertError.message);
        failureCount++;
      } else {
        console.log(`✅ Seeded: ${template.name}`);
        successCount++;
      }
    } catch (err) {
      console.error(`❌ Error processing ${template.name}:`, err.message);
      failureCount++;
    }
  }

  console.log(`\n📊 Results: ${successCount} succeeded, ${failureCount} failed`);

  if (failureCount === 0) {
    console.log('\n✅ All system template sections seeded successfully!');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

seedSystemTemplates();
