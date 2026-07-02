/**
 * Patient Encounters Controller
 * Handles all patient encounter CRUD operations, batch operations, and completion
 * Validation is handled in routes using Zod schemas
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import { pgQueryOne, pgQueryRows, pgErrorMessage } from '../../utils/pgQueryHelpers.js';
import { querySupabasePostgres } from '../../utils/supabasePostgresPool.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import {
  normalizeRecordingStorageKey,
  createRecordingDownloadUrl,
} from '../../utils/recordingsStorage.js';
import { getPatientEncounterWithDecryptedKey } from '../../utils/patientEncounterUtils.js';
import {
  encryptTranscriptPlaintextWithMasterKey,
  decryptTranscriptRowWithMasterKey,
} from '../../utils/transcriptTextCrypto.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';
import {
  USAGE_METRICS,
  UsageLimitExceededError,
  assertUsageAllowed,
  recordUsageSuccess,
  resolveBillingContext,
} from '../../utils/billingUsage.js';


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

function stripPatientEncounterEncryptionFields(encounter) {
  delete encounter.encrypted_name;
  delete encounter.encrypted_aes_key;
  delete encounter.iv;
}

/**
 * Get all patient encounters for the authenticated user
 * GET /api/patient-encounters
 * Query decryptName (default false): when true, decrypt patient name; otherwise strip encrypted fields only.
 */
