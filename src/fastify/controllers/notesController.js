/**
 * Notes Controller
 * Handles all notes CRUD operations with encryption/decryption using user master key
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';

const notesTable = 'notes';
const BATCH_SIZE = 10; // Decrypt notes in batches for performance

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
 * Helper: Decrypts text for a note object
 * Uses user's master key for decryption
 * Returns { success, error, note }
 */
async function decryptNoteText(note, masterKey) {
  const decryptResult = encryptionUtils.decryptNoteText(note, masterKey);

  if (!decryptResult.success) {
    console.error('Failed to decrypt note:', note.id, '. Error:', decryptResult.error);
    return { success: false, error: decryptResult.error };
  }

  // Set decrypted text on note
  note.text = decryptResult.text;
  return { success: true, note };
}

/**
 * Helper: Strips encryption-related fields from note(s) before sending to client
 * Removes: encrypted_text, text_iv
 * @param {Object|Array} notes - Single note or array of notes
 * @returns {Object|Array} Note(s) without encryption fields
 */
function stripEncryptionFields(notes) {
  if (Array.isArray(notes)) {
    return notes.map((note) => {
      const { encrypted_text, text_iv, ...stripped } = note;
      return stripped;
    });
  }

  const { encrypted_text, text_iv, ...stripped } = notes;
  return stripped;
}

/**
 * Get all notes for the authenticated user (with pagination and batched decryption)
 * GET /api/notes
 * Query params: limit (default 100), offset (default 0), sortBy (default 'created_at'), order (default 'desc')
 */
export async function getAllNotes(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Get user's master key
    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    // Parse and validate query parameters
    const { limit = 100, offset = 0, sortBy = 'created_at', order = 'desc' } = request.query;

    // Validate limit is numeric and positive
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum <= 0) {
      return reply.status(400).send({ error: 'Invalid limit parameter: must be a positive number' });
    }

    // Validate offset is numeric and non-negative
    const offsetNum = parseInt(offset);
    if (isNaN(offsetNum) || offsetNum < 0) {
      return reply.status(400).send({ error: 'Invalid offset parameter: must be a non-negative number' });
    }

    // Fetch notes with user filter
    const { data, error } = await supabase
      .from(notesTable)
      .select('*')
      .eq('user_id', user.id)
      .order(sortBy, { ascending: order === 'asc' })
      .range(offsetNum, offsetNum + limitNum - 1);

    if (error) {
      console.error('Error fetching notes:', error);
      return reply.status(500).send({ error: error.message });
    }

    // Decrypt text in batches for performance
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      const decryptPromises = batch.map((note) => decryptNoteText(note, masterKey));
      const results = await Promise.all(decryptPromises);

      for (let j = 0; j < results.length; j++) {
        if (!results[j].success) {
          return reply.status(400).send({ error: results[j].error });
        }
        // Update original array with decrypted data
        batch[j] = results[j].note;
      }
    }

    return reply.status(200).send(stripEncryptionFields(data));
  } catch (error) {
    console.error('Error fetching notes:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Get a single note by ID
 * GET /api/notes/:id
 */
export async function getNote(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid note ID format' });
    }

    // Get user's master key
    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    // Fetch single note
    const { data: note, error } = await supabase
      .from(notesTable)
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (error || !note) {
      return reply.status(404).send({ error: 'Note not found' });
    }

    // Decrypt text
    const decryptResult = await decryptNoteText(note, masterKey);
    if (!decryptResult.success) {
      return reply.status(400).send({ error: decryptResult.error });
    }

    return reply.status(200).send(stripEncryptionFields(decryptResult.note));
  } catch (error) {
    console.error('Error fetching note:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Create a new note
 * POST /api/notes
 * Body: { text (optional), patientEncounter_id (optional) }
 */
export async function createNote(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { text = '', patientEncounter_id } = request.body;

    // If patientEncounter_id provided, verify user owns it
    if (patientEncounter_id) {
      const { data: encounter, error: encounterError } = await supabase
        .from('patientEncounters')
        .select('id')
        .eq('id', patientEncounter_id)
        .eq('user_id', user.id)
        .single();

      if (encounterError || !encounter) {
        return reply.status(404).send({ error: 'Patient encounter not found' });
      }
    }

    // Get user's master key
    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    // Encrypt text using user's master key
    let encryptedText = null;
    let textIv = null;

    if (text) {
      const note = { text };
      const encryptResult = encryptionUtils.encryptNoteText(note, masterKey);
      if (!encryptResult.success) {
        return reply.status(500).send({ error: encryptResult.error });
      }
      encryptedText = encryptResult.value;
      textIv = encryptResult.iv;
    }

    // Insert note into database
    const { data: newNote, error: insertError } = await supabase
      .from(notesTable)
      .insert({
        user_id: user.id,
        patientEncounter_id: patientEncounter_id || null,
        encrypted_text: encryptedText,
        text_iv: textIv,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Insert error:', insertError);
      return reply.status(500).send({ error: insertError.message });
    }

    // Return note with decrypted text in response
    newNote.text = text;
    return reply.status(201).send(stripEncryptionFields(newNote));
  } catch (error) {
    console.error('Error creating note:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Update a note
 * PATCH /api/notes/:id
 * Body: { text (optional) }
 */
export async function updateNote(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid note ID format' });
    }

    const { text } = request.body;

    // Get user's master key
    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    // Fetch note to verify ownership
    const { data: note, error: fetchError } = await supabase
      .from(notesTable)
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (fetchError || !note) {
      return reply.status(404).send({ error: 'Note not found' });
    }

    // Build update object
    const updateData = {};
    if (text !== undefined) {
      const noteForEncrypt = { text };
      const encryptResult = encryptionUtils.encryptNoteText(noteForEncrypt, masterKey);
      if (!encryptResult.success) {
        return reply.status(500).send({ error: encryptResult.error });
      }
      updateData.encrypted_text = encryptResult.value;
      updateData.text_iv = encryptResult.iv;
    }

    // Update note in database
    const { data: updatedNote, error: updateError } = await supabase
      .from(notesTable)
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('Update error:', updateError);
      return reply.status(500).send({ error: updateError.message });
    }

    // Return note with decrypted text in response
    if (text !== undefined) {
      updatedNote.text = text;
    } else {
      const decryptResult = await decryptNoteText(updatedNote, masterKey);
      if (!decryptResult.success) {
        return reply.status(400).send({ error: decryptResult.error });
      }
      updatedNote.text = decryptResult.note.text;
    }

    return reply.status(200).send(stripEncryptionFields(updatedNote));
  } catch (error) {
    console.error('Error updating note:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Delete a note
 * DELETE /api/notes/:id
 */
export async function deleteNote(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid note ID format' });
    }

    // Delete note and return the deleted data (RLS policy ensures user can only delete their own)
    const { data, error: deleteError } = await supabase
      .from(notesTable)
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (deleteError) {
      if (deleteError.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Note not found' });
      }
      console.error('Delete error:', deleteError);
      return reply.status(500).send({ error: deleteError.message });
    }

    return reply.status(200).send({ success: true, data: stripEncryptionFields(data) });
  } catch (error) {
    console.error('Error deleting note:', error);
    return reply.status(500).send({ error: error.message });
  }
}
