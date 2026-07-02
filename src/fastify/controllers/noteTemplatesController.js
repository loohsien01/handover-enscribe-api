import { claudeAPIReq } from '../../utils/bedrockClient.js';
import { getExtractNoteTemplateSectionsRequestBody } from '../../utils/claudeRequestBody.js';
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
  isPgUniqueViolation,
  pgCoerceBigIntFields,
  pgCoerceBigIntFieldsRows,
} from '../../utils/pgQueryHelpers.js';

const noteTemplatesTable = '"noteTemplates"';

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
 * Gets all note templates for authenticated user (self-owned + system)
 * GET /api/note-templates
 */
export async function getAllNoteTemplates(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const data = await pgQueryRows(
      `SELECT *
         FROM ${noteTemplatesTable}
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY created_at DESC`,
      [user.id]
    );

    return reply.status(200).send(pgCoerceBigIntFieldsRows(data, ['id']));
  } catch (err) {
    console.error('Error fetching note templates:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Gets a single note template by ID
 * GET /api/note-templates/:id
 */
export async function getNoteTemplate(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    const data = await pgQueryOne(
      `SELECT *
         FROM ${noteTemplatesTable}
        WHERE id = $1
          AND (user_id = $2 OR user_id IS NULL)`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    return reply.status(200).send(pgCoerceBigIntFields(data, ['id']));
  } catch (err) {
    console.error('Error fetching note template:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Creates a new note template for the authenticated user
 * POST /api/note-templates
 */
export async function createNoteTemplate(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { name } = request.body;

    if (!name) {
      return reply.status(400).send({ error: 'Name is required' });
    }

    console.log('[createNoteTemplate] Creating template:', { name, user_id: userId });

    try {
      const insertData = await pgQueryOne(
        `INSERT INTO ${noteTemplatesTable} (name, user_id)
         VALUES ($1, $2)
         RETURNING *`,
        [name, userId]
      );

      return reply.status(201).send(pgCoerceBigIntFields(insertData, ['id']));
    } catch (insertError) {
      console.error('Database error creating note template:', insertError);

      if (isPgUniqueViolation(insertError)) {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A template with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to create template' });
    }
  } catch (err) {
    console.error('Error creating note template:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Updates an existing note template
 * PATCH /api/note-templates/:id
 */
export async function updateNoteTemplate(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;
    const updateData = request.body;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    const existingTemplate = await pgQueryOne(
      `SELECT *
         FROM ${noteTemplatesTable}
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (!existingTemplate) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    console.log('[updateNoteTemplate] Updating template:', { id, name: updateData.name });

    try {
      const updatedData = await pgQueryOne(
        `UPDATE ${noteTemplatesTable}
            SET name = $1,
                updated_at = NOW()
          WHERE id = $2 AND user_id = $3
          RETURNING *`,
        [updateData.name, id, userId]
      );

      return reply.status(200).send(pgCoerceBigIntFields(updatedData, ['id']));
    } catch (updateError) {
      console.error('Database error updating note template:', updateError);

      if (isPgUniqueViolation(updateError)) {
        return reply.status(409).send({
          code: 'DUPLICATE_NAME',
          message: 'A template with this name already exists for your account',
          field: 'name',
        });
      }

      return reply.status(400).send({ error: 'Failed to update template' });
    }
  } catch (err) {
    console.error('Error updating note template:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Deletes a note template
 * DELETE /api/note-templates/:id
 */
export async function deleteNoteTemplate(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid template ID format' });
    }

    try {
      const deleted = await pgQueryOne(
        `DELETE FROM ${noteTemplatesTable}
          WHERE id = $1 AND user_id = $2
          RETURNING id`,
        [id, userId]
      );

      if (!deleted) {
        return reply.status(404).send({ error: 'Template not found' });
      }

      return reply.status(204).send();
    } catch (deleteError) {
      console.error('Database error deleting note template:', deleteError);

      if (deleteError && typeof deleteError === 'object' && 'code' in deleteError && deleteError.code === '23503') {
        return reply.status(409).send({
          code: 'RESOURCE_IN_USE',
          message: 'This template is still being used. Remove all references first.',
        });
      }

      return reply.status(400).send({ error: 'Failed to delete template' });
    }
  } catch (err) {
    console.error('Error deleting note template:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

// ---------------------------------------------------------------------------
// POST /api/note-templates/llm-extract — LLM PDF → section preview (no DB write)
// ---------------------------------------------------------------------------

/** Claude Bedrock supported MIME types for llm-extract */
const LLM_EXTRACT_SUPPORTED_MEDIA_TYPES = new Set(['application/pdf']);

const LLM_EXTRACT_EXT_TO_MEDIA_TYPE = {
  pdf: 'application/pdf',
};

function llmExtractInferMediaTypeFromFilename(filename) {
  try {
    const ext = filename?.split('.').pop()?.toLowerCase();
    return LLM_EXTRACT_EXT_TO_MEDIA_TYPE[ext] ?? null;
  } catch {
    return null;
  }
}

function llmExtractFirstJsonArray(str) {
  const start = str.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return str.substring(start, i + 1);
    }
  }
  return null;
}

function llmExtractStripMarkdownFences(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return s;
}

function llmExtractValidateSections(parsed) {
  if (!Array.isArray(parsed)) {
    return { valid: false, error: 'Claude response is not a JSON array' };
  }
  if (parsed.length === 0) {
    return { valid: false, error: 'Claude returned an empty sections array' };
  }

  const validLayouts = new Set(['paragraph', 'bullet points']);
  const sections = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== 'object' || item === null) {
      return { valid: false, error: `Section at index ${i} is not an object` };
    }
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      return { valid: false, error: `Section at index ${i} is missing a valid "name"` };
    }
    if (!validLayouts.has(item.layout)) {
      return { valid: false, error: `Section at index ${i} has invalid layout "${item.layout}" — must be "paragraph" or "bullet points"` };
    }
    if (typeof item.details !== 'string') {
      return { valid: false, error: `Section at index ${i} is missing "details"` };
    }

    sections.push({
      name: item.name.trim(),
      layout: item.layout,
      details: item.details.trim(),
    });
  }

  return { valid: true, sections };
}

/**
 * POST /api/note-templates/llm-extract
 *
 * Multipart form-data field `file` (PDF). Returns { sections } preview only.
 */
export async function extractNoteTemplateSections(request, reply) {
  let uploadedFile;
  try {
    uploadedFile = await request.file();
  } catch (err) {
    const msg = err?.message || 'Invalid multipart payload';
    if (msg.toLowerCase().includes('file too large')) {
      return reply.status(400).send({
        error: 'File too large',
        message: 'Uploaded file exceeds max size (10MB).',
      });
    }
    return reply.status(400).send({
      error: 'Invalid multipart request',
      message: msg,
    });
  }

  if (!uploadedFile) {
    return reply.status(400).send({
      error: 'Missing file',
      message: 'Send multipart/form-data with a "file" field.',
    });
  }

  const detectedMime = uploadedFile.mimetype || null;
  const fallbackMime = llmExtractInferMediaTypeFromFilename(uploadedFile.filename);
  const mediaType = detectedMime || fallbackMime;
  if (!mediaType) {
    return reply.status(400).send({
      error: 'Unsupported document format',
      message: 'Could not determine media type from upload metadata. Use a supported file type: pdf.',
    });
  }
  if (!LLM_EXTRACT_SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    return reply.status(400).send({
      error: 'Unsupported media_type',
      message: `"${mediaType}" is not supported. Accepted values: application/pdf.`,
    });
  }

  let documentBuffer;
  try {
    documentBuffer = await uploadedFile.toBuffer();
  } catch (err) {
    console.error('[extractNoteTemplateSections] Upload read error:', err.message);
    return reply.status(400).send({
      error: 'Failed to read uploaded file',
      message: 'Could not read uploaded file content.',
    });
  }

  if (documentBuffer.length === 0) {
    return reply.status(400).send({
      error: 'Empty document',
      message: 'The downloaded document contains no content.',
    });
  }

  const documentBase64 = documentBuffer.toString('base64');
  console.log(`[extractNoteTemplateSections] Received ${documentBuffer.length} bytes, media_type=${mediaType}, filename=${uploadedFile.filename || 'unknown'}`);

  let rawResponse;
  try {
    const reqBody = getExtractNoteTemplateSectionsRequestBody(documentBase64, mediaType);
    rawResponse = await claudeAPIReq(reqBody);
  } catch (err) {
    console.error('[extractNoteTemplateSections] Claude API error:', err.message);
    return reply.status(502).send({
      error: 'Claude API request failed',
      message: err.message,
    });
  }

  let rawString = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  rawString = llmExtractStripMarkdownFences(rawString);

  const jsonArrayStr = llmExtractFirstJsonArray(rawString);
  if (!jsonArrayStr) {
    console.error('[extractNoteTemplateSections] No JSON array found in Claude response:', rawString.substring(0, 300));
    return reply.status(502).send({
      error: 'Unexpected Claude response',
      message: 'Claude did not return a JSON array. Please try again.',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonArrayStr);
  } catch (err) {
    console.error('[extractNoteTemplateSections] JSON parse error:', err.message, '| Raw:', jsonArrayStr.substring(0, 200));
    return reply.status(502).send({
      error: 'Failed to parse Claude response',
      message: 'The response from Claude could not be parsed as JSON.',
    });
  }

  const { valid, sections, error: validationError } = llmExtractValidateSections(parsed);
  if (!valid) {
    console.error('[extractNoteTemplateSections] Validation failed:', validationError);
    return reply.status(502).send({
      error: 'Invalid sections in Claude response',
      message: validationError,
    });
  }

  console.log(`[extractNoteTemplateSections] Extracted ${sections.length} sections successfully`);
  return reply.status(200).send({ sections });
}
