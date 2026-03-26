import { createPromptLlmJobHandler } from '../jobController.js';

/**
 * POST /api/jobs/prompt-llm/generate-note
 * Wrapper for job-based SOAP note generation (shared with promptLlmJobs routes).
 */
export async function generateNoteHandler(request, reply) {
  return createPromptLlmJobHandler(request, reply);
}