export async function getAllPatientEncounters(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { limit, offset, decryptName } = request.query;

    const data = await pgQueryRows(
      `SELECT *
         FROM "patientEncounters"
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    );

    for (const encounter of data) {
      if (!decryptName) {
        stripPatientEncounterEncryptionFields(encounter);
        continue;
      }

      if (!encounter.encrypted_aes_key || !encounter.iv) {
        console.error(`Missing encryption keys for encounter ${encounter.id}`);
        stripPatientEncounterEncryptionFields(encounter);
        continue;
      }

      const aes_key = encryptionUtils.decryptAESKey(encounter.encrypted_aes_key);
      if (encounter.encrypted_name) {
        encounter.name = encryptionUtils.decryptText(
          encounter.encrypted_name,
          aes_key,
          encounter.iv
        );
        delete encounter.encrypted_name;
      }

      delete encounter.encrypted_aes_key;
      delete encounter.iv;
    }

    return reply.status(200).send(data);
  } catch (error) {
    console.error('Error fetching patient encounters:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Get a specific patient encounter by ID
 * GET /api/patient-encounters/:id
 * Query decryptName (default false): when true, decrypt patient name; otherwise strip encrypted fields only.
 */
export async function getPatientEncounter(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;
    const { decryptName } = request.query;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid ID format - must be a numeric ID' });
    }

    const encounter = await pgQueryOne(
      `SELECT *
         FROM "patientEncounters"
        WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (!encounter) {
      return reply.status(404).send({ error: 'Encounter not found' });
    }

    if (!decryptName) {
      stripPatientEncounterEncryptionFields(encounter);
      return reply.status(200).send(encounter);
    }

    if (encounter.encrypted_aes_key && encounter.iv && encounter.encrypted_name) {
      const aes_key = encryptionUtils.decryptAESKey(encounter.encrypted_aes_key);
      encounter.name = encryptionUtils.decryptText(
        encounter.encrypted_name,
        aes_key,
        encounter.iv
      );
      delete encounter.encrypted_name;
    }

    delete encounter.encrypted_aes_key;
    delete encounter.iv;

    return reply.status(200).send(encounter);
  } catch (error) {
    console.error('Error fetching patient encounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Create a new patient encounter
 * POST /api/patient-encounters
 */
export async function createPatientEncounter(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Request body is already validated by route
    const encounter = request.body;

    // Generate AES key and IV for patient encounter
    const { aesKey, iv } = encryptionUtils.generateAESKeyAndIV();
    const encrypted_aes_key = encryptionUtils.encryptAESKey(aesKey);

    // Encrypt patient name
    let encrypted_name = null;
    if (encounter.name) {
      encrypted_name = encryptionUtils.encryptText(encounter.name, aesKey, iv);
    }

    const data = await pgQueryOne(
      `INSERT INTO "patientEncounters" (
         user_id, encrypted_name, iv, encrypted_aes_key, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [user.id, encrypted_name, iv, encrypted_aes_key]
    );

    if (!data) {
      return reply.status(500).send({ error: 'Failed to create patient encounter' });
    }

    // Decrypt name for response and clean up encryption fields
    if (data.encrypted_name) {
      data.name = encryptionUtils.decryptText(data.encrypted_name, aesKey, data.iv);
      delete data.encrypted_name;
    }
    delete data.encrypted_aes_key;
    delete data.iv;

    return reply.status(201).send(data);
  } catch (error) {
    console.error('Error creating patient encounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Update a patient encounter
 * PATCH /api/patient-encounters/:id
 * 
 * Frontend schema: { name?, reason?, appointmentDate?, duration?, ... }
 * Database schema: { encrypted_name?, encrypted_aes_key?, iv?, reason?, ... }
 * 
 * If name is provided, it will be encrypted using AES-256 with existing encryption key
 */
export async function updatePatientEncounter(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid ID format - must be a numeric ID' });
    }

    // Request body is already validated by route
    const updates = request.body;

    // Step 1: Fetch existing encounter to verify it exists and get encryption key
    const encounter = await pgQueryOne(
      `SELECT *
         FROM "patientEncounters"
        WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (!encounter) {
      return reply.status(404).send({ error: 'Encounter not found' });
    }

    // Step 2: Prepare update — only name is user-editable today
    let encrypted_name = encounter.encrypted_name;
    if (updates.name !== undefined) {
      const aes_key = encryptionUtils.decryptAESKey(encounter.encrypted_aes_key);
      encrypted_name = encryptionUtils.encryptText(updates.name, aes_key, encounter.iv);
    }

    // Step 3: Update in database
    const updatedData = await pgQueryOne(
      `UPDATE "patientEncounters"
          SET encrypted_name = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3
        RETURNING *`,
      [encrypted_name, id, user.id]
    );

    if (!updatedData) {
      return reply.status(404).send({ error: 'Encounter not found' });
    }

    // Step 4: Decrypt response for client
    if (updatedData.encrypted_aes_key && updatedData.iv && updatedData.encrypted_name) {
      const aes_key = encryptionUtils.decryptAESKey(updatedData.encrypted_aes_key);
      updatedData.name = encryptionUtils.decryptText(
        updatedData.encrypted_name,
        aes_key,
        updatedData.iv
      );
      delete updatedData.encrypted_name;
    }

    return reply.status(200).send(updatedData);
  } catch (error) {
    console.error('Error updating patient encounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Delete a patient encounter
 * DELETE /api/patient-encounters/:id
 */
export async function deletePatientEncounter(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid ID format - must be a numeric ID' });
    }

    const data = await pgQueryOne(
      `DELETE FROM "patientEncounters"
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Encounter not found' });
    }

    return reply.status(200).send({ success: true, data });
  } catch (error) {
    console.error('Error deleting patient encounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Get a complete patient encounter bundle
 * GET /api/patient-encounters/complete/:id
 * 
 * Retrieves a patient encounter with all linked data:
 * - Patient encounter details
 * - Associated recording
 * - Transcript for the recording (if present), decrypted with user master key
 * - All notes for the encounter
 * 
 * All encrypted fields are decrypted before returning
 */
export async function getCompletePatientEncounter(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid ID format - must be a numeric ID' });
    }

    const encounterId = parseInt(id);

    // Step 0: Fetch patient encounter
    const encounterData = await pgQueryOne(
      `SELECT *
         FROM "patientEncounters"
        WHERE id = $1 AND user_id = $2`,
      [encounterId, user.id]
    );

    if (!encounterData) {
      return reply.status(404).send({ error: 'Encounter not found' });
    }

    // Decrypt AES key for this encounter
    const aes_key = encryptionUtils.decryptAESKey(encounterData.encrypted_aes_key);

    // Decrypt encounter name
    if (encounterData.encrypted_name) {
      encounterData.name = encryptionUtils.decryptText(
        encounterData.encrypted_name,
        aes_key,
        encounterData.iv
      );
      delete encounterData.encrypted_name;
    }
    delete encounterData.encrypted_aes_key;
    delete encounterData.iv;

    // Step 1: Fetch recording linked to encounter
    console.log('Step 1: Fetching recording linked to encounterId:', encounterId);
    const recordingData = await pgQueryOne(
      `SELECT *
         FROM recordings
        WHERE "patientEncounter_id" = $1 AND user_id = $2`,
      [encounterId, user.id]
    );

    let recording = null;
    if (recordingData) {
      recording = recordingData;
      delete recording.iv;
    } else {
      console.warn('No recording found for encounterId:', encounterId);
    }

    // Step 1.5: Generate/refresh signed URL if needed
    if (recording && recording.recording_file_path) {
      const needNewSignedUrl = !recording.recording_file_signed_url || 
                               new Date(recording.recording_file_signed_url_expiry) < new Date();
      
      if (needNewSignedUrl) {
        console.log('Step 1.5: Generating signed URL for recording file');

        const normalizedPath = normalizeRecordingStorageKey(recording.recording_file_path);
        console.log('Creating signed URL for recording file:', normalizedPath);
        const expirySeconds = 60 * 60; // 1 hour

        try {
          const signedUrl = await createRecordingDownloadUrl(supabase, normalizedPath, expirySeconds);
          const now = new Date();
          const expiresAt = new Date(now.getTime() + expirySeconds * 1000).toISOString();

          recording.recording_file_signed_url = signedUrl;
          recording.recording_file_signed_url_expiry = expiresAt;

          try {
            await querySupabasePostgres(
              `UPDATE recordings
                  SET recording_file_signed_url = $1,
                      recording_file_signed_url_expiry = $2
                WHERE id = $3 AND user_id = $4`,
              [
                recording.recording_file_signed_url,
                recording.recording_file_signed_url_expiry,
                recording.id,
                user.id,
              ]
            );
          } catch (updateError) {
            console.warn(
              'Error updating recording signed URL (continuing):',
              updateError instanceof Error ? updateError.message : updateError
            );
          }
        } catch (signedError) {
          console.warn(
            'Signed URL error (continuing without signed URL):',
            signedError instanceof Error ? signedError.message : signedError
          );
          recording.recording_file_signed_url = null;
          recording.recording_file_signed_url_expiry = null;
        }
      }
    }

    let transcript = null;
    if (recording?.id) {
      const transcriptData = await pgQueryOne(
        `SELECT *
           FROM transcripts
          WHERE recording_id = $1 AND user_id = $2`,
        [recording.id, user.id]
      );

      if (transcriptData) {
        const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, encounterData.user_id);
        if (keyResult.success) {
          const dr = decryptTranscriptRowWithMasterKey(transcriptData, keyResult.masterKey);
          if (!dr.success) {
            return reply.status(400).send({ error: dr.error });
          }
          transcript = dr.transcript;
        } else {
          console.error('Failed to get master key for transcript decryption:', keyResult.error);
          delete transcriptData.encrypted_transcript_text;
          delete transcriptData.iv;
          transcriptData.transcript_text = null;
          transcript = transcriptData;
        }
      }
    }

    // Step 2: Fetch notes for encounter
    console.log('Step 2: Fetching notes for encounterId:', encounterId);
    const notesData = await pgQueryRows(
      `SELECT *
         FROM notes
        WHERE "patientEncounter_id" = $1 AND user_id = $2`,
      [encounterId, user.id]
    );

    let encounterNotes = [];
    if (notesData && Array.isArray(notesData)) {
      // Get user's master key for note decryption
      const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, encounterData.user_id);
      if (keyResult.success) {
        const masterKey = keyResult.masterKey;
        
        // Decrypt note texts
        for (const note of notesData) {
          if (note.encrypted_text) {
            try {
              note.text = encryptionUtils.decryptText(
                note.encrypted_text,
                masterKey,
                note.text_iv
              );
              delete note.encrypted_text;
            } catch (decryptError) {
              console.error('Failed to decrypt note:', note.id, decryptError.message);
              note.text = null;
            }
          }
          delete note.text_iv;
          encounterNotes.push(note);
        }
      } else {
        console.error('Failed to get master key for note decryption:', keyResult.error);
        // Push notes without decryption
        for (const note of notesData) {
          delete note.encrypted_text;
          delete note.text_iv;
          encounterNotes.push(note);
        }
      }
    }

    // Return complete bundle
    return reply.status(200).send({
      patientEncounter: encounterData,
      recording: recording || null,
      transcript: transcript || null,
      notes: encounterNotes,
    });
  } catch (error) {
    console.error('Error fetching complete patient encounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Build { patientEncounter, recording, note, transcript } for a note id — same shape as POST /api/patient-encounters/complete.
 * Used by GET /api/jobs/prompt-llm/:jobId/encounter-bundle. Caller must use user-scoped Supabase (JWT).
 *
 * @param {*} supabase - Supabase client (user JWT)
 * @param {{ id: string }} user
 * @param {string|number|bigint} noteId
 * @returns {Promise<{ patientEncounter: object, recording: object|null, note: object, transcript: object|null }>}
 */
export async function getPatientEncounterBundleByNoteId(supabase, user, noteId) {
  if (!user?.id) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }

  const idStr = noteId != null ? String(noteId) : '';
  if (!isValidBigInt(idStr)) {
    const err = new Error('Invalid note ID format');
    err.statusCode = 400;
    throw err;
  }

  const noteRow = await pgQueryOne(
    `SELECT *
       FROM notes
      WHERE id = $1 AND user_id = $2`,
    [idStr, user.id]
  );

  if (!noteRow) {
    const err = new Error('Note not found');
    err.statusCode = 404;
    throw err;
  }

  const encounterId = noteRow.patientEncounter_id;
  if (encounterId == null) {
    const err = new Error('Note has no patient encounter');
    err.statusCode = 404;
    throw err;
  }

  const encounterData = await pgQueryOne(
    `SELECT *
       FROM "patientEncounters"
      WHERE id = $1 AND user_id = $2`,
    [encounterId, user.id]
  );

  if (!encounterData) {
    const err = new Error('Encounter not found');
    err.statusCode = 404;
    throw err;
  }

  const aes_key = encryptionUtils.decryptAESKey(encounterData.encrypted_aes_key);

  if (encounterData.encrypted_name) {
    encounterData.name = encryptionUtils.decryptText(encounterData.encrypted_name, aes_key, encounterData.iv);
    delete encounterData.encrypted_name;
  }
  delete encounterData.encrypted_aes_key;
  delete encounterData.iv;

  const recordingData = await pgQueryOne(
    `SELECT *
       FROM recordings
      WHERE "patientEncounter_id" = $1 AND user_id = $2`,
    [encounterId, user.id]
  );

  let recording = null;
  if (recordingData) {
    recording = recordingData;
    delete recording.iv;
  }

  if (recording && recording.recording_file_path) {
    const needNewSignedUrl =
      !recording.recording_file_signed_url || new Date(recording.recording_file_signed_url_expiry) < new Date();

    if (needNewSignedUrl) {
      const normalizedPath = normalizeRecordingStorageKey(recording.recording_file_path);
      const expirySeconds = 60 * 60;

      try {
        const signedUrl = await createRecordingDownloadUrl(supabase, normalizedPath, expirySeconds);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + expirySeconds * 1000).toISOString();
        recording.recording_file_signed_url = signedUrl;
        recording.recording_file_signed_url_expiry = expiresAt;

        const { rowCount } = await querySupabasePostgres(
          `UPDATE recordings
              SET recording_file_signed_url = $1,
                  recording_file_signed_url_expiry = $2
            WHERE id = $3 AND user_id = $4`,
          [
            recording.recording_file_signed_url,
            recording.recording_file_signed_url_expiry,
            recording.id,
            user.id,
          ]
        );

        if (rowCount === 0) {
          const err = new Error('Failed to update recording signed URL');
          err.statusCode = 500;
          throw err;
        }
      } catch (signedError) {
        const err = new Error(
          'Failed to create signed URL: ' +
            (signedError instanceof Error ? signedError.message : String(signedError))
        );
        err.statusCode = 500;
        throw err;
      }
    }
  }

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, encounterData.user_id);
  const noteOut = { ...noteRow };
  if (keyResult.success) {
    const masterKey = keyResult.masterKey;
    if (noteOut.encrypted_text) {
      try {
        noteOut.text = encryptionUtils.decryptText(noteOut.encrypted_text, masterKey, noteOut.text_iv);
        delete noteOut.encrypted_text;
      } catch (decryptError) {
        console.error('Failed to decrypt note:', noteOut.id, decryptError.message);
        noteOut.text = null;
        delete noteOut.encrypted_text;
      }
    }
    delete noteOut.text_iv;
  } else {
    console.error('Failed to get master key for note decryption:', keyResult.error);
    delete noteOut.encrypted_text;
    delete noteOut.text_iv;
  }

  let transcriptOut = null;
  if (recording?.id) {
    const transcriptData = await pgQueryOne(
      `SELECT *
         FROM transcripts
        WHERE recording_id = $1 AND user_id = $2`,
      [recording.id, user.id]
    );

    if (transcriptData) {
      const tKey = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, encounterData.user_id);
      if (tKey.success) {
        const dr = decryptTranscriptRowWithMasterKey(transcriptData, tKey.masterKey);
        if (!dr.success) {
          const err = new Error(dr.error);
          err.statusCode = 400;
          throw err;
        }
        transcriptOut = dr.transcript;
      } else {
        console.error('Failed to get master key for transcript decryption:', tKey.error);
        delete transcriptData.encrypted_transcript_text;
        delete transcriptData.iv;
        transcriptData.transcript_text = null;
        transcriptOut = transcriptData;
      }
    }
  }

  return {
    patientEncounter: encounterData,
    recording: recording || null,
    note: noteOut,
    transcript: transcriptOut,
  };
}

/**
 * Core logic for POST /api/patient-encounters/complete (and internal callers, e.g. prompt LLM jobs).
 * Uses the caller's Supabase client (JWT) so RLS and RPC run as the authenticated user.
 *
 * @param {*} supabase - Supabase client (user JWT)
 * @param {{ id: string }} user
 * @param {{ patientEncounter: { name: string }, recording: { recording_file_path: string }, note_text: string, transcript?: { transcript_text: string } }} body
 * @param {{ sourceJobId?: string }} [options]
 * @returns {Promise<{ patientEncounter: object, recording: object, note: object, transcript: object|null }>}
 */
export async function patientEncounterCompleteBundle(supabase, user, body, options = {}) {
  if (!user?.id) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }

  const billingCtx = await resolveBillingContext(user.id);
  await assertUsageAllowed({
    organizationId: billingCtx.organizationId,
    metric: USAGE_METRICS.NOTES_SAVED,
    bypassUsageLimits: billingCtx.bypassUsageLimits,
    planKeyForLimits: billingCtx.planKeyForLimits,
  });

  const { patientEncounter, recording, note_text, transcript: transcriptBody } = body;

  if (!patientEncounter || !recording || note_text === undefined) {
    const err = new Error('Missing required fields: patientEncounter, recording, note_text');
    err.statusCode = 400;
    throw err;
  }

  const { aesKey, iv: encounterIV } = encryptionUtils.generateAESKeyAndIV();

  const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
  if (!keyResult.success) {
    const err = new Error(keyResult.error);
    err.statusCode = 500;
    throw err;
  }
  const masterKey = keyResult.masterKey;

  const encryptedName = encryptionUtils.encryptText(
    patientEncounter.name,
    aesKey,
    encounterIV
  );
  const encryptedAESKey = encryptionUtils.encryptAESKey(aesKey);

  const note = { text: note_text };
  const noteEncryptResult = encryptionUtils.encryptNoteText(note, masterKey);
  if (!noteEncryptResult.success) {
    const err = new Error(noteEncryptResult.error);
    err.statusCode = 500;
    throw err;
  }

  let pTranscriptEnc = null;
  let pTranscriptIv = null;
  if (transcriptBody != null) {
    const tEnc = encryptTranscriptPlaintextWithMasterKey(transcriptBody.transcript_text, masterKey);
    if (!tEnc.success) {
      const err = new Error(tEnc.error);
      err.statusCode = 500;
      throw err;
    }
    pTranscriptEnc = tEnc.encrypted_transcript_text;
    pTranscriptIv = tEnc.iv;
  }

  const recordingIV = encryptionUtils.generateRandomIVBase64();

  console.log('Calling create_patient_encounter_complete SQL function');
  let data;
  try {
    const { rows } = await querySupabasePostgres(
      `SELECT create_patient_encounter_complete(
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10
       ) AS result`,
      [
        user.id,
        encryptedName,
        encounterIV,
        encryptedAESKey,
        recording.recording_file_path,
        recordingIV,
        noteEncryptResult.value,
        noteEncryptResult.iv,
        pTranscriptEnc,
        pTranscriptIv,
      ]
    );
    data = rows[0]?.result;
  } catch (error) {
    console.error('SQL function error:', error);
    const err = new Error(pgErrorMessage(error));
    err.statusCode = 500;
    throw err;
  }

  if (!data) {
    const err = new Error('create_patient_encounter_complete returned no data');
    err.statusCode = 500;
    throw err;
  }

  if (data.patientEncounter.encrypted_name) {
    data.patientEncounter.name = encryptionUtils.decryptText(
      data.patientEncounter.encrypted_name,
      aesKey,
      data.patientEncounter.iv
    );
    delete data.patientEncounter.encrypted_name;
  }
  delete data.patientEncounter.encrypted_aes_key;
  delete data.patientEncounter.iv;

  if (data.note.encrypted_text) {
    const noteDecryptResult = encryptionUtils.decryptText(
      data.note.encrypted_text,
      masterKey,
      data.note.text_iv
    );
    data.note.text = noteDecryptResult;
    delete data.note.encrypted_text;
  }
  delete data.note.text_iv;

  delete data.recording.iv;

  if (data.transcript) {
    const tr = decryptTranscriptRowWithMasterKey(data.transcript, masterKey);
    if (!tr.success) {
      const err = new Error(tr.error);
      err.statusCode = 400;
      throw err;
    }
    data.transcript = tr.transcript;
  }

  const noteId = data.note?.id;
  const idempotencyKey = options.sourceJobId
    ? `notes_saved:job:${options.sourceJobId}`
    : noteId != null
      ? `notes_saved:note:${noteId}`
      : `notes_saved:user:${user.id}:${Date.now()}`;

  await recordUsageSuccess({
    organizationId: billingCtx.organizationId,
    userId: user.id,
    metric: USAGE_METRICS.NOTES_SAVED,
    idempotencyKey,
    metadata: {
      note_id: noteId ?? null,
      source_job_id: options.sourceJobId ?? null,
    },
    bypassUsageLimits: billingCtx.bypassUsageLimits,
  });

  return data;
}

/**
 * Create a complete patient encounter bundle
 * POST /api/patient-encounters/complete
 *
 * Creates a patient encounter with linked recording and note using atomic SQL function
 * Handles encryption, validation, and atomic transaction with rollback on failure
 *
 * Request body: {
 *   patientEncounter: { name, ... },
 *   recording: { recording_file_path, ... },
 *   note_text: string (simple text note),
 *   transcript?: { transcript_text } (optional; encrypted with user master key)
 * }
 */
export async function completePatientEncounter(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const data = await patientEncounterCompleteBundle(supabase, user, request.body);
    return reply.status(201).send(data);
  } catch (error) {
    console.error('Error in completePatientEncounter:', error);
    if (error instanceof UsageLimitExceededError) {
      return reply.status(402).send(error.toJSON());
    }
    const status = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return reply.status(status).send({ error: error.message });
  }
}

