import fp from 'fastify-plugin';
import { getBillingStatus } from '../controllers/billingController.js';

/**
 * Authenticated billing read routes.
 * Prefix: /api (registered from server).
 */
export default fp(async function billingRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/billing/status', preAuth, async (request, reply) => {
    try {
      return getBillingStatus(request, reply);
    } catch (err) {
      fastify.log.error('GET /billing/status:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
