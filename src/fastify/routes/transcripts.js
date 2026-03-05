/**
 * Transcripts Routes
 * Defines all transcript API endpoints
 * Validation is handled in routes using Zod schemas
 */
import {
  getAllTranscripts,
  getTranscript,
  createTranscript,
  updateTranscript,
  deleteTranscript,
  expandHandler,
} from '../controllers/transcriptsController.js';
import { transcriptCreateRequestSchema, transcriptUpdateRequestSchema, transcriptExpandRequestSchema } from '../schemas/requests.js';

export async function registerTranscriptsRoutes(fastify) {
  // GET all transcripts
  fastify.get('/transcripts', {
    preHandler: [fastify.authenticate],
    handler: getAllTranscripts,
  });

  // GET single transcript by ID
  fastify.get('/transcripts/:id', {
    preHandler: [fastify.authenticate],
    handler: getTranscript,
  });

  // POST create transcript
  fastify.post('/transcripts', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = transcriptCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return createTranscript(request, reply);
      } catch (error) {
        console.error('Error in transcripts create route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH update transcript
  fastify.patch('/transcripts/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = transcriptUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return updateTranscript(request, reply);
      } catch (error) {
        console.error('Error in transcripts update route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // DELETE transcript
  fastify.delete('/transcripts/:id', {
    preHandler: [fastify.authenticate],
    handler: deleteTranscript,
  });

  // POST /transcripts/expand
  // Unit test endpoint for dot phrase expansion without transcription
  fastify.post('/transcripts/expand', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body schema
        const validation = transcriptExpandRequestSchema.safeParse(request.body);
        if (!validation.success) {
          return reply.status(400).send({ error: validation.error });
        }

        // Set validated body on request for controller
        request.body = validation.data;

        return expandHandler(request, reply);
      } catch (error) {
        console.error('Error in transcripts expand route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });
}
