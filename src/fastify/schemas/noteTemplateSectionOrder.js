import { z } from 'zod';

/**
 * Database schema for Note Template Section Order
 * Defines the order of sections within a note template
 * Links noteTemplateSections to noteTemplates with an order number
 */

export const noteTemplateSectionOrderDatabaseSchema = z.object({
  noteTemplate_id: z.bigint().or(z.string().transform(BigInt)),
  noteTemplateSection_id: z.bigint().or(z.string().transform(BigInt)),
  order: z.number().int().min(1, { message: 'Order must be at least 1' }),
}).strict();
