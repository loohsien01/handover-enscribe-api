/**
 * Internal cleanup routes (no fastify.authenticate — uses INTERNAL_CLEANUP_SECRET).
 */
import { postCleanupRun, getCleanupJobRun } from '../controllers/cleanupController.js';

export async function registerCleanupRoutes(fastify) {
  fastify.get('/internal/cleanup/jobs/:jobRunId', async (request, reply) => {
    try {
      return getCleanupJobRun(request, reply);
    } catch (error) {
      request.log.error('Error in cleanup job poll route:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/internal/cleanup/run', async (request, reply) => {
    try {
      return postCleanupRun(request, reply);
    } catch (error) {
      request.log.error('Error in internal cleanup route:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
