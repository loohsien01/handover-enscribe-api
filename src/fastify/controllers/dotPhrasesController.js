import { z } from 'zod';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { dotPhraseSchema } from '../schemas/dotPhrase.js';
import { pgQueryOne, pgQueryRows, pgErrorMessage, pgCoerceBigIntFields } from '../../utils/pgQueryHelpers.js';

const dotPhrasesTable = '"dotPhrases"';

/**
 * Helper: Validates bigint ID format
 */
function isValidBigInt(id) {
  if (!id) return false;
  try {
    const parsed = BigInt(id);
    return parsed > 0n;
  } catch (error) {
    return false;
  }
}

/**
 * Generates a new AES key and encrypts it with RSA for storage.
 * Returns the encrypted AES key as base64 string.
 */
function generateEncryptedAESKey() {
  try {
    const { aesKey } = encryptionUtils.generateAESKeyAndIV();
    const encryptedAESKey = encryptionUtils.encryptAESKey(aesKey);
    return encryptedAESKey;
  } catch (err) {
    console.error('Failed to generate encrypted AES key:', err);
    throw new Error('Failed to generate encryption key');
  }
}

/**
 * Encrypts trigger and expansion fields for a dotPhrase object.
 * Generates a new AES key and IV for this specific dot phrase.
 * Returns { success, error, dotPhrase }.
 * @param {object} dotPhrase - DotPhrase object containing trigger and expansion.
 */
async function encryptDotPhraseFields(dotPhrase) {
  try {
    const encryptedAESKey = generateEncryptedAESKey();
    dotPhrase.encrypted_aes_key = encryptedAESKey;

    const ivBase64 = encryptionUtils.generateRandomIVBase64();
    dotPhrase.iv = ivBase64;

    const aesKey = encryptionUtils.decryptAESKey(encryptedAESKey);
    const aesKeyBase64 = Buffer.isBuffer(aesKey) ? aesKey.toString('base64') : aesKey;

    if (dotPhrase.trigger) {
      try {
        dotPhrase.encrypted_trigger = encryptionUtils.encryptText(dotPhrase.trigger, aesKeyBase64, ivBase64);
        delete dotPhrase.trigger;
      } catch (err) {
        console.error('Failed to encrypt trigger:', err);
        return { success: false, error: 'Failed to encrypt trigger', dotPhrase: null };
      }
    }

    if (dotPhrase.expansion) {
      try {
        dotPhrase.encrypted_expansion = encryptionUtils.encryptText(dotPhrase.expansion, aesKeyBase64, ivBase64);
        delete dotPhrase.expansion;
      } catch (err) {
        console.error('Failed to encrypt expansion:', err);
        return { success: false, error: 'Failed to encrypt expansion', dotPhrase: null };
      }
    }

    return { success: true, error: null, dotPhrase };
  } catch (err) {
    console.error('Failed to encrypt dot phrase fields:', err);
    return { success: false, error: 'Failed to encrypt fields', dotPhrase: null };
  }
}

/**
 * Decrypts trigger and expansion fields for a dotPhrase object.
 * Returns { success, error, dotPhrase }.
 * @param {object} dotPhrase - DotPhrase object containing encrypted fields.
 */
async function decryptDotPhraseFields(dotPhrase) {
  try {
    if (!dotPhrase.encrypted_aes_key || !dotPhrase.iv) {
      return { success: false, error: 'Missing encryption key or IV for dot phrase', dotPhrase: null };
    }

    const aesKey = encryptionUtils.decryptAESKey(dotPhrase.encrypted_aes_key);

    if (dotPhrase.encrypted_trigger) {
      try {
        dotPhrase.trigger = encryptionUtils.decryptText(dotPhrase.encrypted_trigger, aesKey, dotPhrase.iv);
      } catch (err) {
        console.error('Failed to decrypt trigger:', err);
        return { success: false, error: 'Failed to decrypt trigger', dotPhrase: null };
      }
    }

    if (dotPhrase.encrypted_expansion) {
      try {
        dotPhrase.expansion = encryptionUtils.decryptText(dotPhrase.encrypted_expansion, aesKey, dotPhrase.iv);
      } catch (err) {
        console.error('Failed to decrypt expansion:', err);
        return { success: false, error: 'Failed to decrypt expansion', dotPhrase: null };
      }
    }

    delete dotPhrase.encrypted_trigger;
    delete dotPhrase.encrypted_expansion;
    delete dotPhrase.encrypted_aes_key;
    delete dotPhrase.iv;

    return { success: true, error: null, dotPhrase };
  } catch (err) {
    console.error('Failed to decrypt dot phrase fields:', err);
    return { success: false, error: 'Failed to decrypt fields', dotPhrase: null };
  }
}

