/**
 * AWS PHI Masking Routes
 * 
 * Defines Fastify routes for PHI masking operations.
 */

import { maskPhiHandler, unmaskPhiHandler } from '../controllers/maskPhiController.js';
import {
  MaskPhiRequestBodySchema,
  UnmaskPhiRequestBodySchema,
} from '../schemas/requests.js';
import {
  MaskPhiResponseBodySchema,
  UnmaskPhiResponseBodySchema,
  maskPhiRequestSchema,
  maskPhiResponseSchema,
  unmaskPhiRequestSchema,
  unmaskPhiResponseSchema,
} from '../schemas/responses.js';

/**
 * Register PHI masking routes
 * 
 * @param {Object} fastify - Fastify instance
 */
export async function registerMaskPhiRoutes(fastify) {
  // POST /aws/mask-phi
  fastify.post('/aws/mask-phi', {
    schema: {
      description: 'Mask PHI in medical transcripts using AWS Comprehend Medical',
      tags: ['AWS', 'PHI'],
      response: {
        200: maskPhiResponseSchema,
        400: {
          description: 'Invalid request body',
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
          },
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body schema
        const validation = MaskPhiRequestBodySchema.safeParse(request.body);
        if (!validation.success) {
          return reply.status(400).send({ error: validation.error });
        }

        // Set validated body on request for controller
        request.body = validation.data;

        return maskPhiHandler(request, reply);
      } catch (error) {
        console.error('Error in mask-phi route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // POST /aws/unmask-phi
  fastify.post('/aws/unmask-phi', {
    schema: {
      description: 'Unmask PHI tokens using entity data',
      tags: ['AWS', 'PHI'],
      response: {
        200: unmaskPhiResponseSchema,
        400: {
          description: 'Invalid request body',
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
          },
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Debug: log request body structure
        console.log('[unmask-phi route] Request body type:', typeof request.body);
        console.log('[unmask-phi route] Request body keys:', request.body ? Object.keys(request.body) : 'null/undefined');
        console.log('[unmask-phi route] Request body:', JSON.stringify(request.body).substring(0, 300));
        
        // Validate request body schema
        const validation = UnmaskPhiRequestBodySchema.safeParse(request.body);
        if (!validation.success) {
          return reply.status(400).send({ error: validation.error });
        }

        // Set validated body on request for controller
        request.body = validation.data;

        return unmaskPhiHandler(request, reply);
      } catch (error) {
        console.error('Error in unmask-phi route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });
}
