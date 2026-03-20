import { z } from 'zod';
import { isoDatetimeRegex, uuidRegex } from './regex.js';

/**
 * Database schema for Note Template Section
 * What's stored in the database with encrypted fields
 *
 * Request schemas: requests.js (noteTemplateSectionCreateRequestSchema, noteTemplateSectionUpdateRequestSchema)
 * Response schemas: responses.js (noteTemplateSectionResponseSchema)
 */
export const noteTemplateSectionDatabaseSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.string().regex(uuidRegex, 'Invalid UUID').nullable(),
  created_at: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime'),
  updated_at: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime').nullable(),
  name: z.string().min(1, 'Name is required').max(255, 'Name must be 255 characters or less'),
  layout: z.enum(['paragraph', 'bullet points'], {
    errorMap: () => ({ message: 'Layout must be either "paragraph" or "bullet points"' }),
  }),
  encrypted_details: z.string().min(1, 'Encrypted details cannot be empty'),
  details_iv: z.string().min(1, 'IV cannot be empty'),
});
