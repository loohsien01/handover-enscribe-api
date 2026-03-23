import crypto from "crypto";

/**
 * Decrypts a field in an object and transforms it in place.
 * Decrypts the AES key, decrypts the encrypted field, then removes sensitive data (encrypted_* fields, IV, key).
 * @param {object} obj - The object containing encrypted data (will be mutated).
 * @param {string} field - The base field name (e.g., "name", "transcript_text").
 * @param {string|Buffer} encryptedAESKey - The RSA-encrypted AES key (base64 or Buffer).
 * @returns {object} { success, error, value } - success=true if decryption succeeded, value contains decrypted field.
 */
export async function decryptField(obj, field, encryptedAESKey) {
    // console.log('[decryptField]:', obj, field, encryptedAESKey);
    const encryptedField = `encrypted_${field}`;
    if (!encryptedAESKey || !obj.iv) {
        const errorMsg = `Missing encrypted AES key or IV for ${field}. Failed to decrypt data`;
        console.error(errorMsg);
        return { success: false, error: errorMsg, value: null };
    }

    let aesKey;
    try {
      if( typeof encryptedAESKey === 'string' ) {
        aesKey = decryptAESKey(encryptedAESKey);
      } else if (Buffer.isBuffer(encryptedAESKey)) {
        aesKey = encryptedAESKey;
      } else {
        throw new TypeError('decryptField: "encryptedAESKey" must be a base64 string or Buffer');
      }
    } catch (err) {
        console.error(`[decryptField] Error decrypting AES key for ${field}:`, err);
        return { success: false, error: 'Failed to decrypt AES key', value: null };
    }

    if (!obj[encryptedField]) {
        const errorMsg = `Missing encrypted field ${encryptedField} for ${field}`;
        console.error(errorMsg);
        return { success: false, error: errorMsg, value: null };
    }

    try {
        obj[field] = decryptText(obj[encryptedField], aesKey, obj.iv);
        delete obj[encryptedField];
        delete obj.iv;
        delete obj.encrypted_aes_key;
        return { success: true, error: null, value: obj[field] };
    } catch (err) {
        console.error(`[decryptField] Error decrypting ${encryptedField}:`, err);
        obj[field] = null;
        return { success: false, error: 'Failed to decrypt field', value: null };
    }
}

/**
 * Encrypts a field in an object using an encrypted AES key.
 * Generates a new IV for encryption.
 * Removes the plain field after encryption.
 * Returns the encrypted value and generated IV.
 * @param {object} obj - The object containing the plain text field.
 * @param {string} field - The base field name (e.g., "transcript_text", "soapNote_text").
 * @param {string} encryptedAesKey - The RSA-encrypted AES key (base64 string).
 * @returns {object} { success, error, value, iv }
 */
export function encryptField(obj, field, encryptedAesKey) {
    // console.log('[encryptField]:', obj, field, encryptedAesKey);
    try {
        // Decrypt the AES key first
        const aesKey = decryptAESKey(encryptedAesKey);
        const aesKeyBase64 = Buffer.isBuffer(aesKey) ? aesKey.toString('base64') : aesKey;

        // Generate a new IV
        const ivBase64 = generateRandomIVBase64();

        if (!obj[field]) {
            const errorMsg = `Missing plain field ${field} for encryption`;
            console.error(errorMsg);
            return { success: false, error: errorMsg, value: null, iv: null };
        }

        obj[`encrypted_${field}`] = encryptText(obj[field], aesKeyBase64, ivBase64);
        obj.iv = ivBase64;
        delete obj[field];
        return { success: true, error: null, value: obj[`encrypted_${field}`], iv: ivBase64 };
    } catch (err) {
        console.error(`[encryptField] Error encrypting ${field}:`, err);
        return { success: false, error: 'Failed to encrypt field', value: null, iv: null };
    }
}


export function generateRandomIVBase64() {
  // Node.js
  if (typeof window === "undefined" && (typeof globalThis.crypto === "undefined" || !globalThis.crypto.getRandomValues)) {
    return crypto.randomBytes(16).toString("base64");
  }
  // Browser/Edge
  else if (typeof globalThis.crypto?.getRandomValues === "function") {
    const ivArray = new Uint8Array(16);
    globalThis.crypto.getRandomValues(ivArray);
    return Buffer.from(ivArray).toString("base64");
  }
  throw new Error("No secure random generator available in this environment.");
}

