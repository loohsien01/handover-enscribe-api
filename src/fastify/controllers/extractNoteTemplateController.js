/**
 * Extract Note Template Controller
 *
 * POST /api/extract-note-template
 *
 * Accepts a multipart document upload, sends the file to Claude Bedrock as a
 * native document block, and returns a validated array of noteTemplateSection
 * objects: [{ name, layout, details }].
 *
 * This is a preview-only endpoint — it does NOT persist anything to the database.
 * Callers can review/edit the returned sections and then save via the existing
 * POST /api/note-templates/complete endpoint.
 */

import { claudeAPIReq } from '../../utils/bedrockClient.js';
import { getExtractNoteTemplateSectionsRequestBody } from '../../utils/claudeRequestBody.js';

/** Claude Bedrock supported MIME types for this endpoint */
const SUPPORTED_MEDIA_TYPES = new Set([
  'application/pdf',
]);

/** Extension-to-MIME map for fallback auto-detection */
const EXT_TO_MEDIA_TYPE = {
  pdf: 'application/pdf',
};

/**
 * Infer MIME type from filename extension.
 * Returns null when extension is unrecognised.
 */
function inferMediaTypeFromFilename(filename) {
  try {
    const ext = filename?.split('.').pop()?.toLowerCase();
    return EXT_TO_MEDIA_TYPE[ext] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the first JSON array from a raw string.
 * Handles cases where Claude adds a preamble or trailing prose.
 */
function extractFirstJsonArray(str) {
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

/**
 * Strip markdown code fences (```json … ```) that Claude sometimes adds.
 */
function stripMarkdownFences(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return s;
}

/**
 * Validate and normalise the array returned by Claude.
 * Returns { valid: true, sections } or { valid: false, error }.
 */
function validateSections(parsed) {
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
 * POST /api/extract-note-template
 *
 * Multipart form-data:
 *   file          {binary}  Uploaded PDF file
 *
 * Responses:
 *   200 { sections: [{ name, layout, details }] }
 *   400 Validation / unsupported format errors
 *   502 Claude API / downstream errors
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
  const fallbackMime = inferMediaTypeFromFilename(uploadedFile.filename);
  const mediaType = detectedMime || fallbackMime;
  if (!mediaType) {
    return reply.status(400).send({
      error: 'Unsupported document format',
      message: 'Could not determine media type from upload metadata. Use a supported file type: pdf.',
    });
  }
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
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

  // Call Claude
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

  // Parse response
  let rawString = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  rawString = stripMarkdownFences(rawString);

  const jsonArrayStr = extractFirstJsonArray(rawString);
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

  const { valid, sections, error: validationError } = validateSections(parsed);
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
