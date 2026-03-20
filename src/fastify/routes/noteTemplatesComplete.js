/**
 * Note Templates Complete Routes
 * Registers complete template endpoints with sections + ordering
 * Atomic operations for creating/updating templates with their sections
 * /api/note-templates/complete - batch
 * /api/note-templates/complete/:id - single, create, update
 */
import {
  getAllNoteTemplatesComplete,
  getNoteTemplateComplete,
  createNoteTemplateComplete,
  updateNoteTemplateComplete,
} from '../controllers/noteTemplatesCompleteController.js';
import {
  noteTemplatesCompleteCreateRequestSchema,
  noteTemplatesCompleteUpdateRequestSchema,
} from '../schemas/requests.js';
import { serializeZodError } from '../../utils/serializeZodError.js';

export async function registerNoteTemplatesCompleteRoutes(fastify) {
  // GET /api/note-templates/complete - Batch with pagination
  fastify.get('/note-templates/complete', {
    preHandler: [fastify.authenticate],
    handler: getAllNoteTemplatesComplete,
  });

  // GET /api/note-templates/complete/:id - Single with sections
  fastify.get('/note-templates/complete/:id', {
    preHandler: [fastify.authenticate],
    handler: getNoteTemplateComplete,
  });

  // POST /api/note-templates/complete - Create with sections (atomic)
  fastify.post('/note-templates/complete', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const parseResult = noteTemplatesCompleteCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: 'Validation error',
            details: serializeZodError(parseResult.error),
          });
        }

        request.body = parseResult.data;
        return createNoteTemplateComplete(request, reply);
      } catch (error) {
        console.error('Error in POST /note-templates/complete:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH /api/note-templates/complete/:id - Update template + sections + ordering (atomic)
  fastify.patch('/note-templates/complete/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const parseResult = noteTemplatesCompleteUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            error: 'Validation error',
            details: serializeZodError(parseResult.error),
          });
        }

        request.body = parseResult.data;
        return updateNoteTemplateComplete(request, reply);
      } catch (error) {
        console.error('Error in PATCH /note-templates/complete/:id:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });
}

export default registerNoteTemplatesCompleteRoutes;
