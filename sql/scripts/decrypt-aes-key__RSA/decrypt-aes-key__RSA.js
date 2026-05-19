#!/usr/bin/env node

/**
 * Decrypt a single RSA-wrapped AES key (same format as `encrypted_aes_key` / `wrapped_master_key`
 * elsewhere in this repo: base64 RSA-OAEP-SHA256 ciphertext).
 *
 * Requires `.env.local`: RSA_PRIVATE_KEY (PEM, optional literal `\n` → newline).
 *
 * Set the ciphertext below, or pass it as the first CLI argument:
 *   node sql/scripts/decrypt-aes-key__RSA/decrypt-aes-key__RSA.js
 *   node sql/scripts/decrypt-aes-key__RSA/decrypt-aes-key__RSA.js '<base64>'
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as encryptionUtils from '../../../src/utils/encryptionUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

// ---------------------------------------------------------------------------
// Paste RSA-encrypted AES key (base64) here, or pass it as argv[2]
// ---------------------------------------------------------------------------
const ENCRYPTED_AES_KEY_B64 = 'qwSJsBmiV+ipFej+6TfpHb1covJdz9cmXjDcRXsjHfazZ3epa59ph9qTAYgkGHpzSHIYMJeYaxsw2yhTCw5re0gTT8cQE5AEn1dJnaHhzYp6xPlp+cjA7fQdhPXzK0IbMIHyfgwJal6XrH2kx8ykKHka/an4eA7J9oU18X/ca3gA+Ox/5t0mSOO2C7KzkY7cd6L49nfuIRqZF0Axh8/nFZjpVsbNsOy8TI5KIciLY72xwIEBDPU+vOeeWt4oN7HEz/dJoAEnNbXbari2aMife5s6QdP9oGWWwpFDRZpLC0Agiz+GQ5WDKa9ARr1ku373RHhF1E0nbC33ebCaimpl1g==';

function main() {
  const fromArg = process.argv[2]?.trim();
  const encrypted = (fromArg || ENCRYPTED_AES_KEY_B64).trim();

  if (!encrypted) {
    console.error('Set ENCRYPTED_AES_KEY_B64 at the top of this file, or pass base64 as the first argument.');
    process.exit(1);
  }
  if (!process.env.RSA_PRIVATE_KEY) {
    console.error('Missing RSA_PRIVATE_KEY in environment (.env.local).');
    process.exit(1);
  }

  let aesBuf;
  try {
    aesBuf = encryptionUtils.decryptAESKey(encrypted);
  } catch (err) {
    console.error('Decryption failed:', err.message || err);
    process.exit(1);
  }

  const aesBase64 = aesBuf.toString('base64');
  console.log('AES key length (bytes):', aesBuf.length);
  console.log('AES key (base64):');
  console.log(aesBase64);
}

main();
