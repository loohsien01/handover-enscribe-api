/**
 * Response and utility schemas for API responses
 * These schemas validate the data sent back to clients
 * Separate from requests.js (API contracts) and DB schemas
 */

import { z } from 'zod';

// ============================================================================
// AWS PHI Masking Response Schemas
// ============================================================================

/**
 * PHI Entity schema - represents a single masked entity
 */
export const PhiEntitySchema = z.object({
  Type: z.string().describe('PHI type (NAME, AGE, DATE, ADDRESS, etc.)'),
  Text: z.string().describe('Original PHI text before masking'),
  BeginOffset: z.number().int().describe('Start position in original text'),
  EndOffset: z.number().int().describe('End position in original text'),
  Score: z.number().min(0).max(1).describe('Confidence score (0-1)'),
  Id: z.union([z.number().int(), z.string()]).describe('Unique entity ID'),
});

/**
 * Response body for mask-phi endpoint
 */
export const MaskPhiResponseBodySchema = z.object({
  maskedText: z.string()
    .describe('Transcript with PHI replaced by {{TYPE_ID}} tokens'),
  entities: z.array(PhiEntitySchema)
    .describe('Array of detected and masked PHI entities'),
  tokens: z.record(z.any())
    .describe('Token mapping for unmasking'),
});

/**
 * Response body for unmask-phi endpoint
 */
export const UnmaskPhiResponseBodySchema = z.object({
  unmaskedText: z.string()
    .describe('Transcript with PHI tokens replaced with original text'),
});

// ============================================================================
// GCP Transcription Response Schemas
// ============================================================================

/**
 * Cloud Run transcription response schema
 */
export const CloudRunDataSchema = z.object({
  transcript: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  duration: z.number().optional(),
}).passthrough();

/**
 * Dot phrase object schema
 */
export const DotPhraseSchema = z.object({
  id: z.string().optional(),
  trigger: z.string(),
  expansion: z.string(),
  userId: z.string().optional(),
});

/**
 * PHI masking result schema (from AWS)
 */
export const MaskResultSchema = z.object({
  maskedText: z.string(),
  entities: z.array(z.object({
    Type: z.string(),
    Text: z.string(),
    BeginOffset: z.number(),
    EndOffset: z.number(),
    Score: z.number(),
    Id: z.union([z.number(), z.string()]),
  })),
  tokens: z.record(z.string(), z.any()),
}).passthrough();

/**
 * Response body for transcribe/complete endpoint - success case
 */
export const TranscribeResponseBodySchema = z.object({
  ok: z.literal(true),
  cloudRunData: CloudRunDataSchema,
  maskResult: MaskResultSchema,
}).passthrough();

/**
 * Error response schema
 */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  cloudRunData: CloudRunDataSchema.optional(),
  details: z.any().optional(),
});

// ============================================================================
// JSON Schema Definitions (for Fastify/OpenAPI documentation)
// ============================================================================

/**
 * JSON Schema format for Fastify validation - AWS mask-phi request
 */
export const maskPhiRequestSchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      description: 'Medical transcript to mask',
    },
    maskThreshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      default: 0.15,
      description: 'Confidence threshold for masking (0-1, default 0.15)',
    },
  },
};

/**
 * JSON Schema format for Fastify validation - AWS mask-phi response
 */
export const maskPhiResponseSchema = {
  type: 'object',
  required: ['maskedText', 'entities', 'tokens'],
  properties: {
    maskedText: {
      type: 'string',
      description: 'Transcript with PHI replaced by tokens',
    },
    entities: {
      type: 'array',
      description: 'Array of detected PHI entities',
    },
    tokens: {
      type: 'object',
      description: 'Token mapping for unmasking',
      additionalProperties: true,
    },
  },
};

/**
 * JSON Schema format for Fastify validation - AWS unmask-phi request
 */
export const unmaskPhiRequestSchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      description: 'Transcript with {{TYPE_ID}} tokens',
    },
    tokens: {
      type: 'object',
      description: 'Token mapping for unmasking',
      additionalProperties: true,
    },
  },
};

/**
 * JSON Schema format for Fastify validation - AWS unmask-phi response
 */
export const unmaskPhiResponseSchema = {
  type: 'object',
  properties: {
    unmaskedText: {
      type: 'string',
      description: 'Transcript with PHI tokens replaced with original text',
    },
  },
};

/**
 * JSON Schema format for Fastify validation - GCP transcribe request
 */
