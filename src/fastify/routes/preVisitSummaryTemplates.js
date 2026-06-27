/**
 * Pre-Visit Summary Templates CRUD — encrypted default instruction blocks.
 */
import {
  createPreVisitSummaryTemplate,
  listPreVisitSummaryTemplates,
  getPreVisitSummaryTemplate,
  updatePreVisitSummaryTemplate,
  deletePreVisitSummaryTemplate,
} from '../controllers/preVisitSummaryTemplatesController.js';
import {
  preVisitSummaryTemplateCreateRequestSchema,
  preVisitSummaryTemplatePatchRequestSchema,
  preVisitSummaryTemplateListQuerySchema,
  preVisitSummaryTemplateIdParamsSchema,
} from '../schemas/preVisitSummaryTemplateRequests.js';

export async function registerPreVisitSummaryTemplatesRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/pre-visit-summary-templates', preAuth, async (request, reply) => {
    try {
      const parseResult = preVisitSummaryTemplateListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }
      request.query = parseResult.data;
      return listPreVisitSummaryTemplates(request, reply);
    } catch (error) {
      console.error('GET /pre-visit-summary-templates:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/pre-visit-summary-templates', preAuth, async (request, reply) => {
    try {
      const parseResult = preVisitSummaryTemplateCreateRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error });
      }
      request.body = parseResult.data;
      return createPreVisitSummaryTemplate(request, reply);
    } catch (error) {
      console.error('POST /pre-visit-summary-templates:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/pre-visit-summary-templates/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = preVisitSummaryTemplateIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;
      return getPreVisitSummaryTemplate(request, reply);
    } catch (error) {
      console.error('GET /pre-visit-summary-templates/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.patch('/pre-visit-summary-templates/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = preVisitSummaryTemplateIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;

      const bodyResult = preVisitSummaryTemplatePatchRequestSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: bodyResult.error });
      }
      request.body = bodyResult.data;

      return updatePreVisitSummaryTemplate(request, reply);
    } catch (error) {
      console.error('PATCH /pre-visit-summary-templates/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.delete('/pre-visit-summary-templates/:id', preAuth, async (request, reply) => {
    try {
      const paramsResult = preVisitSummaryTemplateIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: paramsResult.error });
      }
      request.params = paramsResult.data;
      return deletePreVisitSummaryTemplate(request, reply);
    } catch (error) {
      console.error('DELETE /pre-visit-summary-templates/:id:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

export default registerPreVisitSummaryTemplatesRoutes;