/**
 * Gets all dot phrases for a specific user with decryption.
 * This function can be called from other modules (like prompt-llm).
 * @param {string} userId - The user ID to get dot phrases for.
 * @param {object} [_supabaseClient] - Deprecated; kept for call-site compatibility.
 * @returns {Promise<{success: boolean, data: Array, error: string|null}>}
 */
export async function getAllDotPhrasesForUser(userId, _supabaseClient = null) {
  try {
    console.log(`[getAllDotPhrasesForUser] Fetching dot phrases for user: ${userId}`);

    const data = await pgQueryRows(
      `SELECT *
         FROM ${dotPhrasesTable}
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );

    if (data.length === 0) {
      console.log('[getAllDotPhrasesForUser] No dot phrases found for user');
      return { success: true, data: [], error: null };
    }

    console.log(`[getAllDotPhrasesForUser] Found ${data.length} dot phrases, decrypting...`);

    const decryptedDotPhrases = [];
    for (const dotPhrase of data) {
      if (dotPhrase.encrypted_trigger || dotPhrase.encrypted_expansion) {
        const decryptResult = await decryptDotPhraseFields(dotPhrase);
        if (decryptResult.success) {
          decryptedDotPhrases.push(dotPhrase);
        } else {
          console.error(`[getAllDotPhrasesForUser] Failed to decrypt dot phrase ${dotPhrase.id}:`, decryptResult.error);
          decryptedDotPhrases.push(dotPhrase);
        }
      } else {
        decryptedDotPhrases.push(dotPhrase);
      }
    }

    console.log(`[getAllDotPhrasesForUser] Successfully processed ${decryptedDotPhrases.length} dot phrases`);
    return { success: true, data: decryptedDotPhrases.map((row) => pgCoerceBigIntFields(row, ['id'])), error: null };
  } catch (err) {
    console.error('[getAllDotPhrasesForUser] Unexpected error:', err);
    return { success: false, data: [], error: pgErrorMessage(err) };
  }
}

/**
 * Gets a single dot phrase by ID for the authenticated user
 */
export async function getOneDotPhrase(userId, dotPhraseId, _supabase) {
  try {
    if (!isValidBigInt(dotPhraseId)) {
      return { success: false, error: 'Invalid dot phrase ID format', data: null };
    }

    const data = await pgQueryOne(
      `SELECT *
         FROM ${dotPhrasesTable}
        WHERE id = $1 AND user_id = $2`,
      [dotPhraseId, userId]
    );

    if (!data) {
      return { success: false, error: 'Dot phrase not found', data: null };
    }

    if (data.encrypted_trigger || data.encrypted_expansion) {
      const decryptResult = await decryptDotPhraseFields(data);
      if (!decryptResult.success) {
        return { success: false, error: decryptResult.error, data: null };
      }
    }

    return { success: true, error: null, data: pgCoerceBigIntFields(data, ['id']) };
  } catch (err) {
    console.error('Error fetching single dot phrase:', err);
    return { success: false, error: pgErrorMessage(err), data: null };
  }
}

/**
 * Creates a new dot phrase for the authenticated user
 */
export async function createDotPhrase(userId, trigger, expansion, _supabase) {
  try {
    if (!trigger || !expansion) {
      return { success: false, error: 'trigger and expansion are required', data: null };
    }

    const dotPhrase = {
      trigger,
      expansion,
      user_id: userId,
    };

    console.log('[createDotPhrase] Creating dotPhrase:', dotPhrase);

    const encryptionResult = await encryptDotPhraseFields(dotPhrase);
    if (!encryptionResult.success) {
      return { success: false, error: encryptionResult.error, data: null };
    }

    const enc = encryptionResult.dotPhrase;

    const insertData = await pgQueryOne(
      `INSERT INTO ${dotPhrasesTable} (
         user_id, encrypted_aes_key, iv, encrypted_trigger, encrypted_expansion
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        userId,
        enc.encrypted_aes_key,
        enc.iv,
        enc.encrypted_trigger ?? null,
        enc.encrypted_expansion ?? null,
      ]
    );

    return { success: true, error: null, data: pgCoerceBigIntFields(insertData, ['id']) };
  } catch (err) {
    console.error('Error creating dot phrase:', err);
    return { success: false, error: pgErrorMessage(err), data: null };
  }
}

