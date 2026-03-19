import { getSupabaseClient, createAuthClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { createClient } from '@supabase/supabase-js';

const noteTemplateSectionsTable = 'noteTemplateSections';
const userSecurityConfigTable = 'userSecurityConfigs';

/**
 * Gets the system master key using service role credentials
 * System key has user_id = NULL and decrypts all system-provided templates
 * @returns {object} { success, error, masterKey: Buffer }
 */
async function getSystemMasterKey() {
  try {
    // Create service role client (bypasses RLS)
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
      console.log('[getSystemMasterKey] Retrieved system master key');
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
 * Gets or creates the user's master encryption key from userSecurityConfigs.
 * Master key is RSA-wrapped and stored per-user.
 * @param {object} supabase - Supabase client
 * @param {string} userId - User ID (UUID)
 * @returns {object} { success, error, masterKey: Buffer }
 */
async function getOrCreateUserMasterKey(supabase, userId) {
  try {
    // Try to fetch existing wrapped master key
    const { data, error } = await supabase
      .from(userSecurityConfigTable)
      .select('wrapped_master_key')
      .eq('user_id', userId);

    if (error) {
      console.error('[getOrCreateUserMasterKey] Database error:', error);
      return { success: false, error: 'Failed to fetch security config', masterKey: null };
    }

    if (data && data.length > 1) {
      console.error('[getOrCreateUserMasterKey] Data integrity error: multiple configs found for user');
      return { success: false, error: 'Data integrity error: duplicate security config', masterKey: null };
    }

    // If found, decrypt and return the master key
    if (data && data.length === 1) {
      try {
        const masterKeyBuffer = encryptionUtils.decryptAESKey(data[0].wrapped_master_key);
        console.log('[getOrCreateUserMasterKey] Found existing master key for user');
        return { success: true, error: null, masterKey: masterKeyBuffer };
      } catch (err) {
        console.error('[getOrCreateUserMasterKey] Failed to decrypt master key:', err);
        return { success: false, error: 'Failed to decrypt master key', masterKey: null };
      }
    }

    // Not found - create new master key
    console.log('[getOrCreateUserMasterKey] Creating new master key for user');
    try {
      const { aesKey: newAesKeyBase64 } = encryptionUtils.generateAESKeyAndIV();
      const wrappedMasterKey = encryptionUtils.encryptAESKey(newAesKeyBase64);

      const { error: insertError } = await supabase
        .from(userSecurityConfigTable)
        .insert([
          {
            user_id: userId,
            wrapped_master_key: wrappedMasterKey,
          },
        ]);

      if (insertError) {
        console.error('[getOrCreateUserMasterKey] Failed to insert security config:', insertError);
        return { success: false, error: 'Failed to create security config', masterKey: null };
      }

      // Decrypt and return the newly created master key
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

/**
 * Encrypts the details field for a note template section using user's master key.
 * @param {object} section - Section object containing details field
 * @param {Buffer} masterKeyBuffer - Unwrapped master AES key
 * @returns {object} { success, error, section }
 */
function encryptSectionDetails(section, masterKeyBuffer) {
  try {
    if (!section.details) {
      return { success: true, error: null, section };
    }

    // Convert master key buffer to base64 for encryptText
    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    // Generate new IV for this section
    const ivBase64 = encryptionUtils.generateRandomIVBase64();

    // Encrypt details with user's master key
    try {
      section.encrypted_details = encryptionUtils.encryptText(
        section.details,
        aesKeyBase64,
        ivBase64
      );
      section.details_iv = ivBase64;
      delete section.details;
      return { success: true, error: null, section };
    } catch (err) {
      console.error('[encryptSectionDetails] Failed to encrypt details:', err);
      return { success: false, error: 'Failed to encrypt details', section: null };
    }
  } catch (err) {
    console.error('[encryptSectionDetails] Error:', err);
    return { success: false, error: 'Failed to encrypt section', section: null };
  }
}

/**
 * Decrypts the details field for a note template section using its own encrypted AES key.
 * @param {object} section - Section object containing encrypted_details, details_iv, and encrypted_aes_key
 * @returns {object} { success, error, section }
 */
/**
 * Decrypts the details field for a note template section using user's master key.
 * @param {object} section - Section object containing encrypted_details and details_iv
 * @param {Buffer} masterKeyBuffer - Unwrapped master AES key
 * @returns {object} { success, error, section }
 */
function decryptSectionDetails(section, masterKeyBuffer) {
  try {
    if (!section.encrypted_details || !section.details_iv) {
      return { success: true, error: null, section };
    }

    // Convert master key buffer to base64 for decryptText
    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    try {
      section.details = encryptionUtils.decryptText(
        section.encrypted_details,
        aesKeyBase64,
        section.details_iv
      );
      delete section.encrypted_details;
      delete section.details_iv;
      return { success: true, error: null, section };
    } catch (err) {
      console.error('[decryptSectionDetails] Failed to decrypt details:', err);
      return { success: false, error: 'Failed to decrypt details', section: null };
    }
  } catch (err) {
    console.error('[decryptSectionDetails] Error:', err);
    return { success: false, error: 'Failed to decrypt section', section: null };
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

    const { data, error } = await supabase
      .from(noteTemplateSectionsTable)
      .select('*')
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Database error fetching sections:', error);
      return reply.status(500).send({ error: 'Failed to fetch sections' });
    }

    if (!data || data.length === 0) {
      return reply.status(200).send([]);
    }

    // Fetch keys needed for decryption (once, not per-section)
    const hasSystemTemplates = data.some(s => s.user_id === null);
    const hasUserTemplates = data.some(s => s.user_id !== null);

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

    // Decrypt all sections in parallel
    const decryptedSections = await Promise.all(
      data.map(async (section) => {
        if (!section.encrypted_details) {
          return section;
        }

        // Select the correct key based on template ownership
        const keyResult = section.user_id === null ? systemKeyResult : userKeyResult;

        if (!keyResult || !keyResult.success) {
          console.error(
            `[getAllNoteTemplateSections] No key available for section ${section.id}`,
            section.user_id === null ? 'system' : 'user'
          );
          return section;
        }

        const decryptResult = decryptSectionDetails(section, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error(`[getAllNoteTemplateSections] Failed to decrypt section ${section.id}:`, decryptResult.error);
          return section;
        }

        return decryptResult.section;
      })
    );

    return reply.status(200).send(decryptedSections);
  } catch (err) {
    console.error('Error fetching note template sections:', err);
    return reply.status(500).send({ error: 'Internal server error' });
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

    const { data, error } = await supabase
      .from(noteTemplateSectionsTable)
      .select('*')
      .eq('id', id)
      .or(`user_id.eq.${userId},user_id.is.null`)
      .single();

    if (error) {
      console.error('Database error fetching section:', error);
      return reply.status(404).send({ error: 'Section not found' });
    }

    if (!data) {
      return reply.status(404).send({ error: 'Section not found' });
    }

    if (data.encrypted_details) {
      // Determine which key to use: system key or user key
      let keyResult;
      if (data.user_id === null) {
        // System template - use system key
        keyResult = await getSystemMasterKey();
      } else {
        // User template - use user key
        keyResult = await getOrCreateUserMasterKey(supabase, userId);
      }

      if (!keyResult.success) {
        return reply.status(500).send({ error: keyResult.error });
      }

      const decryptResult = decryptSectionDetails(data, keyResult.masterKey);
      if (!decryptResult.success) {
        return reply.status(400).send({ error: decryptResult.error });
      }
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('Error fetching note template section:', err);
    return reply.status(500).send({ error: 'Internal server error' });
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

    // Get or create user's master key (users can only create their own templates)
    const keyResult = await getOrCreateUserMasterKey(supabase, userId);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }

    const encryptionResult = encryptSectionDetails(section, keyResult.masterKey);
    if (!encryptionResult.success) {
      return reply.status(400).send({ error: encryptionResult.error });
    }

    const { data: insertData, error: insertError } = await supabase
      .from(noteTemplateSectionsTable)
      .insert([encryptionResult.section])
      .select()
      .single();

    if (insertError) {
      console.error('Database error creating section:', insertError);

      // Check for unique constraint violation (duplicate name)
      if (insertError.code === '23505') {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A section with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to create section' });
    }

    if (insertData.encrypted_details) {
      const decryptResult = decryptSectionDetails(insertData, keyResult.masterKey);
      if (!decryptResult.success) {
        console.error('Failed to decrypt newly created section:', decryptResult.error);
      }
    }

    return reply.status(201).send(insertData);
  } catch (err) {
    console.error('Error creating note template section:', err);
    return reply.status(500).send({ error: 'Internal server error' });
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

    const { data: existingSection, error: fetchError } = await supabase
      .from(noteTemplateSectionsTable)
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchError || !existingSection) {
      console.error('Section not found or unauthorized:', fetchError);
      return reply.status(404).send({ error: 'Section not found' });
    }

    const section = {
      ...existingSection,
      ...updateData,
      user_id: userId,
      id: BigInt(id),
    };

    console.log('[updateNoteTemplateSection] Updating section:', { id, name: updateData.name });

    // Get or create user's master key (needed if details are being updated)
    const keyResult = await getOrCreateUserMasterKey(supabase, userId);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }

    if (updateData.details !== undefined) {
      const encryptionResult = encryptSectionDetails(section, keyResult.masterKey);
      if (!encryptionResult.success) {
        return reply.status(400).send({ error: encryptionResult.error });
      }

      const { id: _, ...sectionForUpdate } = encryptionResult.section;

      const { data: updatedData, error: updateError } = await supabase
        .from(noteTemplateSectionsTable)
        .update(sectionForUpdate)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (updateError) {
        console.error('Database error updating section:', updateError);

        if (updateError.code === '23505') {
          return reply.status(409).send({
            code: 'DUPLICATE_NAME',
            message: 'A section with this name already exists for your account',
            field: 'name',
          });
        }

        return reply.status(400).send({ error: 'Failed to update section' });
      }

      if (updatedData.encrypted_details) {
        const decryptResult = decryptSectionDetails(updatedData, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error('Failed to decrypt updated section:', decryptResult.error);
        }
      }

      return reply.status(200).send(updatedData);
    } else {
      const { id: _, ...sectionForUpdate } = updateData;

      const { data: updatedData, error: updateError } = await supabase
        .from(noteTemplateSectionsTable)
        .update(sectionForUpdate)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (updateError) {
        console.error('Database error updating section:', updateError);

        if (updateError.code === '23505') {
          return reply.status(409).send({
            code: 'DUPLICATE_NAME',
            message: 'A section with this name already exists for your account',
            field: 'name',
          });
        }

        return reply.status(400).send({ error: 'Failed to update section' });
      }

      if (updatedData.encrypted_details) {
        const decryptResult = decryptSectionDetails(updatedData, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error('Failed to decrypt updated section:', decryptResult.error);
        }
      }

      return reply.status(200).send(updatedData);
    }
  } catch (err) {
    console.error('Error updating note template section:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Deletes a note template section
 * DELETE /api/note-template-sections/:id
 */
export async function deleteNoteTemplateSection(request, reply) {
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

    const { error: deleteError } = await supabase
      .from(noteTemplateSectionsTable)
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Database error deleting section:', deleteError);

      if (deleteError.code === '23503') {
        return reply.status(409).send({
          code: 'RESOURCE_IN_USE',
          message: 'This section is still being used in one or more templates. Remove it from those templates first.',
        });
      }

      return reply.status(400).send({ error: 'Failed to delete section' });
    }

    return reply.status(204).send();
  } catch (err) {
    console.error('Error deleting note template section:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