/**
 * Generates a random AES key and IV for encryption, compatible with Node.js and browser/edge environments.
 * @returns {{ aesKey: string, iv: string }}
 */
export function generateAESKeyAndIV() {
  let aesKey, iv;

  // Node.js environment
  if (typeof window === "undefined" && (typeof globalThis.crypto === "undefined" || !globalThis.crypto.getRandomValues)) {
    aesKey = crypto.randomBytes(32);
    iv = crypto.randomBytes(16);
  }
  // Browser/Edge environment
  else if (typeof globalThis.crypto?.getRandomValues === "function") {
    const aesKeyArray = new Uint8Array(32);
    const ivArray = new Uint8Array(16);
    globalThis.crypto.getRandomValues(aesKeyArray);
    globalThis.crypto.getRandomValues(ivArray);
    aesKey = Buffer.from(aesKeyArray);
    iv = Buffer.from(ivArray);
  } else {
    throw new Error("No secure random generator available in this environment.");
  }

  return {
    aesKey: aesKey.toString("base64"),
    iv: iv.toString("base64"),
  };
}

/**
 * Encrypts text using a provided AES key and IV, then encrypts the AES key using an RSA public key.
 * @param {string} plainText - The text to encrypt.
 * @param {string} aesKey - The AES key (base64).
 * @param {string} iv - The initialization vector (base64).
 * @returns {string} Encrypted text as a base64 string.
 */
export function encryptText(plainText, aesKey, iv) {
  // Only support Node.js for AES encryption
  if (typeof window !== "undefined" || typeof crypto.createCipheriv !== "function") {
    throw new Error("AES encryption is only supported in Node.js for this function.");
  }

  try {
    const aesKeyBuf = Buffer.from(aesKey, "base64");
    const ivBuf = Buffer.from(iv, "base64");
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKeyBuf, ivBuf);
    let encryptedText = cipher.update(plainText, "utf8", "base64");
    encryptedText += cipher.final("base64");
    return encryptedText;
  } catch (err) {
    console.error('[encryptText] Error:', err);
    throw err;
  }
}

/**
 * Decrypts AES-encrypted text using the provided IV and decrypted AES key.
 * Low-level cryptographic operation - does not modify objects or handle field names.
 * @param {string} encryptedText - The AES-encrypted text (base64).
 * @param {Buffer|string} aesKey - The decrypted AES key (Buffer or base64 string).
 * @param {string} iv - The initialization vector (base64).
 * @returns {string} Decrypted plain text.
 */
export function decryptText(encryptedText, aesKey, iv) {
  let aesKeyPrintable;
  if (Buffer.isBuffer(aesKey)) {
    aesKeyPrintable = aesKey.toString('base64');
  } else if (typeof aesKey === 'string') {
    aesKeyPrintable = aesKey;
  } else {
    aesKeyPrintable = String(aesKey);
  }
  const base64Key = 'slhv8jSpVrvzO2hyNYdxcNGBGqE6ISvsCl4VJaX7wYY=';
  const rawKeyBuffer = Buffer.from(base64Key, 'base64');
  // console.log('decryptText():    ', { encryptedText: encryptedText.substring(0, 20) + "......", aesKey: aesKeyPrintable, iv });
  // console.log('Raw aes key (hex):', rawKeyBuffer.toString('hex'));
  // console.log('Raw key (bytes):', Array.from(rawKeyBuffer));   // For byte array input
  // console.log('Raw key length:', rawKeyBuffer.length);          // Should be 32 for AES-256

  if (typeof window !== "undefined" || typeof crypto.createDecipheriv !== "function") {
    throw new Error("AES decryption is only supported in Node.js for this function.");
  }

  if (!encryptedText || (typeof encryptedText !== "string" && !Buffer.isBuffer(encryptedText))) {
    throw new TypeError('decryptText: "encryptedText" must be a non-empty string or Buffer');
  }

  try {
    const aesKeyBuf = Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      aesKeyBuf,
      Buffer.from(iv, "base64")
    );
    let decrypted = decipher.update(encryptedText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error('[decryptText] Error:', err);
    throw err;
  }
}
/**
 * Encrypts an AES key using the RSA public key from environment variables.
 * @param {Buffer|string} aesKey - The AES key to encrypt (Buffer or base64 string).
 * @returns {string} Encrypted AES key as a base64 string.
 */
