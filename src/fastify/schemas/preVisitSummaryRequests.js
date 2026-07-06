import { z } from 'zod';
import { uuidRegex } from './regex.js';
import { novaChatCompletionRequestSchema } from './novaChatRequests.js';
import { NOVA_CHAT_TITLE_MAX_LENGTH } from '../../utils/novaChatTitle.js';

const preVisitSummaryTitleFieldSchema = z
  .string()
  .trim()
  .min(1, 'title cannot be empty')
  .max(NOVA_CHAT_TITLE_MAX_LENGTH);

export const preVisitSummaryIdParamsSchema = z.object({
  id: z.string().regex(uuidRegex, 'Invalid pre-visit summary id'),
});

export const preVisitSummaryCreateRequestSchema = z
  .object({
    chat_id: z.string().regex(uuidRegex, 'Invalid chat_id'),
    text: z.string().default(''),
    title: preVisitSummaryTitleFieldSchema.optional(),
  })
  .strict();

export const preVisitSummaryPatchRequestSchema = z
  .object({
    text: z.string().optional(),
    title: preVisitSummaryTitleFieldSchema.optional(),
  })
  .strict()
  .refine((b) => b.text !== undefined || b.title !== undefined, {
    message: 'At least one of text, title is required',
  });

export const preVisitSummaryListQuerySchema = z
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

/** POST …/completions-and-save-pre-visit-summary — completions body + optional extract_title_details */
export const novaChatCompletionAndSavePreVisitSummaryRequestSchema = novaChatCompletionRequestSchema.extend({
  extract_title_details: z.boolean().optional(),
});
