import { getSupabaseClient } from '../../utils/supabase.js';
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
  isPgUniqueViolation,
  pgCoerceBigIntFields,
  pgCoerceBigIntFieldsRows,
} from '../../utils/pgQueryHelpers.js';
import {
  getSystemMasterKey,
  getOrCreateUserMasterKey,
} from './userSecurityConfigController.js';
import {
  encryptNoteTemplateSectionDetails,
  decryptNoteTemplateSectionDetails,
} from '../../utils/encryptionUtils.js';

const SECTION_BIGINT_FIELDS = ['id'];

function normalizeSectionRow(row) {
  return pgCoerceBigIntFields(row, SECTION_BIGINT_FIELDS);
}

function normalizeSectionRows(rows) {
  return pgCoerceBigIntFieldsRows(rows, SECTION_BIGINT_FIELDS);
}

const noteTemplateSectionsTable = '"noteTemplateSections"';

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
 * Gets all note template sections for authenticated user
 * GET /api/note-template-sections
 */
export async function getAllNoteTemplateSections(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;

    const data = await pgQueryRows(
      `SELECT *
         FROM ${noteTemplateSectionsTable}
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY created_at DESC`,
      [userId]
    );

    if (data.length === 0) {
      return reply.status(200).send([]);
    }

    const hasSystemTemplates = data.some((s) => s.user_id === null || s.is_system);
    const hasUserTemplates = data.some((s) => s.user_id !== null);

    let systemKeyResult = null;
    let userKeyResult = null;

    if (hasSystemTemplates) {
      systemKeyResult = await getSystemMasterKey();
      if (!systemKeyResult.success) {
        console.warn('[getAllNoteTemplateSections] Failed to get system key:', systemKeyResult.error);
      }
    }

    if (hasUserTemplates) {
      userKeyResult = await getOrCreateUserMasterKey(supabase, userId);
      if (!userKeyResult.success) {
        return reply.status(500).send({ error: userKeyResult.error });
      }
    }

    const decryptedSections = await Promise.all(
      data.map(async (section) => {
        if (!section.encrypted_details) {
          return section;
        }

        const keyResult =
          section.user_id === null || section.is_system ? systemKeyResult : userKeyResult;

        if (!keyResult || !keyResult.success) {
          console.error(
            `[getAllNoteTemplateSections] No key available for section ${section.id}`,
            section.user_id === null || section.is_system ? 'system' : 'user'
          );
          return section;
        }

        const decryptResult = decryptNoteTemplateSectionDetails(section, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error(`[getAllNoteTemplateSections] Failed to decrypt section ${section.id}:`, decryptResult.error);
          return section;
        }

        return decryptResult.section;
      })
    );

    return reply.status(200).send(decryptedSections.map(normalizeSectionRow));
  } catch (err) {
    console.error('Error fetching note template sections:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Gets a single note template section by ID
 * GET /api/note-template-sections/:id
 */
export async function getNoteTemplateSection(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid section ID format' });
    }

    const data = await pgQueryOne(
      `SELECT *
         FROM ${noteTemplateSectionsTable}
        WHERE id = $1
          AND (user_id = $2 OR user_id IS NULL)`,
      [id, userId]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Section not found' });
    }

    if (data.encrypted_details) {
      let keyResult;
      if (data.user_id === null || data.is_system) {
        keyResult = await getSystemMasterKey();
      } else {
        keyResult = await getOrCreateUserMasterKey(supabase, userId);
      }

      if (!keyResult.success) {
        return reply.status(500).send({ error: keyResult.error });
      }

      const decryptResult = decryptNoteTemplateSectionDetails(data, keyResult.masterKey);
      if (!decryptResult.success) {
        return reply.status(400).send({ error: decryptResult.error });
      }
    }

    return reply.status(200).send(normalizeSectionRow(data));
  } catch (err) {
    console.error('Error fetching note template section:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Creates a new note template section for the authenticated user
 * POST /api/note-template-sections
 */
export async function createNoteTemplateSection(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { name, layout, details } = request.body;

    if (!name || !layout) {
      return reply.status(400).send({ error: 'Name and layout are required' });
    }

    const section = {
      name,
      layout,
      details,
      user_id: userId,
    };

    console.log('[createNoteTemplateSection] Creating section:', { name, layout, user_id: userId });

    const keyResult = await getOrCreateUserMasterKey(supabase, userId);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }

    const encryptionResult = encryptNoteTemplateSectionDetails(section, keyResult.masterKey);
    if (!encryptionResult.success) {
      return reply.status(400).send({ error: encryptionResult.error });
    }

    const enc = encryptionResult.section;

    try {
      const insertData = await pgQueryOne(
        `INSERT INTO ${noteTemplateSectionsTable} (
           name, layout, encrypted_details, details_iv, user_id
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [enc.name, enc.layout, enc.encrypted_details ?? null, enc.details_iv ?? null, userId]
      );

      if (insertData.encrypted_details) {
        const decryptResult = decryptNoteTemplateSectionDetails(insertData, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error('Failed to decrypt newly created section:', decryptResult.error);
        }
      }

      return reply.status(201).send(normalizeSectionRow(insertData));
    } catch (insertError) {
      console.error('Database error creating section:', insertError);

      if (isPgUniqueViolation(insertError)) {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A section with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to create section' });
    }
  } catch (err) {
    console.error('Error creating note template section:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Updates an existing note template section
 * PATCH /api/note-template-sections/:id
 */
export async function updateNoteTemplateSection(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;
    const updateData = request.body;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid section ID format' });
    }

    const existingSection = await pgQueryOne(
      `SELECT *
         FROM ${noteTemplateSectionsTable}
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (!existingSection) {
      return reply.status(404).send({ error: 'Section not found' });
    }

    const section = {
      ...existingSection,
      ...updateData,
      user_id: userId,
      id: BigInt(id),
    };

    console.log('[updateNoteTemplateSection] Updating section:', { id, name: updateData.name });

    const keyResult = await getOrCreateUserMasterKey(supabase, userId);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }

    try {
      let updatedData;

      if (updateData.details !== undefined) {
        const encryptionResult = encryptNoteTemplateSectionDetails(section, keyResult.masterKey);
        if (!encryptionResult.success) {
          return reply.status(400).send({ error: encryptionResult.error });
        }

        const enc = encryptionResult.section;

        updatedData = await pgQueryOne(
          `UPDATE ${noteTemplateSectionsTable}
              SET name = COALESCE($1, name),
                  layout = COALESCE($2, layout),
                  encrypted_details = $3,
                  details_iv = $4,
                  updated_at = NOW()
            WHERE id = $5 AND user_id = $6
            RETURNING *`,
          [
            updateData.name ?? null,
            updateData.layout ?? null,
            enc.encrypted_details ?? null,
            enc.details_iv ?? null,
            id,
            userId,
          ]
        );
      } else {
        updatedData = await pgQueryOne(
          `UPDATE ${noteTemplateSectionsTable}
              SET name = COALESCE($1, name),
                  layout = COALESCE($2, layout),
                  updated_at = NOW()
            WHERE id = $3 AND user_id = $4
            RETURNING *`,
          [updateData.name ?? null, updateData.layout ?? null, id, userId]
        );
      }

      if (!updatedData) {
        return reply.status(404).send({ error: 'Section not found' });
      }

      if (updatedData.encrypted_details) {
        const decryptResult = decryptNoteTemplateSectionDetails(updatedData, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error('Failed to decrypt updated section:', decryptResult.error);
        }
      }

      return reply.status(200).send(normalizeSectionRow(updatedData));
    } catch (updateError) {
      console.error('Database error updating section:', updateError);

      if (isPgUniqueViolation(updateError)) {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A section with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to update section' });
    }
  } catch (err) {
    console.error('Error updating note template section:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Deletes a note template section
 * DELETE /api/note-template-sections/:id
 */
export async function deleteNoteTemplateSection(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid section ID format' });
    }

    try {
      const deleted = await pgQueryOne(
        `DELETE FROM ${noteTemplateSectionsTable}
          WHERE id = $1 AND user_id = $2
          RETURNING id`,
        [id, userId]
      );

      if (!deleted) {
        return reply.status(404).send({ error: 'Section not found' });
      }

      return reply.status(204).send();
    } catch (deleteError) {
      console.error('Database error deleting section:', deleteError);

      if (deleteError && typeof deleteError === 'object' && 'code' in deleteError && deleteError.code === '23503') {
        return reply.status(409).send({
          code: 'RESOURCE_IN_USE',
          message: 'This section is still being used in one or more templates. Remove it from those templates first.',
        });
      }

      return reply.status(400).send({ error: 'Failed to delete section' });
    }
  } catch (err) {
    console.error('Error deleting note template section:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}