export const transcribeRequestSchema = {
  type: 'object',
  required: ['recording_file_signed_url'],
  properties: {
    recording_file_signed_url: {
      type: 'string',
      description: 'Signed URL to the recording file in Supabase',
    },
    enableDotPhraseExpansion: {
      type: 'boolean',
      default: true,
      description: 'Whether to enable dot phrase expansion',
    },
  },
};

/**
 * JSON Schema format for Fastify validation - GCP transcribe response
 */
export const transcribeResponseSchema = {
  type: 'object',
  required: ['ok', 'cloudRunData', 'maskResult'],
  additionalProperties: true,
  properties: {
    ok: {
      type: 'boolean',
      enum: [true],
    },
    cloudRunData: {
      type: 'object',
      required: ['transcript'],
      additionalProperties: true,
      properties: {
        transcript: {
          type: 'string',
          description: 'Transcribed text from Cloud Run',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence score for transcription',
        },
        duration: {
          type: 'number',
          description: 'Duration of audio in seconds',
        },
      },
    },
    maskResult: {
      type: 'object',
      required: ['maskedText', 'entities', 'tokens'],
      additionalProperties: true,
      properties: {
        maskedText: {
          type: 'string',
          description: 'Transcript with PHI replaced by {{TYPE_ID}} tokens',
        },
        entities: {
          type: 'array',
          description: 'Array of detected PHI entities',
          items: {
            type: 'object',
            required: ['Type', 'Text', 'BeginOffset', 'EndOffset', 'Score', 'Id'],
            properties: {
              Type: {
                type: 'string',
                description: 'PHI type (NAME, DATE, ID, PHONE_OR_FAX, etc.)',
              },
              Text: {
                type: 'string',
                description: 'Original PHI text',
              },
              BeginOffset: {
                type: 'number',
                description: 'Start position in transcript',
              },
              EndOffset: {
                type: 'number',
                description: 'End position in transcript',
              },
              Score: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'Confidence score',
              },
              Id: {
                description: 'Entity ID',
              },
            },
          },
        },
        tokens: {
          type: 'object',
          description: 'Token mapping for unmasking (TYPE_ID -> original text)',
          additionalProperties: true,
        },
      },
    },
  },
};

// ============================================================================
// Note Template Schemas
// ============================================================================

/**
 * Note Template response schema
 */
export const noteTemplatesResponseSchema = z.object({
  id: z.bigint(),
  user_id: z.string().uuid().nullable(),
  name: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable(),
});

export const noteTemplatesListSchema = z.array(noteTemplatesResponseSchema);

// ============================================================================
// Note Template Sections Schemas
// ============================================================================

/**
 * Note Template Section response schema
 * Includes decrypted details field, excludes encryption metadata
 */
export const noteTemplateSectionResponseSchema = z.object({
  id: z.bigint(),
  user_id: z.string().uuid().nullable(),
  name: z.string(),
  layout: z.enum(['paragraph', 'bullet points']),
  details: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable(),
});

export const noteTemplateSectionListSchema = z.array(noteTemplateSectionResponseSchema);

// ============================================================================
// Note Template Section Orders Schemas
// ============================================================================

/**
 * Note Template Section Order response schema
 */
export const noteTemplateSectionOrdersResponseSchema = z.object({
  id: z.bigint(),
  user_id: z.string().uuid().nullable(),
  note_templates_id: z.bigint(),
  note_template_sections_id: z.bigint(),
  order: z.number(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable(),
});

export const noteTemplateSectionOrdersListSchema = z.array(noteTemplateSectionOrdersResponseSchema);

// ============================================================================
// Notes Schemas
// ============================================================================

/**
 * Note response schema
 */
export const notesResponseSchema = z.object({
  id: z.bigint(),
  user_id: z.string().uuid(),
  note_template_id: z.bigint(),
  patient_encounter_id: z.bigint().nullable(),
  encrypted_text: z.string().nullable(),
  text_iv: z.string().nullable(),
  status: z.enum(['draft', 'in-progress', 'completed', 'archived']),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable(),
});

export const notesListSchema = z.array(notesResponseSchema);

// ============================================================================
// User Security Configs Schemas
// ============================================================================

/**
 * User Security Config response schema
 */
export const userSecurityConfigsResponseSchema = z.object({
  id: z.bigint(),
  user_id: z.string().uuid().nullable(),
  wrapped_master_key: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable(),
});
