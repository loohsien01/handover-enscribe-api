/**
 * Internal archive-purge routes (no fastify.authenticate — uses INTERNAL_CLEANUP_SECRET).
 */
import {
  postArchivePurgeRun,
  getArchivePurgeJobRun,
} from '../controllers/archivePurgeController.js';

export async function registerArchivePurgeRoutes(fastify) {
  fastify.get('/internal/archive-purge/jobs/:jobRunId', async (request, reply) => {
    try {
      return getArchivePurgeJobRun(request, reply);
    } catch (error) {
      request.log.error('Error in archive-purge job poll route:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/internal/archive-purge/run', async (request, reply) => {
    try {
      return postArchivePurgeRun(request, reply);
    } catch (error) {
      request.log.error('Error in internal archive-purge route:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
