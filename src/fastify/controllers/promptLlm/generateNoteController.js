import { createPromptLlmJobHandler, createPromptLlmJobAndSaveNoteHandler } from '../jobController.js';

/**
 * POST /api/jobs/prompt-llm/generate-note
 * Wrapper for job-based SOAP note generation (shared with promptLlmJobs routes).
 */
export async function generateNoteHandler(request, reply) {
  return createPromptLlmJobHandler(request, reply);
}

/**
 * POST /api/jobs/prompt-llm/generate-and-save-note
 * Generate SOAP then persist encounter + recording + note when successful.
 */
export async function generateAndSaveNoteHandler(request, reply) {
  return createPromptLlmJobAndSaveNoteHandler(request, reply);
}

