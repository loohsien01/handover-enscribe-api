#!/usr/bin/env node
/**
 * Seed BAA version 1.0.0 from the canonical markdown in enscribe-web.
 *
 * Usage:
 *   node sql/scripts/seed-baa-v1.js
 *   node sql/scripts/seed-baa-v1.js /path/to/business-associate-addendum.md
 *
 * Env (from .env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   BAA_MARKDOWN_PATH — optional override for markdown file path
 *
 * Idempotent: skips insert if version_number '1.0.0' already exists.
 * Apply migration first:
 *   npm run migrate:apply-psql -- sql/migrations/20260620_baa_versions_and_acceptances.sql
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { supabaseAdmin } from '../../src/utils/supabaseAdmin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config({ path: path.resolve(repoRoot, '.env.local') });

const VERSION_NUMBER = '1.0.0';
const TITLE = 'Business Associate Addendum';

const defaultMarkdownPath = path.resolve(
  repoRoot,
  '../enscribe-web/src/content/legal/business-associate-addendum.md'
);

function resolveMarkdownPath() {
  const cliPath = process.argv[2];
  if (cliPath) return path.resolve(process.cwd(), cliPath);
  if (process.env.BAA_MARKDOWN_PATH) {
    return path.resolve(process.env.BAA_MARKDOWN_PATH);
  }
  return defaultMarkdownPath;
}

async function seedBaaV1() {
  const markdownPath = resolveMarkdownPath();

  if (!fs.existsSync(markdownPath)) {
    console.error(`❌ Markdown file not found: ${markdownPath}`);
    console.error('   Pass a path: node sql/scripts/seed-baa-v1.js /path/to/business-associate-addendum.md');
    process.exit(1);
  }

  const contentMarkdown = fs.readFileSync(markdownPath, 'utf8').trim();
  if (!contentMarkdown) {
    console.error(`❌ Markdown file is empty: ${markdownPath}`);
    process.exit(1);
  }

  const admin = supabaseAdmin();

  const { data: existing, error: findErr } = await admin
    .from('baa_versions')
    .select('id, version_number, is_active, created_at')
    .eq('version_number', VERSION_NUMBER)
    .maybeSingle();

  if (findErr) {
    console.error('❌ Failed to query baa_versions:', findErr.message);
    if (findErr.message?.includes('does not exist')) {
      console.error('   Apply migration first:');
      console.error('   npm run migrate:apply-psql -- sql/migrations/20260620_baa_versions_and_acceptances.sql');
    }
    process.exit(1);
  }

  if (existing) {
    console.log(`✅ BAA v${VERSION_NUMBER} already seeded (id=${existing.id}, is_active=${existing.is_active})`);
    console.log('   Skipping insert — versions are immutable.');
    process.exit(0);
  }

  const { data: inserted, error: insertErr } = await admin
    .from('baa_versions')
    .insert({
      version_number: VERSION_NUMBER,
      title: TITLE,
      content_markdown: contentMarkdown,
      effective_date: new Date().toISOString(),
      is_active: true,
    })
    .select('id, version_number, is_active, effective_date, created_at')
    .single();

  if (insertErr) {
    console.error('❌ Failed to insert baa_versions row:', insertErr.message);
    process.exit(1);
  }

  console.log('✅ Seeded BAA v1.0.0');
  console.log(`   id:              ${inserted.id}`);
  console.log(`   version_number:  ${inserted.version_number}`);
  console.log(`   is_active:       ${inserted.is_active}`);
  console.log(`   effective_date:  ${inserted.effective_date}`);
  console.log(`   markdown bytes:  ${Buffer.byteLength(contentMarkdown, 'utf8')}`);
  console.log(`   source:          ${markdownPath}`);
}

seedBaaV1().catch((err) => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
