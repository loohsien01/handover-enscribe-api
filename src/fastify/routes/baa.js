import fp from 'fastify-plugin';
import { serializeZodError } from '../../utils/serializeZodError.js';
import { baaAcceptRequestSchema } from '../schemas/requests.js';
import {
  acceptMyBaa,
  getActiveBaa,
  getMyBaaStatus,
} from '../controllers/baaController.js';

/**
 * BAA routes — active document, org status, acceptance.
 * Prefix: /api (registered from server).
 */
export default fp(async function baaRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/baa/active', preAuth, async (request, reply) => {
    try {
      return getActiveBaa(request, reply);
    } catch (err) {
      fastify.log.error('GET /baa/active:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/me/baa/status', preAuth, async (request, reply) => {
    try {
      return getMyBaaStatus(request, reply);
    } catch (err) {
      fastify.log.error('GET /me/baa/status:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/me/baa/accept', preAuth, async (request, reply) => {
    try {
      const parseResult = baaAcceptRequestSchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: serializeZodError(parseResult.error) });
      }
      request.body = parseResult.data;
      return acceptMyBaa(request, reply);
    } catch (err) {
      fastify.log.error('POST /me/baa/accept:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
