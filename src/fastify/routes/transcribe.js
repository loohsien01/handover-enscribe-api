/**
 * Deepgram Transcription Routes
 * 
 * Defines Fastify routes for transcription pipeline operations
 */

import { handler } from '../controllers/transcribeController.js';
import {
  transcribeRequestSchema,
  transcribeResponseSchema,
} from '../schemas/responses.js';
import {
  TranscribeRequestBodySchema,
} from '../schemas/requests.js';

/**
 * Register transcription routes
 * 
 * @param {Object} fastify - Fastify instance
 */
export async function registerTranscribeRoutes(fastify) {
  // POST /deepgram/transcribe/complete (prefix /api applied in server.js)
  fastify.post('/deepgram/transcribe/complete', {
    onRequest: [fastify.authenticate],
    schema: {
      description: 'Complete transcription pipeline: transcribe audio, expand dot phrases, mask PHI',
      tags: ['Deepgram', 'Transcription'],
      response: {
        200: {
          description: 'Successful transcription, expansion, and masking',
          type: 'object',
          required: ['ok', 'cloudRunData', 'maskResult'],
          additionalProperties: true,
          properties: {
            ok: {
              type: 'boolean',
              enum: [true],
            },
            cloudRunData: {
              type: 'object',
              additionalProperties: true,
            },
            maskResult: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        400: {
          description: 'Bad request (invalid URL, missing parameters, etc.)',
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            cloudRunData: { type: 'object' },
            details: { type: 'object' },
          },
        },
        401: {
          description: 'Unauthorized (authentication failed)',
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
        408: {
          description: 'Request timeout (Deepgram transcription took too long)',
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            cloudRunData: { type: 'object' },
            details: { type: 'object' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        // Validate request body schema
        const validation = TranscribeRequestBodySchema.safeParse(request.body);
        if (!validation.success) {
          return reply.status(400).send({ error: validation.error });
        }

        // Set validated body on request for controller
        request.body = validation.data;

        return handler(request, reply);
      } catch (error) {
        console.error('Error in transcribe complete route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });
}

export default registerTranscribeRoutes;
