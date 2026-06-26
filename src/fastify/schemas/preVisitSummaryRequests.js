import { z } from 'zod';
import { uuidRegex } from './regex.js';
import { novaChatCompletionRequestSchema } from './novaChatRequests.js';

export const visitPrepIdParamsSchema = z.object({
  id: z.string().regex(uuidRegex, 'Invalid visit prep id'),
});

export const visitPrepCreateRequestSchema = z
  .object({
    chat_id: z.string().regex(uuidRegex, 'Invalid chat_id'),
    text: z.string().default(''),
  })
  .strict();

export const visitPrepPatchRequestSchema = z
  .object({
    text: z.string(),
  })
  .strict();

export const visitPrepListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    sortBy: z.enum(['created_at', 'updated_at', 'id']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .transform((d) => ({
    limit: d.limit ?? 50,
    offset: d.offset ?? 0,
    sortBy: d.sortBy ?? 'created_at',
    order: d.order ?? 'desc',
  }));

/** POST …/completions-and-save-visit-prep — completions body + optional extract_title_details */
export const novaChatCompletionAndSaveVisitPrepRequestSchema = novaChatCompletionRequestSchema.extend({
  extract_title_details: z.boolean().optional(),
});
