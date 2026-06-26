/**
 * Pre-Visit Summaries CRUD — encrypted pre-visit summary documents.
 */
import {
  createPreVisitSummaryHandler,
  listPreVisitSummaries,
  getPreVisitSummary,
  updatePreVisitSummary,
  deletePreVisitSummary,
} from '../controllers/preVisitSummariesController.js';
import {
  preVisitSummaryCreateRequestSchema,
  preVisitSummaryPatchRequestSchema,
  preVisitSummaryListQuerySchema,
  preVisitSummaryIdParamsSchema,
} from '../schemas/preVisitSummaryRequests.js';

export async function registerPreVisitSummariesRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/pre-visit-summaries', preAuth, async (request, reply) => {
    try {
      const parseResult = preVisitSummaryListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }
      request.query = parseResult.data;
      return listPreVisitSummaries(request, reply);
    } catch (error) {
      console.error('GET /pre-visit-summaries:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/pre-visit-summaries', preAuth, async (request, reply) => {
    try {
      const parseResult = preVisitSummaryCreateRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }
      request.body = parseResult.data;
      return createPreVisitSummaryHandler(request, reply);
    } catch (error) {
      console.error('POST /pre-visit-summaries:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/pre-visit-summaries/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = preVisitSummaryIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;
      return getPreVisitSummary(request, reply);
    } catch (error) {
      console.error('GET /pre-visit-summaries/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.patch('/pre-visit-summaries/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = preVisitSummaryIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;

      const bodyResult = preVisitSummaryPatchRequestSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: bodyResult.error });
      }
      request.body = bodyResult.data;

      return updatePreVisitSummary(request, reply);
    } catch (error) {
      console.error('PATCH /pre-visit-summaries/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.delete('/pre-visit-summaries/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = preVisitSummaryIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;
      return deletePreVisitSummary(request, reply);
    } catch (error) {
      console.error('DELETE /pre-visit-summaries/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

export default registerPreVisitSummariesRoutes;