/**
 * Updates an existing dot phrase for the authenticated user
 */
export async function updateDotPhrase(userId, dotPhraseId, updateData, _supabase) {
  try {
    if (!isValidBigInt(dotPhraseId)) {
      return { success: false, error: 'Invalid dot phrase ID format', data: null };
    }

    const dotPhrase = { ...updateData };
    dotPhrase.id = dotPhraseId;
    dotPhrase.user_id = userId;

    console.log('[updateDotPhrase] Received body:', updateData);
    console.log('[updateDotPhrase] Parsed dotPhrase:', dotPhrase);

    let encryptedFields = null;

    if (updateData.trigger !== undefined || updateData.expansion !== undefined) {
      if (updateData.trigger !== undefined) dotPhrase.trigger = updateData.trigger;
      if (updateData.expansion !== undefined) dotPhrase.expansion = updateData.expansion;

      console.log('[updateDotPhrase] About to encrypt fields:', {
        trigger: dotPhrase.trigger,
        expansion: dotPhrase.expansion,
      });

      const encryptionResult = await encryptDotPhraseFields(dotPhrase);
      if (!encryptionResult.success) {
        return { success: false, error: encryptionResult.error, data: null };
      }

      encryptedFields = encryptionResult.dotPhrase;
      console.log('[updateDotPhrase] Encryption successful, encrypted fields added');
    }

    console.log('[updateDotPhrase] Final dotPhrase before update:', dotPhrase);

    let updatedData;

    if (encryptedFields) {
      updatedData = await pgQueryOne(
        `UPDATE ${dotPhrasesTable}
            SET encrypted_aes_key = $1,
                iv = $2,
                encrypted_trigger = $3,
                encrypted_expansion = $4,
                updated_at = NOW()
          WHERE id = $5 AND user_id = $6
          RETURNING *`,
        [
          encryptedFields.encrypted_aes_key,
          encryptedFields.iv,
          encryptedFields.encrypted_trigger ?? null,
          encryptedFields.encrypted_expansion ?? null,
          dotPhraseId,
          userId,
        ]
      );
    } else {
      updatedData = await pgQueryOne(
        `SELECT * FROM ${dotPhrasesTable} WHERE id = $1 AND user_id = $2`,
        [dotPhraseId, userId]
      );
    }

    if (!updatedData) {
      return { success: false, error: 'Dot phrase not found or not authorized to update', data: null };
    }

    console.log('[updateDotPhrase] Update successful:', updatedData);
    return { success: true, error: null, data: pgCoerceBigIntFields(updatedData, ['id']) };
  } catch (err) {
    console.error('Error updating dot phrase:', err);
    return { success: false, error: pgErrorMessage(err), data: null };
  }
}

/**
 * Deletes a dot phrase for the authenticated user
 */
export async function deleteDotPhrase(userId, dotPhraseId, _supabase) {
  try {
    if (!isValidBigInt(dotPhraseId)) {
      return { success: false, error: 'Invalid dot phrase ID format', data: null };
    }

    const data = await pgQueryOne(
      `DELETE FROM ${dotPhrasesTable}
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [dotPhraseId, userId]
    );

    if (!data) {
      return { success: false, error: 'Dot phrase not found or not authorized to delete', data: null };
    }

    return { success: true, error: null, data: pgCoerceBigIntFields(data, ['id']) };
  } catch (err) {
    console.error('Error deleting dot phrase:', err);
    return { success: false, error: pgErrorMessage(err), data: null };
  }
}
