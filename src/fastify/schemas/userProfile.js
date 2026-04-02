import { z } from 'zod';
import { isoDatetimeRegex, uuidRegex } from './regex.js';

/**
 * Database schema for User Profile (public."userProfiles")
 * What's stored in the database
 *
 * Request schemas: requests.js (userProfileCreateRequestSchema, userProfilePatchRequestSchema)
 * Response schemas: responses.js (userProfileResponseSchema)
 */
export const userProfileDatabaseSchema = z.object({
  id: z.string().regex(uuidRegex, 'Invalid UUID'),
  user_id: z.string().regex(uuidRegex, 'Invalid UUID'),
  created_at: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime'),
  updated_at: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime'),
  username: z.string().min(1, 'Username is required'),
  specialty: z.string().min(1, 'Specialty is required'),
});
