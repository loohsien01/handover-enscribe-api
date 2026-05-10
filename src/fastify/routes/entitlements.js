import fp from 'fastify-plugin';
import { getMyEntitlements } from '../controllers/entitlementsController.js';

/**
 * Authenticated entitlements route.
 * Prefix: /api (registered from server).
 *
 * GET /me/entitlements -> { entitlements: { ... } }
 */
export default fp(async function entitlementsRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/me/entitlements', preAuth, async (request, reply) => {
    try {
      return getMyEntitlements(request, reply);
    } catch (err) {
      fastify.log.error('GET /me/entitlements:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
