/**
 * Note Template Sections Routes
 * Registers all note template section endpoints with authentication
 * Validation is handled in routes using Zod schemas
 */
import {
  getAllNoteTemplateSections,
  getNoteTemplateSection,
  createNoteTemplateSection,
  updateNoteTemplateSection,
  deleteNoteTemplateSection,
} from '../controllers/noteTemplateSectionsController.js';
import {
  noteTemplateSectionCreateRequestSchema,
  noteTemplateSectionUpdateRequestSchema,
} from '../schemas/requests.js';

export async function registerNoteTemplateSectionsRoutes(fastify) {
  // GET /api/note-template-sections - Get all sections
  fastify.get('/note-template-sections', {
    preHandler: [fastify.authenticate],
    handler: getAllNoteTemplateSections,
  });

  // GET /api/note-template-sections/:id - Get single section by ID
  fastify.get('/note-template-sections/:id', {
    preHandler: [fastify.authenticate],
    handler: getNoteTemplateSection,
  });

  // POST /api/note-template-sections - Create new section
  fastify.post('/note-template-sections', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteTemplateSectionCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return createNoteTemplateSection(request, reply);
      } catch (error) {
        console.error('Error in POST /note-template-sections:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH /api/note-template-sections/:id - Update section
  fastify.patch('/note-template-sections/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteTemplateSectionUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return updateNoteTemplateSection(request, reply);
      } catch (error) {
        console.error('Error in PATCH /note-template-sections/:id:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // DELETE /api/note-template-sections/:id - Delete section
  fastify.delete('/note-template-sections/:id', {
    preHandler: [fastify.authenticate],
    handler: deleteNoteTemplateSection,
  });
}

export default registerNoteTemplateSectionsRoutes;
