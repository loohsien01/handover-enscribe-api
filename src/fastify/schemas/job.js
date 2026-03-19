/**
 * Job Schema
 * 
 * Defines Zod schema for SOAP note generation jobs
 * Used for validation and type safety
 */

import { z } from 'zod';

// Job status enum
export const jobStatusEnum = z.enum(['pending', 'transcribing', 'generating', 'complete', 'error']);

// Job creation request (what client sends)
export const jobCreateRequestSchema = z.object({
  recording_file_path: z.string().min(1, 'Recording file path is required'),
});

// Job response (what API returns)
export const jobResponseSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  user_id: z.string().uuid(),
  status: jobStatusEnum,
  error_message: z.string().nullable().optional(),
  recording_file_path: z.string(),
  transcript_text: z.string().nullable().optional(),
  soap_note_text: z.string().nullable().optional(), // Stored as JSON string in DB
});

// Update job request (for backend internal use)
export const jobUpdateRequestSchema = z.object({
  status: jobStatusEnum.optional(),
  error_message: z.string().nullable().optional(),
  transcript_text: z.string().nullable().optional(),
  soap_note_text: z.string().nullable().optional(),
});
