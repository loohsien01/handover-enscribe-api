import { z } from 'zod';

/**
 * Schema for Note Template Section Orders
 * Defines the order of sections within a note template
 * Links noteTemplateSections to noteTemplates with an order number
 */

export const noteTemplateSectionOrdersCreateSchema = z.object({
  note_templates_id: z.bigint().or(z.string().transform(BigInt)),
  note_template_sections_id: z.bigint().or(z.string().transform(BigInt)),
  order: z.number().int().min(1, { message: 'Order must be at least 1' }),
}).strict();
