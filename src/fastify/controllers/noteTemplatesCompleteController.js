/**
 * Note Templates Complete Controller
 * Handles complete template operations with embedded sections + ordering
 * GET /api/note-templates/complete - batch with pagination
 * GET /api/note-templates/complete/:id - single with sections
 * POST /api/note-templates/complete - create with sections (atomic via RPC)
 * PATCH /api/note-templates/complete/:id - update template + sections + ordering (atomic via RPC)
 */

import { getSupabaseClient, createAuthClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { createClient } from '@supabase/supabase-js';

const noteTemplatesTable = 'noteTemplates';
const noteTemplateSectionsTable = 'noteTemplateSections';
const noteTemplateSectionOrdersTable = 'noteTemplateSectionOrders';
const userSecurityConfigTable = 'userSecurityConfigs';

/**
 * Gets the system master key using service role credentials
 * System key has user_id = NULL and decrypts all system-provided templates
 */
async function getSystemMasterKey() {
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
 */
async function getOrCreateUserMasterKey(supabase, userId) {
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

/**
 * Encrypts the details field for a section using user's master key
 * Creates new IV for each encryption
 */
function encryptSectionDetails(section, masterKeyBuffer) {
  try {
    if (!section.details) {
      return { success: true, error: null, section };
    }

    const aesKeyBase64 = Buffer.isBuffer(masterKeyBuffer)
      ? masterKeyBuffer.toString('base64')
      : masterKeyBuffer;

    const ivBase64 = encryptionUtils.generateRandomIVBase64();

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
 * Decrypts the details field for a section using user's master key
 */
function decryptSectionDetails(section, masterKeyBuffer) {
  try {
    if (!section.encrypted_details || !section.details_iv) {
      return { success: true, error: null, section };
    }

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
 * Helper: Recursively converts BigInt values to strings in an object
 * Needed for JSON serialization since JSON.stringify doesn't support BigInt
 */
function convertBigIntsToStrings(obj) {
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(item => convertBigIntsToStrings(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const converted = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        converted[key] = convertBigIntsToStrings(obj[key]);
      }
    }
    return converted;
  }
  return obj;
}

/**
 * Fetches template + sections + ordering for a single template
 * Returns with decrypted section details
 */
async function getCompleteTemplate(supabase, templateId, userId) {
  try {
    // Fetch template
    const { data: template, error: templateError } = await supabase
      .from(noteTemplatesTable)
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      return { success: false, error: 'Template not found', template: null, sections: null };
    }

    // Authorization: user owns it or it's system (user_id = null)
    if (template.user_id !== null && template.user_id !== userId) {
      return { success: false, error: 'Unauthorized', template: null, sections: null };
    }

    // Fetch sections in order
    const { data: orders, error: ordersError } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .select('noteTemplateSection_id, order')
      .eq('noteTemplate_id', templateId)
      .order('order', { ascending: true });

    if (ordersError) {
      console.error('[getCompleteTemplate] Error fetching orders:', ordersError);
      return { success: false, error: 'Failed to fetch section ordering', template: null, sections: null };
    }

    if (!orders || orders.length === 0) {
      return {
        success: true,
        error: null,
        template,
        sections: [],
      };
    }

    // Fetch all sections
    const sectionIds = orders.map(o => o.noteTemplateSection_id);
    const { data: allSections, error: sectionsError } = await supabase
      .from(noteTemplateSectionsTable)
      .select('*')
      .in('id', sectionIds);

    if (sectionsError) {
      console.error('[getCompleteTemplate] Error fetching sections:', sectionsError);
      return { success: false, error: 'Failed to fetch sections', template: null, sections: null };
    }

    if (!allSections || allSections.length === 0) {
      return { success: true, error: null, template, sections: [] };
    }

    // Get encryption keys
    const hasSystemSections = allSections.some(s => s.user_id === null);
    const hasUserSections = allSections.some(s => s.user_id !== null);

    let systemKeyResult = null;
    let userKeyResult = null;

    if (hasSystemSections) {
      systemKeyResult = await getSystemMasterKey();
      if (!systemKeyResult.success) {
        console.warn('[getCompleteTemplate] Failed to get system key:', systemKeyResult.error);
      }
    }

    if (hasUserSections) {
      userKeyResult = await getOrCreateUserMasterKey(supabase, userId);
      if (!userKeyResult.success) {
        return { success: false, error: userKeyResult.error, template: null, sections: null };
      }
    }

    // Decrypt all sections in parallel
    const decryptedSections = await Promise.all(
      orders.map(async (order) => {
        const section = allSections.find(s => s.id === order.noteTemplateSection_id);
        if (!section) return null;

        if (!section.encrypted_details) {
          return section;
        }

        const keyResult = section.user_id === null ? systemKeyResult : userKeyResult;
        if (!keyResult || !keyResult.success) {
          console.error(`[getCompleteTemplate] No key available for section ${section.id}`);
          return section; // Return encrypted as fallback
        }

        const decryptResult = decryptSectionDetails(section, keyResult.masterKey);
        if (!decryptResult.success) {
          console.error(`[getCompleteTemplate] Failed to decrypt section ${section.id}`);
          return section; // Return encrypted as fallback
        }

        return decryptResult.section;
      })
    );

    return {
      success: true,
      error: null,
      template,
      sections: decryptedSections.filter(s => s !== null),
    };
  } catch (err) {
    console.error('[getCompleteTemplate] Unexpected error:', err);
    return { success: false, error: 'Internal server error', template: null, sections: null };
  }
}

/**
 * Helper: Strips encrypted details from sections
 * Returns sections without encrypted_details and details_iv fields
 */
function stripEncryptedDetails(sections) {
  return sections.map(section => {
    const { encrypted_details, details_iv, ...strippedSection } = section;
    return strippedSection;
  });
}

/**
 * GET /api/note-templates/complete
 * Batch fetch templates with sections and pagination
 * Query params:
 *   - limit: int (default: 20)
 *   - offset: int (default: 0)
 *   - include_details: boolean (default: false) - if true, includes decrypted section details
 */
export async function getAllNoteTemplatesComplete(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { limit = 20, offset = 0, include_details = 'false' } = request.query;
    const includeDetails = include_details === 'true';

    // Fetch templates with pagination
    const { data: templates, error: templatesError } = await supabase
      .from(noteTemplatesTable)
      .select('*')
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (templatesError) {
      console.error('[getAllNoteTemplatesComplete] Error fetching templates:', templatesError);
      return reply.status(500).send({ error: 'Failed to fetch templates' });
    }

    if (!templates || templates.length === 0) {
      return reply.status(200).send({ templates: [], total: 0 });
    }

    // Fetch sections and ordering for all templates
    const templateIds = templates.map(t => t.id);
    const { data: allOrders, error: ordersError } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .select('noteTemplate_id, noteTemplateSection_id, order')
      .in('noteTemplate_id', templateIds)
      .order('noteTemplate_id', { ascending: true })
      .order('order', { ascending: true });

    if (ordersError) {
      console.error('[getAllNoteTemplatesComplete] Error fetching orders:', ordersError);
      return reply.status(500).send({ error: 'Failed to fetch section ordering' });
    }

    // Fetch all sections needed
    const sectionIds = [...new Set(allOrders?.map(o => o.noteTemplateSection_id) || [])];
    let allSections = [];

    if (sectionIds.length > 0) {
      const { data: sectionsData, error: sectionsError } = await supabase
        .from(noteTemplateSectionsTable)
        .select('*')
        .in('id', sectionIds);

      if (sectionsError) {
        console.error('[getAllNoteTemplatesComplete] Error fetching sections:', sectionsError);
        return reply.status(500).send({ error: 'Failed to fetch sections' });
      }

      allSections = sectionsData || [];
    }

    // If we need to decrypt, get the keys
    let systemKeyResult = null;
    let userKeyResult = null;

    if (includeDetails && allSections.length > 0) {
      const hasSystemSections = allSections.some(s => s.user_id === null);
      const hasUserSections = allSections.some(s => s.user_id !== null);

      if (hasSystemSections) {
        systemKeyResult = await getSystemMasterKey();
        if (!systemKeyResult.success) {
          console.warn('[getAllNoteTemplatesComplete] Failed to get system key:', systemKeyResult.error);
        }
      }

      if (hasUserSections) {
        userKeyResult = await getOrCreateUserMasterKey(supabase, userId);
        if (!userKeyResult.success) {
          return reply.status(500).send({ error: userKeyResult.error });
        }
      }
    }

    // Build response with sections grouped by template
    const templatesWithSections = templates.map(template => {
      const templateOrders = (allOrders || [])
        .filter(o => o.noteTemplate_id === template.id)
        .sort((a, b) => a.order - b.order);

      let sections = templateOrders
        .map(order => allSections.find(s => s.id === order.noteTemplateSection_id))
        .filter(s => s !== undefined);

      // If include_details is false, strip encrypted details
      if (!includeDetails) {
        sections = stripEncryptedDetails(sections);
      } else {
        // Decrypt all sections in parallel
        sections = sections.map(section => {
          if (!section.encrypted_details) {
            return section;
          }

          const keyResult = section.user_id === null ? systemKeyResult : userKeyResult;
          if (!keyResult || !keyResult.success) {
            console.warn(`[getAllNoteTemplatesComplete] No key available for section ${section.id}`);
            return section; // Return as-is if can't decrypt
          }

          const decryptResult = decryptSectionDetails(section, keyResult.masterKey);
          if (!decryptResult.success) {
            console.warn(`[getAllNoteTemplatesComplete] Failed to decrypt section ${section.id}`);
            return section; // Return as-is if decrypt fails
          }

          return decryptResult.section;
        });
      }

      return {
        ...template,
        sections,
      };
    });

    return reply.status(200).send({
      templates: convertBigIntsToStrings(templatesWithSections),
      total: templatesWithSections.length,
    });
  } catch (err) {
    console.error('[getAllNoteTemplatesComplete] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * GET /api/note-templates/complete/:id
 * Fetch single template with all decrypted sections
 */
export async function getNoteTemplateComplete(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    const result = await getCompleteTemplate(supabase, BigInt(id), userId);

    if (!result.success) {
      const statusCode = result.error === 'Unauthorized' ? 403 : 404;
      return reply.status(statusCode).send({ error: result.error });
    }

    return reply.status(200).send({
      template: convertBigIntsToStrings(result.template),
      sections: convertBigIntsToStrings(result.sections),
    });
  } catch (err) {
    console.error('[getNoteTemplateComplete] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * POST /api/note-templates/complete
 * Create template with new and/or existing sections (atomic via RPC)
 * Sections with 'id': link existing
 * Sections without 'id': create new
 */
export async function createNoteTemplateComplete(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { name, sections } = request.body;

    if (!name || !sections || sections.length === 0) {
      return reply.status(400).send({ error: 'Name and at least one section are required' });
    }

    console.log('[createNoteTemplateComplete] Creating template:', {
      name,
      sectionsCount: sections.length,
      user_id: userId,
    });

    // Separate sections into new (no id) and existing (with id)
    const newSections = sections.filter((s) => !s.id);
    const existingSections = sections.filter((s) => s.id);

    // Get user's master key if there are new sections to encrypt
    let masterKey = null;
    if (newSections.length > 0) {
      const keyResult = await getOrCreateUserMasterKey(supabase, userId);
      if (!keyResult.success) {
        return reply.status(500).send({ error: keyResult.error });
      }
      masterKey = keyResult.masterKey;
    }

    // Encrypt new section details and prepare sections for RPC
    const sectionsForRpc = sections.map((section) => {
      const sectionCopy = { ...section };

      // If it's a new section, validate name and encrypt details if provided
      if (!sectionCopy.id) {
        if (!sectionCopy.name || sectionCopy.name.trim() === '') {
          throw new Error('New sections must have a non-empty name');
        }

        // Encrypt details if provided and no pre-encrypted data
        if (sectionCopy.details && !sectionCopy.encrypted_details) {
          const encryptResult = encryptSectionDetails(sectionCopy, masterKey);
          if (!encryptResult.success) {
            throw new Error(`Failed to encrypt section: ${encryptResult.error}`);
          }
          return encryptResult.section;
        }
      }

      return sectionCopy;
    });

    console.log('[createNoteTemplateComplete] Calling RPC with sections:', {
      count: sectionsForRpc.length,
      new: newSections.length,
      existing: existingSections.length,
    });

    // Call RPC function
    // Note: Pass sections as object, not stringified - Supabase client handles JSON serialization
    const { data, error } = await supabase.rpc('create_note_template_complete', {
      p_name: name,
      p_user_id: userId,
      p_sections: sectionsForRpc,
    });

    if (error) {
      console.error('[createNoteTemplateComplete] RPC error:', error);

      if (error.message.includes('already exists')) {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A template with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: error.message || 'Failed to create template' });
    }

    if (!data || !data[0].success) {
      console.error('[createNoteTemplateComplete] RPC returned error:', data?.[0]?.error);
      return reply.status(400).send({ error: data?.[0]?.error || 'Failed to create template' });
    }

    const templateId = data[0].template_id;

    // Fetch complete data to return
    const result = await getCompleteTemplate(supabase, templateId, userId);

    if (!result.success) {
      return reply.status(500).send({ error: result.error });
    }

    return reply.status(201).send({
      template: convertBigIntsToStrings(result.template),
      sections: convertBigIntsToStrings(result.sections),
    });
  } catch (err) {
    console.error('[createNoteTemplateComplete] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/note-templates/complete/:id
 * Update template name, section details, and section ordering (atomic via RPC)
 */
export async function updateNoteTemplateComplete(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;
    const { name, sections } = request.body;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    console.log('[updateNoteTemplateComplete] Updating template:', { id, name, sectionsCount: sections?.length || 0 });

    // Verify template exists and user owns it
    const { data: existing, error: fetchError } = await supabase
      .from(noteTemplatesTable)
      .select('*')
      .eq('id', parseInt(id, 10))
      .single();

    if (fetchError || !existing) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    if (existing.user_id !== userId) {
      return reply.status(403).send({ error: 'Unauthorized' });
    }

    // If sections are provided, process them (encrypt new sections, prepare for RPC)
    let sectionsForRpc = null;
    if (sections && sections.length > 0) {
      // Separate sections into new (no id) and existing (with id)
      const newSections = sections.filter((s) => !s.id);
      const existingSections = sections.filter((s) => s.id);

      // Get user's master key once if there are any sections needing encryption
      let masterKey = null;
      if ((newSections.length > 0 || existingSections.some((s) => s.details)) && !existingSections.some((s) => s.encrypted_details)) {
        const keyResult = await getOrCreateUserMasterKey(supabase, userId);
        if (!keyResult.success) {
          return reply.status(500).send({ error: keyResult.error });
        }
        masterKey = keyResult.masterKey;
      }

      sectionsForRpc = sections.map((section) => {
        const sectionCopy = { ...section };

        // For new sections, validate name and encrypt details if provided
        if (!sectionCopy.id) {
          if (!sectionCopy.name || sectionCopy.name.trim() === '') {
            throw new Error('New sections must have a non-empty name');
          }

          // Encrypt details if provided and no pre-encrypted data
          if (sectionCopy.details && !sectionCopy.encrypted_details) {
            const encryptResult = encryptSectionDetails(sectionCopy, masterKey);
            if (!encryptResult.success) {
              throw new Error(`Failed to encrypt section: ${encryptResult.error}`);
            }
            return encryptResult.section;
          }
        } else {
          // For existing sections, encrypt details if provided
          if (sectionCopy.details && !sectionCopy.encrypted_details) {
            const encryptResult = encryptSectionDetails(sectionCopy, masterKey);
            if (!encryptResult.success) {
              throw new Error(`Failed to encrypt section ${section.id}: ${encryptResult.error}`);
            }
            return encryptResult.section;
          }
        }

        return sectionCopy;
      });
    }

    console.log('[updateNoteTemplateComplete] Calling RPC with sections:', {
      count: sectionsForRpc?.length || 0,
    });

    // Call RPC function
    // Note: Pass id as number, not BigInt - Supabase client can't serialize BigInt
    // Note: Pass sections as object, not stringified - Supabase client handles JSON serialization
    const { data, error } = await supabase.rpc('update_note_template_complete', {
      p_template_id: parseInt(id, 10),
      p_user_id: userId,
      p_name: name || existing.name,
      p_sections: sectionsForRpc,
    });

    if (error) {
      console.error('[updateNoteTemplateComplete] RPC error:', error);

      if (error.message.includes('already exists')) {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A template with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: error.message || 'Failed to update template' });
    }

    if (!data || !data[0].success) {
      console.error('[updateNoteTemplateComplete] RPC returned error:', data?.[0]?.error);
      return reply.status(400).send({ error: data?.[0]?.error || 'Failed to update template' });
    }

    // Fetch complete data to return
    const result = await getCompleteTemplate(supabase, BigInt(id), userId);

    if (!result.success) {
      return reply.status(500).send({ error: result.error });
    }

    return reply.status(200).send({
      template: convertBigIntsToStrings(result.template),
      sections: convertBigIntsToStrings(result.sections),
    });
  } catch (err) {
    console.error('[updateNoteTemplateComplete] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
