/**
 * Prompt LLM Jobs Routes
 *
 * Polling-based job architecture for SOAP note generation
 * - POST /prompt-llm/generate-note - Create job, returns jobId immediately
 * - POST /prompt-llm/generate-and-save-note - Create job; after SOAP, persist encounter bundle
 * - GET /prompt-llm/:jobId - Poll job status and results
 * - GET /prompt-llm/:jobId/encounter-bundle - Saved encounter bundle (after generate-and-save-note + note_id)
 */

import {
  generateNoteHandler,
  generateAndSaveNoteHandler,
} from '../controllers/promptLlm/generateNoteController.js';
import {
  getPromptLlmJobStatusHandler,
  getPromptLlmJobEncounterBundleHandler,
} from '../controllers/jobController.js';
import {
  promptLlmGenerateNoteRequestSchema,
  promptLlmGenerateAndSaveNoteRequestSchema,
  getPromptLlmJobStatusQuerySchema,
} from '../schemas/requests.js';

/**
 * Register prompt LLM jobs routes (polling-based)
 * 
 * @param {Object} fastify - Fastify instance
 */
export async function registerPromptLlmJobsRoutes(fastify) {
  const postGenerateNote = async (request, reply) => {
    try {
      const parseResult = promptLlmGenerateNoteRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }

      request.body = parseResult.data;
      return generateNoteHandler(request, reply);
    } catch (error) {
      console.error('[registerPromptLlmJobsRoutes POST] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  };

  // POST /api/jobs/prompt-llm/generate-note (prefix /api/jobs in server.js)
  fastify.post('/prompt-llm/generate-note', {
    onRequest: [fastify.authenticate],
  }, postGenerateNote);

  const postGenerateAndSaveNote = async (request, reply) => {
    try {
      const parseResult = promptLlmGenerateAndSaveNoteRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }

      request.body = parseResult.data;
      return generateAndSaveNoteHandler(request, reply);
    } catch (error) {
      console.error('[registerPromptLlmJobsRoutes POST generate-and-save-note] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  };

  // POST /api/jobs/prompt-llm/generate-and-save-note
  fastify.post('/prompt-llm/generate-and-save-note', {
    onRequest: [fastify.authenticate],
  }, postGenerateAndSaveNote);

  // GET /api/jobs/prompt-llm/:jobId/encounter-bundle — register before :jobId-only route
  fastify.get('/prompt-llm/:jobId/encounter-bundle', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      return getPromptLlmJobEncounterBundleHandler(request, reply);
    } catch (error) {
      console.error('[registerPromptLlmJobsRoutes GET encounter-bundle] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/jobs/prompt-llm/:jobId (prefix /api applied in server.js)
  fastify.get('/prompt-llm/:jobId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      // Validate query parameters
      const queryParseResult = getPromptLlmJobStatusQuerySchema.safeParse(request.query);
      if (!queryParseResult.success) {
        console.warn('[registerPromptLlmJobsRoutes GET] Query validation issue:', queryParseResult.error);
        // Don't fail on query validation, just proceed with defaults
      }

      return getPromptLlmJobStatusHandler(request, reply);
    } catch (error) {
      console.error('[registerPromptLlmJobsRoutes GET] Error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
