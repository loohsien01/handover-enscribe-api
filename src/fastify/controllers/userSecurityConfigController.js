/**
 * User Security Config Controller
 * Backend-only centralized functions for master key management
 * No API routes - used internally by other controllers
 */

import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { createClient } from '@supabase/supabase-js';

const userSecurityConfigTable = 'userSecurityConfigs';

/**
 * Gets the system master key using service role credentials
 * System key has user_id = NULL and decrypts all system-provided templates
 * @returns {object} { success, error, masterKey: Buffer }
 */
export async function getSystemMasterKey() {
  try {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabaseAdmin
      .from(userSecurityConfigTable)
      .select('wrapped_master_key')
      .is('user_id', null)
      .single();

    if (error) {
      console.error('[getSystemMasterKey] Database error:', error);
      return { success: false, error: 'Failed to fetch system key', masterKey: null };
    }

    if (!data) {
      console.error('[getSystemMasterKey] System key not found');
      return { success: false, error: 'System key not found', masterKey: null };
    }

    try {
      const masterKeyBuffer = encryptionUtils.decryptAESKey(data.wrapped_master_key);
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
 * @param {object} supabase - Supabase client
 * @param {string} userId - User ID (UUID)
 * @returns {object} { success, error, masterKey: Buffer }
 */
export async function getOrCreateUserMasterKey(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from(userSecurityConfigTable)
      .select('wrapped_master_key')
      .eq('user_id', userId);

    if (error) {
      console.error('[getOrCreateUserMasterKey] Database error:', error);
      return { success: false, error: 'Failed to fetch security config', masterKey: null };
    }

    if (data && data.length > 1) {
      console.error('[getOrCreateUserMasterKey] Data integrity error: multiple configs found');
      return { success: false, error: 'Data integrity error', masterKey: null };
    }

    if (data && data.length === 1) {
      try {
        const masterKeyBuffer = encryptionUtils.decryptAESKey(data[0].wrapped_master_key);
        return { success: true, error: null, masterKey: masterKeyBuffer };
      } catch (err) {
        console.error('[getOrCreateUserMasterKey] Failed to decrypt master key:', err);
        return { success: false, error: 'Failed to decrypt master key', masterKey: null };
      }
    }

    // Create new master key
    try {
      const { aesKey: newAesKeyBase64 } = encryptionUtils.generateAESKeyAndIV();
      const wrappedMasterKey = encryptionUtils.encryptAESKey(newAesKeyBase64);

      const { error: insertError } = await supabase
        .from(userSecurityConfigTable)
        .insert([{ user_id: userId, wrapped_master_key: wrappedMasterKey }]);

      if (insertError) {
        console.error('[getOrCreateUserMasterKey] Failed to insert security config:', insertError);
        return { success: false, error: 'Failed to create security config', masterKey: null };
      }

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
