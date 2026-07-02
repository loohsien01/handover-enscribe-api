import * as encryptionUtils from './encryptionUtils.js';
import { pgQueryOne } from './pgQueryHelpers.js';
import { querySupabasePostgres } from './supabasePostgresPool.js';

const patientEncounterTable = '"patientEncounters"';

/**
 * Fetches a patient encounter and decrypts its AES key
 * Used across multiple endpoints to reduce code duplication
 *
 * @param {object} _supabase - kept for call-site compat; DB uses pg pool
 * @param {number} patientEncounterId - ID of the patient encounter
 * @param {string} [userId] - when provided, enforces ownership (pool bypasses RLS)
 * @returns {object} { success, data (encounter), aes_key, iv, error }
 */
export async function getPatientEncounterWithDecryptedKey(_supabase, patientEncounterId, userId) {
    try {
        const params = [patientEncounterId];
        let sql = `SELECT * FROM public.${patientEncounterTable} WHERE id = $1`;
        if (userId) {
            sql += ' AND user_id = $2';
            params.push(userId);
        }
        sql += ' LIMIT 1';

        const patientEncounter = await pgQueryOne(sql, params);

        if (!patientEncounter) {
            return {
                success: false,
                error: 'Patient encounter not found',
                statusCode: 404
            };
        }

        if (!patientEncounter.encrypted_aes_key || !patientEncounter.iv) {
            console.error('Missing encryption keys for patient encounter:', patientEncounterId);
            return {
                success: false,
                error: 'Missing encryption keys for patient encounter',
                statusCode: 400
            };
        }

        const aes_key = encryptionUtils.decryptAESKey(patientEncounter.encrypted_aes_key);
        const iv = patientEncounter.iv;

        return {
            success: true,
            data: patientEncounter,
            aes_key,
            iv
        };
    } catch (err) {
        console.error('Error fetching patient encounter with decrypted key:', err);
        return {
            success: false,
            error: err.message,
            statusCode: 500
        };
    }
}

/**
 * Fetches a patient encounter and a related transcript with decryption
 * Useful when you need both encounter and transcript data
 *
 * @param {object} supabase - kept for call-site compat
 * @param {number} patientEncounterId - ID of the patient encounter
 * @param {string} [userId] - when provided, enforces ownership on encounter lookup
 * @returns {object} { success, encounter, transcript, aes_key, iv, error, statusCode }
 */
export async function getPatientEncounterWithTranscript(supabase, patientEncounterId, userId) {
    try {
        const encounterResult = await getPatientEncounterWithDecryptedKey(supabase, patientEncounterId, userId);
        if (!encounterResult.success) {
            return encounterResult;
        }

        const { data: patientEncounter, aes_key, iv } = encounterResult;
        console.log('[src/utils/patientEncounterUtils.js] Fetched patient encounter:', patientEncounter);

        const recording = await pgQueryOne(
            `SELECT id FROM public.recordings WHERE "patientEncounter_id" = $1 LIMIT 1`,
            [patientEncounterId]
        );

        if (!recording) {
            return {
                success: false,
                error: 'Patient encounter has no associated recording',
                statusCode: 400
            };
        }

        const transcript = await pgQueryOne(
            `SELECT * FROM public.transcripts WHERE recording_id = $1 LIMIT 1`,
            [recording.id]
        );

        return {
            success: true,
            encounter: patientEncounter,
            transcript: transcript || null,
            aes_key,
            iv
        };
    } catch (err) {
        console.error('Error fetching patient encounter with transcript:', err);
        return {
            success: false,
            error: err.message,
            statusCode: 500
        };
    }
}
