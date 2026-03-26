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

/**
 * Get all patient encounters for the authenticated user
 * GET /api/patient-encounters
 */
export async function getAllPatientEncounters(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Get query parameters for pagination/filtering
    const limit = parseInt(request.query.limit) || 50;
    const offset = parseInt(request.query.offset) || 0;

    const { data, error } = await supabase
      .from(patientEncounterTable)
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    // Decrypt sensitive fields and remove encryption keys
    for (let encounter of data) {
      if (!encounter.encrypted_aes_key || !encounter.iv) {
        console.error(`Missing encryption keys for encounter ${encounter.id}`);
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
      
      // Remove encryption fields from response (not relevant to frontend)
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
 */
export async function getPatientEncounter(request, reply) {
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

    // Decrypt sensitive fields and remove encryption keys
    if (encounter.encrypted_aes_key && encounter.iv && encounter.encrypted_name) {
      const aes_key = encryptionUtils.decryptAESKey(encounter.encrypted_aes_key);
      encounter.name = encryptionUtils.decryptText(
        encounter.encrypted_name,
        aes_key,
        encounter.iv
      );
      delete encounter.encrypted_name;
    }
    
    // Remove encryption fields from response (not relevant to frontend)
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
          console.error('Signed URL error:', signedError);
          return reply.status(500).send({ error: 'Failed to create signed URL: ' + signedError.message });
        }
        
        const now = new Date();
        const expiresAt = new Date(now.getTime() + expirySeconds * 1000).toISOString();
        
        recording.recording_file_signed_url = signedUrlData.signedUrl;
        recording.recording_file_signed_url_expiry = expiresAt;
        
        // Update recording row in database
        const { data: updateData, error: updateError } = await supabase
          .from('recordings')
          .update({
            recording_file_signed_url: recording.recording_file_signed_url,
            recording_file_signed_url_expiry: recording.recording_file_signed_url_expiry
          })
          .eq('id', recording.id)
          .select()
          .single();
        
        if (updateError) {
          console.error('Error updating recording\'s file signed URL:', updateError.message);
          return reply.status(500).send({ error: updateError.message });
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

    const { patientEncounter, recording, note_text } = request.body;

    // Step 1: Validate all required objects are present
    if (!patientEncounter || !recording || note_text === undefined) {
      return reply.status(400).send({
        error: 'Missing required fields: patientEncounter, recording, note_text',
      });
    }

    // Step 2: Generate encryption keys for patient encounter
    const { aesKey, iv: encounterIV } = encryptionUtils.generateAESKeyAndIV();

    // Step 3: Get user master key for note encryption
    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    // Step 4: Encrypt patient encounter name
    const encryptedName = encryptionUtils.encryptText(
      patientEncounter.name,
      aesKey,
      encounterIV
    );
    const encryptedAESKey = encryptionUtils.encryptAESKey(aesKey);

    // Step 5: Encrypt note text using user master key
    const note = { text: note_text };
    const noteEncryptResult = encryptionUtils.encryptNoteText(note, masterKey);
    if (!noteEncryptResult.success) {
      return reply.status(500).send({ error: noteEncryptResult.error });
    }

    // Step 6: Generate recording IV
    const recordingIV = encryptionUtils.generateRandomIVBase64();

    // Step 7: Call atomic SQL function
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
      return reply.status(500).send({ error: error.message });
    }

    // Step 8: Decrypt response data for client
    // Decrypt patient encounter name
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

    // Decrypt note text
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

    // Remove encryption field from recording
    delete data.recording.iv;

    // Step 9: Return success response
    return reply.status(201).send(data);

  } catch (error) {
    console.error('Error in completePatientEncounter:', error);
    return reply.status(500).send({ error: error.message });
  }
}

