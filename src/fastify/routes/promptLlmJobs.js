/**
 * Prompt LLM Jobs Routes
 * 
 * Polling-based job architecture for SOAP note generation
 * - POST /prompt-llm - Create job, returns jobId immediately
 * - GET /prompt-llm/:jobId - Poll job status and results
 */

import { createPromptLlmJobHandler, getPromptLlmJobStatusHandler } from '../controllers/jobController.js';
import { createPromptLlmJobRequestSchema, getPromptLlmJobStatusQuerySchema } from '../schemas/requests.js';

/**
 * Register prompt LLM jobs routes (polling-based)
 * 
 * @param {Object} fastify - Fastify instance
 */
export async function registerPromptLlmJobsRoutes(fastify) {
  // POST /api/jobs/prompt-llm (prefix /api applied in server.js)
  fastify.post('/prompt-llm', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      // Validate request body using Zod schema
      const parseResult = createPromptLlmJobRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }

      request.body = parseResult.data;
      return createPromptLlmJobHandler(request, reply);
    } catch (error) {
      console.error('[registerPromptLlmJobsRoutes POST] Error:', error);
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
