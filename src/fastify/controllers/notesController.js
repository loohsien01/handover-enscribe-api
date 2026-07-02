/**
 * Notes Controller
 * Handles all notes CRUD operations with encryption/decryption using user master key
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import { pgQueryOne, pgQueryRows, pgErrorMessage } from '../../utils/pgQueryHelpers.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';

const notesTable = 'notes';
const BATCH_SIZE = 10; // Decrypt notes in batches for performance

const NOTES_SORT_COLUMNS = new Set(['created_at', 'updated_at', 'id']);

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

function notesOrderClause(sortBy, order) {
  const column = NOTES_SORT_COLUMNS.has(sortBy) ? sortBy : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${direction}`;
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
 * List note ids, encounter links, and updated_at (no decryption)
 * GET /api/notes
 * Query: validated in route (notesListQuerySchema): limit (default 100), offset (default 0), sortBy, order
 */
export async function getAllNotes(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { limit, offset, sortBy, order } = request.query;
    const orderClause = notesOrderClause(sortBy, order);

    const data = await pgQueryRows(
      `SELECT id, "patientEncounter_id", updated_at
         FROM ${notesTable}
        WHERE user_id = $1
        ORDER BY ${orderClause}
        LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    );

    return reply.status(200).send(data);
  } catch (error) {
    console.error('Error fetching notes:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Get all notes for the authenticated user (with pagination and batched decryption)
 * GET /api/notes/complete
 * Query: validated in route (notesCompleteListQuerySchema): limit (default 50, like patient-encounters), offset, sortBy, order
 */
export async function getAllNotesComplete(request, reply) {
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

    const { limit, offset, sortBy, order } = request.query;
    const orderClause = notesOrderClause(sortBy, order);

    const data = await pgQueryRows(
      `SELECT *
         FROM ${notesTable}
        WHERE user_id = $1
        ORDER BY ${orderClause}
        LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    );

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
    return reply.status(500).send({ error: pgErrorMessage(error) });
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

    const note = await pgQueryOne(
      `SELECT *
         FROM ${notesTable}
        WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (!note) {
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
    return reply.status(500).send({ error: pgErrorMessage(error) });
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
      const encounter = await pgQueryOne(
        `SELECT id
           FROM "patientEncounters"
          WHERE id = $1 AND user_id = $2`,
        [patientEncounter_id, user.id]
      );

      if (!encounter) {
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

    const newNote = await pgQueryOne(
      `INSERT INTO ${notesTable} (
         user_id, "patientEncounter_id", encrypted_text, text_iv
       ) VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.id, patientEncounter_id || null, encryptedText, textIv]
    );

    if (!newNote) {
      return reply.status(500).send({ error: 'Failed to create note' });
    }

    // Return note with decrypted text in response
    newNote.text = text;
    return reply.status(201).send(stripEncryptionFields(newNote));
  } catch (error) {
    console.error('Error creating note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
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

    const note = await pgQueryOne(
      `SELECT *
         FROM ${notesTable}
        WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (!note) {
      return reply.status(404).send({ error: 'Note not found' });
    }

    if (text === undefined) {
      const decryptResult = await decryptNoteText(note, masterKey);
      if (!decryptResult.success) {
        return reply.status(400).send({ error: decryptResult.error });
      }
      return reply.status(200).send(stripEncryptionFields(decryptResult.note));
    }

    const noteForEncrypt = { text };
    const encryptResult = encryptionUtils.encryptNoteText(noteForEncrypt, masterKey);
    if (!encryptResult.success) {
      return reply.status(500).send({ error: encryptResult.error });
    }

    const updatedNote = await pgQueryOne(
      `UPDATE ${notesTable}
          SET encrypted_text = $1,
              text_iv = $2,
              updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING *`,
      [encryptResult.value, encryptResult.iv, id, user.id]
    );

    if (!updatedNote) {
      return reply.status(404).send({ error: 'Note not found' });
    }

    updatedNote.text = text;
    return reply.status(200).send(stripEncryptionFields(updatedNote));
  } catch (error) {
    console.error('Error updating note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Delete a note
 * DELETE /api/notes/:id
 */
export async function deleteNote(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid note ID format' });
    }

    const data = await pgQueryOne(
      `DELETE FROM ${notesTable}
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Note not found' });
    }

    return reply.status(200).send({ success: true, data: stripEncryptionFields(data) });
  } catch (error) {
    console.error('Error deleting note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}
