/**
 * SOAP Notes Controller
 * Handles all SOAP note CRUD operations with encryption/decryption
 */
import { pgQueryOne, pgQueryRows, pgErrorMessage } from '../../utils/pgQueryHelpers.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import parseSoapNotes from '../../utils/parseSoapNotes.js';

const soapNoteTable = 'soapNotes';
const BATCH_SIZE = 10; // Decrypt SOAP notes in batches for performance

const SOAP_NOTE_SORT_COLUMNS = new Set(['created_at', 'updated_at', 'id']);

const SOAP_NOTE_SELECT = `
  s.*,
  pe.encrypted_aes_key AS patient_encounter_encrypted_aes_key
`;

const SOAP_NOTE_FROM = `
  FROM "${soapNoteTable}" s
  LEFT JOIN "patientEncounters" pe ON pe.id = s."patientEncounter_id"
`;

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

function soapNoteOrderClause(sortBy, order) {
  const column = SOAP_NOTE_SORT_COLUMNS.has(sortBy) ? sortBy : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `s.${column} ${direction}`;
}

function mapSoapNoteRow(row) {
  if (!row) return null;
  const { patient_encounter_encrypted_aes_key, ...soapNote } = row;
  if (patient_encounter_encrypted_aes_key != null) {
    soapNote.patientEncounter = { encrypted_aes_key: patient_encounter_encrypted_aes_key };
  }
  return soapNote;
}

/**
 * Helper: Decrypts soapNote_text for a SOAP note object
 * Expects soapNote to have patientEncounter.encrypted_aes_key joined
 * Returns { success, error, soapNote }
 */
async function decryptSoapNoteText(soapNote) {
  const encryptedAESKey = soapNote.patientEncounter?.encrypted_aes_key || null;
  const decryptFieldResult = await encryptionUtils.decryptField(
    soapNote,
    'soapNote_text',
    encryptedAESKey
  );

  if (!decryptFieldResult.success) {
    console.error('Failed to decrypt SOAP note:', soapNote.id, '. Error:', decryptFieldResult.error);
    return { success: false, error: decryptFieldResult.error };
  }

  // Parse the soapNote_text JSON
  try {
    soapNote.soapNote_text = parseSoapNotes(soapNote.soapNote_text);
  } catch (e) {
    console.error('Failed to parse soapNote_text for SOAP note:', soapNote.id, '. Error:', e);
    return { success: false, error: 'Failed to parse soapNote_text' };
  }

  // Clean up joined fields
  delete soapNote.patientEncounter;
  return { success: true, soapNote };
}

/**
 * Get all SOAP notes for the authenticated user (with pagination and batched decryption)
 * GET /api/soap-notes
 * Query params: limit (default 100), offset (default 0), sortBy (default 'created_at'), order (default 'desc')
 */
