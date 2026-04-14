/**
 * Internal cleanup routes (no fastify.authenticate — uses INTERNAL_CLEANUP_SECRET).
 */
import { postInternalCleanupRun } from '../controllers/internalCleanupController.js';

export async function registerInternalCleanupRoutes(fastify) {
  fastify.post('/internal/cleanup/run', async (request, reply) => {
    try {
      return postInternalCleanupRun(request, reply);
    } catch (error) {
      request.log.error('Error in internal cleanup route:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
