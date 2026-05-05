/**
 * Patient Encounters Controller
 * Handles all patient encounter CRUD operations, batch operations, and completion
 * Validation is handled in routes using Zod schemas
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { getPatientEncounterWithDecryptedKey } from '../../utils/patientEncounterUtils.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';

const patientEncounterTable = 'patientEncounters';
const recordingTable = 'recordings';
const notesTable = 'notes';

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
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { limit, offset, decryptName } = request.query;

    const { data, error } = await supabase
      .from(patientEncounterTable)
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

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
    const supabase = getSupabaseClient(request.headers.authorization);
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

    const { data: encounter, error } = await supabase
      .from(patientEncounterTable)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Encounter not found' });
      }
      return reply.status(500).send({ error: error.message });
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
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Request body is already validated by route
    const encounter = request.body;

    // Set user_id to authenticated user
    encounter.user_id = user.id;

    // Generate AES key and IV for patient encounter
    const { aesKey, iv } = encryptionUtils.generateAESKeyAndIV();
    encounter.iv = iv;
    encounter.encrypted_aes_key = encryptionUtils.encryptAESKey(aesKey);

    // Encrypt patient name
    if (encounter.name) {
      encounter.encrypted_name = encryptionUtils.encryptText(encounter.name, aesKey, iv);
      delete encounter.name; // Remove plain field before insert
    }

    const { data, error } = await supabase
      .from(patientEncounterTable)
      .insert([encounter])
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: error.message });
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
    const supabase = getSupabaseClient(request.headers.authorization);
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
    const { data: encounter, error: fetchError } = await supabase
      .from(patientEncounterTable)
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Encounter not found' });
      }
      return reply.status(500).send({ error: fetchError.message });
    }

    // Step 2: Prepare update object
    const dbUpdates = {};

    // If name is being updated, encrypt it using the existing encryption key and IV
    if (updates.name !== undefined) {
      // Decrypt the existing AES key from the database
      const aes_key = encryptionUtils.decryptAESKey(encounter.encrypted_aes_key);
      
      // Encrypt the new name using the existing key and IV
      const encrypted_name = encryptionUtils.encryptText(updates.name, aes_key, encounter.iv);
      
      dbUpdates.encrypted_name = encrypted_name;
      // Keep the same IV and encrypted_aes_key (no need to update them)
    }

    // Copy other fields as-is (they're not encrypted)
    for (const key of Object.keys(updates)) {
      if (key !== 'name') {
        dbUpdates[key] = updates[key];
      }
    }

    // Set updated_at timestamp
    dbUpdates.updated_at = new Date().toISOString();

    // Step 3: Update in database
    const { data: updatedData, error: updateError } = await supabase
      .from(patientEncounterTable)
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      if (updateError.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Encounter not found' });
      }
      return reply.status(500).send({ error: updateError.message });
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
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid ID format - must be a numeric ID' });
    }

    const { data, error } = await supabase
      .from(patientEncounterTable)
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Encounter not found' });
      }
      return reply.status(500).send({ error: error.message });
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
    const { data: encounterData, error: encounterError } = await supabase
      .from(patientEncounterTable)
      .select('*')
      .eq('id', encounterId)
      .eq('user_id', user.id)
      .single();

    if (encounterError) {
      if (encounterError.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Encounter not found' });
      }
      return reply.status(500).send({ error: encounterError.message });
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
    const { data: recordingData, error: recordingError } = await supabase
      .from('recordings')
      .select('*')
      .eq('patientEncounter_id', encounterId)
      .single();

    let recording = null;
    if (recordingError && recordingError.code !== 'PGRST116') {
      console.error('Recording query error:', recordingError);
      return reply.status(500).send({ error: recordingError.message });
    } else if (recordingData) {
      recording = recordingData;
      delete recording.iv;
    } else if (recordingError?.code === 'PGRST116') {
      console.warn('No recording found for encounterId:', encounterId, 'RLS may have filtered the result or no recording linked');
    }

    // Step 1.5: Generate/refresh signed URL if needed
    if (recording && recording.recording_file_path) {
      const needNewSignedUrl = !recording.recording_file_signed_url || 
                               new Date(recording.recording_file_signed_url_expiry) < new Date();
      
      if (needNewSignedUrl) {
        console.log('Step 1.5: Generating signed URL for recording file');
        
        // Normalize path: strip optional bucket prefix and any leading slash
        let normalizedPath = recording.recording_file_path;
        if (normalizedPath.startsWith('audio-files/')) {
          normalizedPath = normalizedPath.replace(/^audio-files\//, '');
        }
        if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.slice(1);
        
        console.log('Creating signed URL for recording file:', normalizedPath);
        const expirySeconds = 60 * 60; // 1 hour
        
        const { data: signedUrlData, error: signedError } = await supabase.storage
          .from('audio-files')
          .createSignedUrl(normalizedPath, expirySeconds);
        
        if (signedError) {
          // Missing object, wrong path, or storage outage — still return the bundle without a signed URL.
          console.warn('Signed URL error (continuing without signed URL):', signedError?.message || signedError);
          recording.recording_file_signed_url = null;
          recording.recording_file_signed_url_expiry = null;
        } else {
          const now = new Date();
          const expiresAt = new Date(now.getTime() + expirySeconds * 1000).toISOString();
          
          recording.recording_file_signed_url = signedUrlData.signedUrl;
          recording.recording_file_signed_url_expiry = expiresAt;
          
          // Best-effort cache in DB; response still succeeds if this update fails.
          const { error: updateError } = await supabase
            .from('recordings')
            .update({
              recording_file_signed_url: recording.recording_file_signed_url,
              recording_file_signed_url_expiry: recording.recording_file_signed_url_expiry
            })
            .eq('id', recording.id)
            .select()
            .single();
          
          if (updateError) {
            console.warn('Error updating recording signed URL (continuing):', updateError?.message || updateError);
          }
        }
      }
    }

    // Step 2: Fetch notes for encounter
    console.log('Step 2: Fetching notes for encounterId:', encounterId);
    const { data: notesData, error: notesError } = await supabase
      .from('notes')
      .select('*')
      .eq('patientEncounter_id', encounterId);

    let encounterNotes = [];
    if (notesError && notesError.code !== 'PGRST116') {
      return reply.status(500).send({ error: notesError.message });
    } else if (notesData && Array.isArray(notesData)) {
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
      notes: encounterNotes,
    });
  } catch (error) {
    console.error('Error fetching complete patient encounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Build { patientEncounter, recording, note } for a note id — same shape as POST /api/patient-encounters/complete.
 * Used by GET /api/jobs/prompt-llm/:jobId/encounter-bundle. Caller must use user-scoped Supabase (JWT).
 *
 * @param {*} supabase - Supabase client (user JWT)
 * @param {{ id: string }} user
 * @param {string|number|bigint} noteId
 * @returns {Promise<{ patientEncounter: object, recording: object|null, note: object }>}
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

  const { data: noteRow, error: noteError } = await supabase
    .from(notesTable)
    .select('*')
    .eq('id', idStr)
    .eq('user_id', user.id)
    .single();

  if (noteError || !noteRow) {
    const err = new Error(noteError?.code === 'PGRST116' ? 'Note not found' : noteError?.message || 'Note not found');
    err.statusCode = 404;
    throw err;
  }

  const encounterId = noteRow.patientEncounter_id;
  if (encounterId == null) {
    const err = new Error('Note has no patient encounter');
    err.statusCode = 404;
    throw err;
  }

  const { data: encounterData, error: encounterError } = await supabase
    .from(patientEncounterTable)
    .select('*')
    .eq('id', encounterId)
    .eq('user_id', user.id)
    .single();

  if (encounterError || !encounterData) {
    const err = new Error(
      encounterError?.code === 'PGRST116' ? 'Encounter not found' : encounterError?.message || 'Encounter not found'
    );
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

  const { data: recordingData, error: recordingError } = await supabase
    .from(recordingTable)
    .select('*')
    .eq('patientEncounter_id', encounterId)
    .single();

  let recording = null;
  if (recordingError && recordingError.code !== 'PGRST116') {
    const err = new Error(recordingError.message);
    err.statusCode = 500;
    throw err;
  } else if (recordingData) {
    recording = recordingData;
    delete recording.iv;
  }

  if (recording && recording.recording_file_path) {
    const needNewSignedUrl =
      !recording.recording_file_signed_url || new Date(recording.recording_file_signed_url_expiry) < new Date();

    if (needNewSignedUrl) {
      let normalizedPath = recording.recording_file_path;
      if (normalizedPath.startsWith('audio-files/')) {
        normalizedPath = normalizedPath.replace(/^audio-files\//, '');
      }
      if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.slice(1);

      const expirySeconds = 60 * 60;
      const { data: signedUrlData, error: signedError } = await supabase.storage
        .from('audio-files')
        .createSignedUrl(normalizedPath, expirySeconds);

      if (signedError) {
        const err = new Error('Failed to create signed URL: ' + signedError.message);
        err.statusCode = 500;
        throw err;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + expirySeconds * 1000).toISOString();
      recording.recording_file_signed_url = signedUrlData.signedUrl;
      recording.recording_file_signed_url_expiry = expiresAt;

      const { error: updateError } = await supabase
        .from(recordingTable)
        .update({
          recording_file_signed_url: recording.recording_file_signed_url,
          recording_file_signed_url_expiry: recording.recording_file_signed_url_expiry,
        })
        .eq('id', recording.id);

      if (updateError) {
        const err = new Error(updateError.message);
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

  return {
    patientEncounter: encounterData,
    recording: recording || null,
    note: noteOut,
  };
}

/**
 * Core logic for POST /api/patient-encounters/complete (and internal callers, e.g. prompt LLM jobs).
 * Uses the caller's Supabase client (JWT) so RLS and RPC run as the authenticated user.
 *
 * @param {*} supabase - Supabase client (user JWT)
 * @param {{ id: string }} user
 * @param {{ patientEncounter: { name: string }, recording: { recording_file_path: string }, note_text: string }} body
 * @returns {Promise<{ patientEncounter: object, recording: object, note: object }>}
 */
export async function patientEncounterCompleteBundle(supabase, user, body) {
  if (!user?.id) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }

  const { patientEncounter, recording, note_text } = body;

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

  const recordingIV = encryptionUtils.generateRandomIVBase64();

  console.log('Calling create_patient_encounter_complete SQL function');
  const { data, error } = await supabase.rpc('create_patient_encounter_complete', {
    p_user_id: user.id,
    p_encrypted_name: encryptedName,
    p_encounter_iv: encounterIV,
    p_encrypted_aes_key: encryptedAESKey,
    p_recording_file_path: recording.recording_file_path,
    p_recording_iv: recordingIV,
    p_note_encrypted_text: noteEncryptResult.value,
    p_note_text_iv: noteEncryptResult.iv,
  });

  if (error) {
    console.error('SQL function error:', error);
    const err = new Error(error.message);
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
 *   note_text: string (simple text note)
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
    const status = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return reply.status(status).send({ error: error.message });
  }
}