export async function getAllSoapNotes(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

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

    const orderClause = soapNoteOrderClause(sortBy, order);

    const rows = await pgQueryRows(
      `SELECT ${SOAP_NOTE_SELECT}
              ${SOAP_NOTE_FROM}
             WHERE s.user_id = $1
             ORDER BY ${orderClause}
             LIMIT $2 OFFSET $3`,
      [user.id, limitNum, offsetNum]
    );

    const data = rows.map(mapSoapNoteRow);

    // Decrypt soapNote_text in batches for performance
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      const decryptPromises = batch.map((soapNote) => decryptSoapNoteText(soapNote));
      const results = await Promise.all(decryptPromises);

      for (let j = 0; j < results.length; j++) {
        if (!results[j].success) {
          return reply.status(400).send({ error: results[j].error });
        }
        // Update original array with decrypted data
        batch[j] = results[j].soapNote;
      }
    }

    return reply.status(200).send(data);
  } catch (error) {
    console.error('Error fetching SOAP notes:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Get a single SOAP note by ID
 * GET /api/soap-notes/:id
 */
export async function getSoapNote(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid SOAP note ID format' });
    }

    const soapNote = mapSoapNoteRow(
      await pgQueryOne(
        `SELECT ${SOAP_NOTE_SELECT}
                ${SOAP_NOTE_FROM}
               WHERE s.id = $1 AND s.user_id = $2`,
        [id, user.id]
      )
    );

    if (!soapNote) {
      return reply.status(404).send({ error: 'SOAP note not found' });
    }

    // Decrypt soapNote_text
    const decryptResult = await decryptSoapNoteText(soapNote);
    if (!decryptResult.success) {
      return reply.status(400).send({ error: decryptResult.error });
    }

    return reply.status(200).send(decryptResult.soapNote);
  } catch (error) {
    console.error('Error fetching SOAP note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Create a new SOAP note
 * POST /api/soap-notes
 * Body: { patientEncounter_id, soapNote_text }
 */
export async function createSoapNote(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { patientEncounter_id, soapNote_text } = request.body;

    const encounter = await pgQueryOne(
      `SELECT encrypted_aes_key
         FROM "patientEncounters"
        WHERE id = $1 AND user_id = $2`,
      [patientEncounter_id, user.id]
    );

    if (!encounter) {
      return reply.status(404).send({ error: 'Patient encounter not found' });
    }

    // Encrypt soapNote_text using patientEncounter's AES key
    // Convert object to JSON string for encryption
    const encryptedAESKey = encounter.encrypted_aes_key;
    
    let encryptedText;
    let iv;
    try {
      const encryptResult = encryptionUtils.encryptField(
        { soapNote_text: JSON.stringify(soapNote_text) },
        'soapNote_text',
        encryptedAESKey
      );
      if (!encryptResult.success) {
        return reply.status(500).send({ error: 'Failed to encrypt SOAP note text' });
      }
      encryptedText = encryptResult.value;
      iv = encryptResult.iv;
    } catch (encryptError) {
      console.error('Encryption error:', encryptError);
      return reply.status(500).send({ error: 'Failed to encrypt SOAP note text' });
    }

    const newSoapNote = await pgQueryOne(
      `INSERT INTO "${soapNoteTable}" (
         user_id, "patientEncounter_id", "encrypted_soapNote_text", iv
       ) VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.id, patientEncounter_id, encryptedText, iv]
    );

    if (!newSoapNote) {
      return reply.status(500).send({ error: 'Failed to create SOAP note' });
    }

    // Return decrypted SOAP note in response
    newSoapNote.soapNote_text = soapNote_text;
    return reply.status(201).send(newSoapNote);
  } catch (error) {
    console.error('Error creating SOAP note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Update a SOAP note
 * PATCH /api/soap-notes/:id
 * Body: { soapNote_text }
 */
export async function updateSoapNote(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid SOAP note ID format' });
    }

    const { soapNote_text } = request.body;

    const soapNote = mapSoapNoteRow(
      await pgQueryOne(
        `SELECT ${SOAP_NOTE_SELECT}
                ${SOAP_NOTE_FROM}
               WHERE s.id = $1 AND s.user_id = $2`,
        [id, user.id]
      )
    );

    if (!soapNote) {
      return reply.status(404).send({ error: 'SOAP note not found' });
    }

    // Encrypt the updated soapNote_text
    // Convert object to JSON string for encryption
    const encryptedAESKey = soapNote.patientEncounter?.encrypted_aes_key;
    let encryptedText;
    let iv;
    try {
      const encryptResult = encryptionUtils.encryptField(
        { soapNote_text: JSON.stringify(soapNote_text) },
        'soapNote_text',
        encryptedAESKey
      );
      if (!encryptResult.success) {
        return reply.status(500).send({ error: 'Failed to encrypt SOAP note text' });
      }
      encryptedText = encryptResult.value;
      iv = encryptResult.iv;
    } catch (encryptError) {
      console.error('Encryption error:', encryptError);
      return reply.status(500).send({ error: 'Failed to encrypt SOAP note text' });
    }

    const updatedSoapNote = await pgQueryOne(
      `UPDATE "${soapNoteTable}"
          SET "encrypted_soapNote_text" = $1,
              iv = $2,
              updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING *`,
      [encryptedText, iv, id, user.id]
    );

    if (!updatedSoapNote) {
      return reply.status(404).send({ error: 'SOAP note not found' });
    }

    // Return decrypted SOAP note in response
    updatedSoapNote.soapNote_text = soapNote_text;
    return reply.status(200).send(updatedSoapNote);
  } catch (error) {
    console.error('Error updating SOAP note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}

/**
 * Delete a SOAP note
 * DELETE /api/soap-notes/:id
 */
export async function deleteSoapNote(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    // Validate bigint ID format
    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid SOAP note ID format' });
    }

    const data = await pgQueryOne(
      `DELETE FROM "${soapNoteTable}"
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'SOAP note not found' });
    }

    return reply.status(200).send({ success: true, data });
  } catch (error) {
    console.error('Error deleting SOAP note:', error);
    return reply.status(500).send({ error: pgErrorMessage(error) });
  }
}
