import { z } from 'zod';
import { isoDatetimeRegex, uuidRegex } from './regex.js';

/**
 * Database schema for Note Template
 * What's stored in the database
 *
 * Request schemas: requests.js (noteTemplateCreateRequestSchema, noteTemplateUpdateRequestSchema)
 * Response schemas: responses.js (noteTemplateResponseSchema, noteTemplateListSchema)
 */
export const noteTemplateDatabaseSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.string().regex(uuidRegex, 'Invalid UUID').nullable(),
  created_at: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime'),
  updated_at: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime').nullable(),
  name: z.string().min(1, 'Name is required').max(255, 'Name must be 255 characters or less'),
});
