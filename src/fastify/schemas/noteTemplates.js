import { z } from 'zod';

/**
 * Schema for Note Templates
 * A template defines the structure for note creation (e.g., SOAP Note - Standard)
 * Can be system-generated (user_id = NULL) or user-specific
 */

export const noteTemplatesCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Name is required' })
    .max(255, { message: 'Name must be 255 characters or less' }),
  layout: z.enum(['paragraph', 'bullet points']).optional(),
}).strict();
