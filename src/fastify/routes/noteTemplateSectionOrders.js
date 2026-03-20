/**
 * Note Template Section Orders Routes. Filename: noteTemplateSectionOrders.js 
 * Registers all note template section order endpoints with authentication
 * Validation is handled in routes using Zod schemas
 */
import {
  getAllNoteTemplateSectionOrders,
  getNoteTemplateSectionOrder,
  createNoteTemplateSectionOrder,
  updateNoteTemplateSectionOrders,
} from '../controllers/noteTemplateSectionOrdersController.js';
import {
  noteTemplateSectionOrdersCreateRequestSchema,
  noteTemplateSectionOrdersPatchRequestSchema,
} from '../schemas/requests.js';
import { serializeZodError } from '../../utils/serializeZodError.js';

export async function registerNoteTemplateSectionOrdersRoutes(fastify) {
  // GET /api/note-template-section-orders - Get all section orders (for all templates user has access to)
  fastify.get('/note-template-section-orders', {
    preHandler: [fastify.authenticate],
    handler: getAllNoteTemplateSectionOrders,
  });

  // GET /api/note-template-section-orders/:id - Get single section order by ID
  fastify.get('/note-template-section-orders/:id', {
    preHandler: [fastify.authenticate],
    handler: getNoteTemplateSectionOrder,
  });

  // POST /api/note-template-section-orders - Create new section order (single record)
  fastify.post('/note-template-section-orders', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteTemplateSectionOrdersCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: serializeZodError(parseResult.error) });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return createNoteTemplateSectionOrder(request, reply);
      } catch (error) {
        console.error('Error in POST /note-template-section-orders:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH /api/note-template-section-orders - Batch reorder (atomic)
  fastify.patch('/note-template-section-orders', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteTemplateSectionOrdersPatchRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: serializeZodError(parseResult.error) });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return updateNoteTemplateSectionOrders(request, reply);
      } catch (error) {
        console.error('Error in PATCH /note-template-section-orders:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });
}

export default registerNoteTemplateSectionOrdersRoutes;
