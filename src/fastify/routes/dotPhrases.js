import fp from 'fastify-plugin';
import { getSupabaseClient } from '../../utils/supabase.js';
import { dotPhraseCreateRequestSchema, dotPhraseUpdateRequestSchema } from '../schemas/requests.js';
import {
  getOneDotPhrase,
  getAllDotPhrasesForUser,
  createDotPhrase,
  updateDotPhrase,
  deleteDotPhrase,
} from '../controllers/dotPhrasesController.js';

/**
 * Fastify plugin for dot phrases routes
 * Handles CRUD operations for user's dot phrases
 */
export default fp(async function dotPhrasesRoutes(fastify, options) {
  /**
   * GET /dot-phrases/:id
   * Get a single dot phrase by ID (requires authentication)
   */
  fastify.get(
    '/dot-phrases/:id',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const supabase = getSupabaseClient(request.headers.authorization);

        const result = await getOneDotPhrase(request.user.id, id, supabase);

        if (!result.success) {
          return reply.status(404).send({ error: result.error });
        }

        return reply.status(200).send(result.data);
      } catch (err) {
        fastify.log.error('Error in GET /dot-phrases/:id:', err);
        return reply.status(500).send({ error: 'Failed to fetch dot phrase' });
      }
    }
  );

  console.log('dotPhrases plugin: registering GET /dot-phrases (all)');
  fastify.get(
    '/dot-phrases',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        console.log('dotPhrases: GET /dot-phrases called');
        const supabase = getSupabaseClient(request.headers.authorization);

        const result = await getAllDotPhrasesForUser(request.user.id, supabase);

        if (!result.success) {
          return reply.status(500).send({ error: result.error });
        }

        return reply.status(200).send(result.data);
      } catch (err) {
        fastify.log.error('Error in GET /dot-phrases:', err);
        return reply.status(500).send({ error: 'Failed to fetch dot phrases' });
      }
    }
  );

  /**
   * POST /dot-phrases
   * Create a new dot phrase (requires authentication)
   */
  fastify.post(
    '/dot-phrases',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        // Validate request body
        const parseResult = dotPhraseCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        const { trigger, expansion } = request.body;
        const supabase = getSupabaseClient(request.headers.authorization);

        const result = await createDotPhrase(request.user.id, trigger, expansion, supabase);

        if (!result.success) {
          return reply.status(400).send({ error: result.error });
        }

        return reply.status(201).send(result.data);
      } catch (err) {
        fastify.log.error('Error in POST /dot-phrases:', err);
        return reply.status(500).send({ error: 'Failed to create dot phrase' });
      }
    }
  );

  /**
   * PATCH /dot-phrases/:id
   * Update an existing dot phrase (requires authentication)
   */
  fastify.patch(
    '/dot-phrases/:id',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        // Validate request body
        const parseResult = dotPhraseUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        const { id } = request.params;
        const supabase = getSupabaseClient(request.headers.authorization);

        const result = await updateDotPhrase(request.user.id, id, request.body, supabase);

        if (!result.success) {
          return reply.status(400).send({ error: result.error });
        }

        return reply.status(200).send(result.data);
      } catch (err) {
        fastify.log.error('Error in PATCH /dot-phrases/:id:', err);
        return reply.status(500).send({ error: 'Failed to update dot phrase' });
      }
    }
  );

  /**
   * DELETE /dot-phrases/:id
   * Delete a dot phrase (requires authentication)
   */
  fastify.delete(
    '/dot-phrases/:id',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const supabase = getSupabaseClient(request.headers.authorization);

        const result = await deleteDotPhrase(request.user.id, id, supabase);

        if (!result.success) {
          return reply.status(404).send({ error: result.error });
        }

        return reply.status(200).send({ success: true, data: result.data });
      } catch (err) {
        fastify.log.error('Error in DELETE /dot-phrases/:id:', err);
        return reply.status(500).send({ error: 'Failed to delete dot phrase' });
      }
    }
  );
}, { name: 'dotPhrasesRoutes' });
