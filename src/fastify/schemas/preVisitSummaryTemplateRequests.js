import { z } from 'zod';
import { uuidRegex } from './regex.js';

export const PRE_VISIT_SUMMARY_TEMPLATE_TEXT_MAX = 50_000;
export const PRE_VISIT_SUMMARY_TEMPLATE_NAME_MAX = 200;

const templateNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(PRE_VISIT_SUMMARY_TEMPLATE_NAME_MAX, `Name must be at most ${PRE_VISIT_SUMMARY_TEMPLATE_NAME_MAX} characters`);

const templateTextSchema = z
  .string()
  .max(
    PRE_VISIT_SUMMARY_TEMPLATE_TEXT_MAX,
    `Text must be at most ${PRE_VISIT_SUMMARY_TEMPLATE_TEXT_MAX} characters`
  );

export const preVisitSummaryTemplateIdParamsSchema = z.object({
  id: z.string().regex(uuidRegex, 'Invalid pre-visit summary template id'),
});

export const preVisitSummaryTemplateCreateRequestSchema = z
  .object({
    name: templateNameSchema,
    text: templateTextSchema.default(''),
    is_default: z.boolean().optional().default(false),
  })
  .strict();

export const preVisitSummaryTemplatePatchRequestSchema = z
  .object({
    name: templateNameSchema.optional(),
    text: templateTextSchema.optional(),
    is_default: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field (name, text, is_default) must be provided',
  });

const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((value) => value === true || value === 'true' || value === '1');

export const preVisitSummaryTemplateListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    sortBy: z.enum(['created_at', 'updated_at', 'name', 'id']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    decrypt_text: queryBooleanSchema,
  })
  .transform((d) => ({
    limit: d.limit ?? 50,
    offset: d.offset ?? 0,
    sortBy: d.sortBy ?? 'created_at',
    order: d.order ?? 'desc',
    decrypt_text: d.decrypt_text ?? false,
  }));
