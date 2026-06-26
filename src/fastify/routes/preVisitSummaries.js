/**
 * Visit preps CRUD — encrypted visit preparation documents.
 */
import {
  createVisitPrepHandler,
  listVisitPreps,
  getVisitPrep,
  updateVisitPrep,
  deleteVisitPrep,
} from '../controllers/visitPrepsController.js';
import {
  visitPrepCreateRequestSchema,
  visitPrepPatchRequestSchema,
  visitPrepListQuerySchema,
  visitPrepIdParamsSchema,
} from '../schemas/visitPrepRequests.js';

export async function registerVisitPrepsRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/visit-preps', preAuth, async (request, reply) => {
    try {
      const parseResult = visitPrepListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }
      request.query = parseResult.data;
      return listVisitPreps(request, reply);
    } catch (error) {
      console.error('GET /visit-preps:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/visit-preps', preAuth, async (request, reply) => {
    try {
      const parseResult = visitPrepCreateRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }
      request.body = parseResult.data;
      return createVisitPrepHandler(request, reply);
    } catch (error) {
      console.error('POST /visit-preps:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/visit-preps/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = visitPrepIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;
      return getVisitPrep(request, reply);
    } catch (error) {
      console.error('GET /visit-preps/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.patch('/visit-preps/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = visitPrepIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;

      const bodyResult = visitPrepPatchRequestSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: bodyResult.error });
      }
      request.body = bodyResult.data;

      return updateVisitPrep(request, reply);
    } catch (error) {
      console.error('PATCH /visit-preps/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.delete('/visit-preps/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = visitPrepIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;
      return deleteVisitPrep(request, reply);
    } catch (error) {
      console.error('DELETE /visit-preps/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

export default registerVisitPrepsRoutes;
