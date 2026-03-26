/**
 * Note Templates Routes
 * Registers all note template endpoints with authentication
 * Validation is handled in routes using Zod schemas
 */
import {
  getAllNoteTemplates,
  getNoteTemplate,
  createNoteTemplate,
  updateNoteTemplate,
  deleteNoteTemplate,
  extractNoteTemplateSections,
} from '../controllers/noteTemplatesController.js';
import {
  noteTemplateCreateRequestSchema,
  noteTemplateUpdateRequestSchema,
} from '../schemas/requests.js';

export async function registerNoteTemplatesRoutes(fastify) {
  // POST /api/note-templates/llm-extract — LLM PDF → section preview (no DB write; register before :id)
  fastify.post('/note-templates/llm-extract', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        return extractNoteTemplateSections(request, reply);
      } catch (error) {
        console.error('Error in POST /note-templates/llm-extract:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // GET /api/note-templates - Get all templates
  fastify.get('/note-templates', {
    preHandler: [fastify.authenticate],
    handler: getAllNoteTemplates,
  });

  // GET /api/note-templates/:id - Get single template by ID
  fastify.get('/note-templates/:id', {
    preHandler: [fastify.authenticate],
    handler: getNoteTemplate,
  });

  // POST /api/note-templates - Create new template
  fastify.post('/note-templates', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteTemplateCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return createNoteTemplate(request, reply);
      } catch (error) {
        console.error('Error in POST /note-templates:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH /api/note-templates/:id - Update template
  fastify.patch('/note-templates/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteTemplateUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return updateNoteTemplate(request, reply);
      } catch (error) {
        console.error('Error in PATCH /note-templates/:id:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // DELETE /api/note-templates/:id - Delete template
  fastify.delete('/note-templates/:id', {
    preHandler: [fastify.authenticate],
    handler: deleteNoteTemplate,
  });
}

export default registerNoteTemplatesRoutes;
