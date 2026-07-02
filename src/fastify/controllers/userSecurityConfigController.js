/**
 * User Security Config Controller
 * Backend-only centralized functions for master key management
 * No API routes - used internally by other controllers
 */

import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { pgQueryOne, pgQueryRows } from '../../utils/pgQueryHelpers.js';
import { querySupabasePostgres } from '../../utils/supabasePostgresPool.js';

const userSecurityConfigTable = '"userSecurityConfigs"';

/**
 * Gets the system master key using service role credentials
 * System key has user_id = NULL and decrypts all system-provided templates
 * @returns {object} { success, error, masterKey: Buffer }
 */
export async function getSystemMasterKey() {
  try {
    const row = await pgQueryOne(
      `SELECT wrapped_master_key
         FROM public.${userSecurityConfigTable}
        WHERE user_id IS NULL
        LIMIT 1`
    );

    if (!row) {
      console.error('[getSystemMasterKey] System key not found');
      return { success: false, error: 'System key not found', masterKey: null };
    }

    try {
      const masterKeyBuffer = encryptionUtils.decryptAESKey(row.wrapped_master_key);
      return { success: true, error: null, masterKey: masterKeyBuffer };
    } catch (err) {
      console.error('[getSystemMasterKey] Failed to decrypt system key:', err);
      return { success: false, error: 'Failed to decrypt system key', masterKey: null };
    }
  } catch (err) {
    console.error('[getSystemMasterKey] Unexpected error:', err);
    return { success: false, error: 'Internal server error', masterKey: null };
  }
}

/**
 * Gets or creates the user's master encryption key from userSecurityConfigs
 * @param {object} _supabase - kept for call-site compat; DB uses pg pool
 * @param {string} userId - User ID (UUID)
 * @returns {object} { success, error, masterKey: Buffer }
 */
export async function getOrCreateUserMasterKey(_supabase, userId) {
  try {
    const rows = await pgQueryRows(
      `SELECT wrapped_master_key
         FROM public.${userSecurityConfigTable}
        WHERE user_id = $1`,
      [userId]
    );

    if (rows.length > 1) {
      console.error('[getOrCreateUserMasterKey] Data integrity error: multiple configs found');
      return { success: false, error: 'Data integrity error', masterKey: null };
    }

    if (rows.length === 1) {
      try {
        const masterKeyBuffer = encryptionUtils.decryptAESKey(rows[0].wrapped_master_key);
        return { success: true, error: null, masterKey: masterKeyBuffer };
      } catch (err) {
        console.error('[getOrCreateUserMasterKey] Failed to decrypt master key:', err);
        return { success: false, error: 'Failed to decrypt master key', masterKey: null };
      }
    }

    try {
      const { aesKey: newAesKeyBase64 } = encryptionUtils.generateAESKeyAndIV();
      const wrappedMasterKey = encryptionUtils.encryptAESKey(newAesKeyBase64);

      await querySupabasePostgres(
        `INSERT INTO public.${userSecurityConfigTable} (user_id, wrapped_master_key)
         VALUES ($1, $2)`,
        [userId, wrappedMasterKey]
      );

      const masterKeyBuffer = encryptionUtils.decryptAESKey(wrappedMasterKey);
      return { success: true, error: null, masterKey: masterKeyBuffer };
    } catch (err) {
      console.error('[getOrCreateUserMasterKey] Error creating master key:', err);
      return { success: false, error: 'Failed to create master key', masterKey: null };
    }
  } catch (err) {
    console.error('[getOrCreateUserMasterKey] Unexpected error:', err);
    return { success: false, error: 'Internal server error', masterKey: null };
  }
}
