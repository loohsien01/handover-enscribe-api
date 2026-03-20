import { z } from 'zod';

/**
 * Schema for Notes
 * A note is a SOAP note instance created from a template for a specific patient encounter
 * Contains encrypted text content (SOAP note + billing data) and status tracking
 */

export const notesCreateSchema = z.object({
  note_template_id: z.bigint().or(z.string().transform(BigInt)),
  patient_encounter_id: z.bigint().or(z.string().transform(BigInt)).optional().nullable(),
  status: z.enum(['draft', 'in-progress', 'completed', 'archived'], {
    message: 'Status must be one of: draft, in-progress, completed, archived',
  }),
}).strict();