export function encryptAESKey(aesKey) {
  if (typeof window !== "undefined" || typeof crypto.publicEncrypt !== "function") {
    throw new Error("RSA encryption is only supported in Node.js for this function.");
  }

  try {
    const publicKey = process.env.RSA_PUBLIC_KEY.replace(/\\n/g, '\n');
    const aesKeyBuf = Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey, "base64");
    return crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      aesKeyBuf
    ).toString("base64");
  } catch (err) {
    console.error('[encryptAESKey] Error:', err);
    throw err;
  }
}

/**
 * Decrypts an AES key using the RSA private key from environment variables.
 * @param {string} encryptedAESKey - The RSA-encrypted AES key (base64).
 * @returns {Buffer} Decrypted AES key as a Buffer.
 */
export function decryptAESKey(encryptedAESKey) {
  if (!encryptedAESKey) {
    throw new Error('[decryptAESKey] Missing encryptedAESKey!');
  }
  if (typeof window !== "undefined" || typeof crypto.privateDecrypt !== "function") {
    throw new Error("RSA decryption is only supported in Node.js for this function.");
  }

  try {
    const privateKey = process.env.RSA_PRIVATE_KEY.replace(/\\n/g, '\n');
    return crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encryptedAESKey, "base64")
    );
  } catch (err) {
    console.error('[decryptAESKey] Error:', err);
    throw err;
  }
}

/**
 * Encrypts the details field for a note template section using user's master key
 * Creates new IV for each encryption
 * @param {object} section - Section object containing details field
 * @param {Buffer} masterKeyBuffer - Unwrapped master AES key
 * @returns {object} { success, error, section }
 */
export function encryptNoteTemplateSectionDetails(section, masterKeyBuffer) {
  try {
    if (!section.details) {
      return { success: true, error: null, section };
    }

    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    const ivBase64 = generateRandomIVBase64();

    try {
      section.encrypted_details = encryptText(
        section.details,
        aesKeyBase64,
        ivBase64
      );
      section.details_iv = ivBase64;
      delete section.details;
      return { success: true, error: null, section };
    } catch (err) {
      console.error('[encryptNoteTemplateSectionDetails] Failed to encrypt details:', err);
      return { success: false, error: 'Failed to encrypt details', section: null };
    }
  } catch (err) {
    console.error('[encryptNoteTemplateSectionDetails] Error:', err);
    return { success: false, error: 'Failed to encrypt section', section: null };
  }
}

/**
 * Decrypts the details field for a section using user's master key
 * @param {object} section - Section object containing encrypted_details and details_iv
 * @param {Buffer} masterKeyBuffer - Unwrapped master AES key
 * @returns {object} { success, error, section }
 */
export function decryptNoteTemplateSectionDetails(section, masterKeyBuffer) {
  try {
    if (!section.encrypted_details || !section.details_iv) {
      return { success: true, error: null, section };
    }

    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    try {
      section.details = decryptText(
        section.encrypted_details,
        aesKeyBase64,
        section.details_iv
      );
      delete section.encrypted_details;
      delete section.details_iv;
      return { success: true, error: null, section };
    } catch (err) {
      console.error('[decryptNoteTemplateSectionDetails] Failed to decrypt details:', err);
      return { success: false, error: 'Failed to decrypt details', section: null };
    }
  } catch (err) {
    console.error('[decryptNoteTemplateSectionDetails] Error:', err);
    return { success: false, error: 'Failed to decrypt section', section: null };
  }
}

