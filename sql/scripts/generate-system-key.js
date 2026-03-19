#!/usr/bin/env node

/**
 * Generate system master key and create SQL seed
 * Usage: node scripts/generate-system-key.js
 * 
 * This script:
 * 1. Loads RSA_PUBLIC_KEY from .env.local
 * 2. Generates a random AES-256 key
 * 3. Encrypts it with RSA_PUBLIC_KEY
 * 4. Outputs SQL INSERT statement for system key (user_id = NULL)
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');

// Load environment
dotenv.config({ path: envPath });

if (!process.env.RSA_PUBLIC_KEY) {
  console.error('❌ Error: RSA_PUBLIC_KEY not found in .env.local');
  process.exit(1);
}

/**
 * Generates a random AES-256 key
 */
function generateAESKey() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Encrypts AES key using RSA public key
 */
function encryptAESKey(aesKeyBase64) {
  try {
    const publicKey = process.env.RSA_PUBLIC_KEY.replace(/\\n/g, '\n');
    const aesKeyBuf = Buffer.from(aesKeyBase64, 'base64');
    
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKeyBuf
    );
    
    return encrypted.toString('base64');
  } catch (err) {
    console.error('❌ Error encrypting AES key:', err.message);
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🔐 Generating system master key...\n');

  // Generate AES key
  const aesKeyBase64 = generateAESKey();
  console.log('✅ Generated AES-256 key');

  // Encrypt with RSA public key
  const wrappedMasterKey = encryptAESKey(aesKeyBase64);
  console.log('✅ Encrypted with RSA_PUBLIC_KEY\n');

  // Generate SQL statement
  const now = new Date().toISOString();
  const sqlStatement = `-- System master key
-- Generated: ${now}
-- Note: user_id is NULL to indicate this is the system key
INSERT INTO public."userSecurityConfigs" (user_id, wrapped_master_key, created_at, updated_at)
VALUES (NULL, '${wrappedMasterKey}', '${now}', '${now}');
`;

  console.log('Generated SQL statement:\n');
  console.log(sqlStatement);

  // Write to seed file
  const seedPath = path.resolve(__dirname, '../sql/seeds/002_system_master_key.sql');
  fs.writeFileSync(seedPath, sqlStatement);
  console.log(`✅ Seed file created: sql/seeds/002_system_master_key.sql`);
  console.log('\nNext steps:');
  console.log('1. Review the seed file: sql/seeds/002_system_master_key.sql');
  console.log('2. Apply it with: supabase db push');
}

main();
