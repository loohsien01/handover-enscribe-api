#!/usr/bin/env node

/**
 * Seed system templates with encrypted details
 * Usage: node sql/scripts/seed-system-templates.js
 * 
 * This script:
 * 1. Loads system master key from database (user_id = NULL)
 * 2. Creates/fetches system noteTemplate
 * 3. Defines system template sections from 001_system_templates.sql
 * 4. Encrypts and inserts/updates sections in noteTemplateSections table
 * 5. Creates section ordering in noteTemplateSectionOrders table
 * 6. Checks for existing records before creating (idempotent)
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
 * Note template sections with their details
 * Based on claudeRequestBody.js and sql/seeds/001_system_templates.sql
 * Layout field specifies type (paragraph or bullet points)
 */
const noteTemplateSections = [
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
    details:
      'Current medications. Apply medication-name exception: speech-to-text often garbles drug names — prefer dotphrase text or standard names when clearly identified; omit or use generic class if ambiguous. Do not add meds not discussed.',
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
    details: 'Treatment plan, medications, follow-up instructions and next steps. Base solely on transcript - do not include assumptions. Only output data if present in transcript. Apply medication-name exception for drug names.',
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
 * Create or fetch system noteTemplate
 */
async function getOrCreateSystemTemplate() {
  const templateName = 'System SOAP Note Template';

  // Check if template already exists
  const { data: existingTemplate, error: fetchError } = await supabaseAdmin
    .from('noteTemplates')
    .select('id')
    .eq('name', templateName)
    .is('user_id', null)
    .single();

  if (existingTemplate) {
    console.log(`✅ Found existing template: ${templateName} (ID: ${existingTemplate.id})`);
    return existingTemplate.id;
  }

  // Create new template
  const { data: newTemplate, error: insertError } = await supabaseAdmin
    .from('noteTemplates')
    .insert({
      name: templateName,
      user_id: null, // System template
    })
    .select('id')
    .single();

  if (insertError) {
    console.error(`❌ Failed to create template: ${insertError.message}`);
    throw insertError;
  }

  console.log(`✅ Created new template: ${templateName} (ID: ${newTemplate.id})`);
  return newTemplate.id;
}

/**
 * Get or create a template section
 */
async function getOrCreateTemplateSection(template, aesKeyBase64) {
  // Check if section already exists
  const { data: existingSection, error: fetchError } = await supabaseAdmin
    .from('noteTemplateSections')
    .select('id')
    .eq('name', template.name)
    .is('user_id', null)
    .single();

  if (existingSection) {
    console.log(`  📌 Found existing section: ${template.name} (ID: ${existingSection.id})`);
    return existingSection.id;
  }

  // Encrypt and create new section
  try {
    const ivBase64 = encryptionUtils.generateRandomIVBase64();
    const encrypted_details = encryptionUtils.encryptText(
      template.details,
      aesKeyBase64,
      ivBase64
    );

    const { data: newSection, error: insertError } = await supabaseAdmin
      .from('noteTemplateSections')
      .insert({
        name: template.name,
        layout: template.layout,
        encrypted_details,
        details_iv: ivBase64,
        user_id: null, // System template
        is_system: true,
      })
      .select('id')
      .single();

    if (insertError) {
      throw insertError;
    }

    console.log(`  ✅ Created new section: ${template.name} (ID: ${newSection.id})`);
    return newSection.id;
  } catch (err) {
    console.error(`  ❌ Error creating section ${template.name}: ${err.message}`);
    throw err;
  }
}

/**
 * Get or create section order
 */
async function getOrCreateSectionOrder(noteTemplateId, noteTemplateSectionId, order) {
  // Check if order already exists
  const { data: existingOrder, error: fetchError } = await supabaseAdmin
    .from('noteTemplateSectionOrders')
    .select('id')
    .eq('noteTemplate_id', noteTemplateId)
    .eq('noteTemplateSection_id', noteTemplateSectionId)
    .eq('order', order)
    .single();

  if (existingOrder) {
    console.log(`    📍 Found existing section order (order: ${order})`);
    return existingOrder.id;
  }

  // Create new section order
  try {
    const { data: newOrder, error: insertError } = await supabaseAdmin
      .from('noteTemplateSectionOrders')
      .insert({
        noteTemplate_id: noteTemplateId,
        noteTemplateSection_id: noteTemplateSectionId,
        order,
      })
      .select('id')
      .single();

    if (insertError) {
      throw insertError;
    }

    console.log(`    ✅ Created section order (order: ${order})`);
    return newOrder.id;
  } catch (err) {
    console.error(`    ❌ Error creating section order: ${err.message}`);
    throw err;
  }
}

/**
 * Main execution
 */
async function seedSystemTemplates() {
  console.log('🔐 Seeding system templates, sections, and section orders...\n');

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

  let templateId, sectionIds = [], successCount = 0, failureCount = 0;

  try {
    // Step 1: Create or fetch the main noteTemplate
    console.log('📋 Step 1: Creating/fetching main template...');
    templateId = await getOrCreateSystemTemplate();
    console.log();

    // Step 2: Create or fetch template sections
    console.log('📋 Step 2: Creating/fetching template sections...');
    for (const template of noteTemplateSections) {
      try {
        const sectionId = await getOrCreateTemplateSection(template, aesKeyBase64);
        sectionIds.push(sectionId);
        successCount++;
      } catch (err) {
        console.error(`❌ Error processing ${template.name}:`, err.message);
        failureCount++;
      }
    }
    console.log();

    // Step 3: Create section orders
    console.log('📋 Step 3: Creating/fetching section orders...');
    for (let order = 1; order <= sectionIds.length; order++) {
      try {
        await getOrCreateSectionOrder(templateId, sectionIds[order - 1], order);
      } catch (err) {
        console.error(`❌ Error creating section order for order ${order}:`, err.message);
        failureCount++;
      }
    }
    console.log();

    console.log(`📊 Results: ${successCount} sections succeeded, ${failureCount} failed`);

    if (failureCount === 0) {
      console.log('\n✅ All system templates, sections, and section orders seeded successfully!');
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  }
}

seedSystemTemplates();