// PBKDF2-based refresh token hashing utilities (used for server-side refresh token storage)
export function hashToken(token, salt) {
  const HASH_ITERATIONS = 100000;
  const HASH_KEYLEN = 64;
  const HASH_DIGEST = 'sha512';
  const HASH_SALT_LENGTH = 16; // bytes
  if (!salt) salt = crypto.randomBytes(HASH_SALT_LENGTH).toString('hex');
  const derived = crypto.pbkdf2Sync(token, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
  return `${salt}$${derived}`;
}

export function verifyTokenHash(token, stored) {
  if (!stored) return false;
  const HASH_ITERATIONS = 100000;
  const HASH_KEYLEN = 64;
  const HASH_DIGEST = 'sha512';
  const parts = stored.split('$');
  if (parts.length !== 2) return false;
  const [salt, derived] = parts;
  if (!salt || !derived) return false;
  const test = crypto.pbkdf2Sync(token, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(derived, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// AES-256-GCM helpers for encrypting refresh tokens at rest.
// Expects process.env.REFRESH_TOKEN_AES_KEY_HEX to be a 64-character hex string (32 bytes).
export function encryptRefreshToken(plain) {
  const KEY_HEX = process.env.REFRESH_TOKEN_AES_KEY_HEX;
  if (!KEY_HEX) throw new Error('Missing REFRESH_TOKEN_AES_KEY_HEX');
  // expect hex string
  const KEY = Buffer.from(KEY_HEX, 'hex');
  if (KEY.length !== 32) throw new Error('REFRESH_TOKEN_AES_KEY_HEX must be 32 bytes (hex)');

  const iv = crypto.randomBytes(12); // 96-bit recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store iv (12) + tag (16) + ciphertext as base64
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptRefreshToken(tokenEncB64) {
  const KEY_HEX = process.env.REFRESH_TOKEN_AES_KEY_HEX;
  if (!KEY_HEX) throw new Error('Missing REFRESH_TOKEN_AES_KEY_HEX');
  const KEY = Buffer.from(KEY_HEX, 'hex');
  if (KEY.length !== 32) throw new Error('REFRESH_TOKEN_AES_KEY_HEX must be 32 bytes (hex)');

  const buf = Buffer.from(tokenEncB64 || '', 'base64');
  if (buf.length < 12 + 16) throw new Error('Invalid encrypted token format');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypts the text field for a note using user's master key
 * Creates new IV for each encryption
 * @param {object} note - Note object containing text field
 * @param {Buffer} masterKeyBuffer - Unwrapped master AES key
 * @returns {object} { success, error, value, iv }
 */
export function encryptNoteText(note, masterKeyBuffer) {
  try {
    if (!note.text) {
      return { success: true, error: null, value: null, iv: null };
    }

    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    const ivBase64 = generateRandomIVBase64();

    try {
      const encryptedText = encryptText(note.text, aesKeyBase64, ivBase64);
      return { success: true, error: null, value: encryptedText, iv: ivBase64 };
    } catch (err) {
      console.error('[encryptNoteText] Failed to encrypt text:', err);
      return { success: false, error: 'Failed to encrypt note text', value: null, iv: null };
    }
  } catch (err) {
    console.error('[encryptNoteText] Error:', err);
    return { success: false, error: 'Failed to encrypt note', value: null, iv: null };
  }
}

/**
 * Decrypts the text field for a note using user's master key
 * @param {object} note - Note object containing encrypted_text and text_iv
 * @param {Buffer} masterKeyBuffer - Unwrapped master AES key
 * @returns {object} { success, error, text }
 */
export function decryptNoteText(note, masterKeyBuffer) {
  try {
    if (!note.encrypted_text || !note.text_iv) {
      return { success: true, error: null, text: note.text || null };
    }

    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    try {
      const decryptedText = decryptText(note.encrypted_text, aesKeyBase64, note.text_iv);
      return { success: true, error: null, text: decryptedText };
    } catch (err) {
      console.error('[decryptNoteText] Failed to decrypt text:', err);
      return { success: false, error: 'Failed to decrypt note text', text: null };
    }
  } catch (err) {
    console.error('[decryptNoteText] Error:', err);
    return { success: false, error: 'Failed to decrypt note', text: null };
  }
}