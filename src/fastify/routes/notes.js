/**
 * Notes Routes
 * Registers all note endpoints with authentication
 * Validation is handled in routes using Zod schemas
 */
import {
  getAllNotes,
  getAllNotesComplete,
  getNote,
  createNote,
  updateNote,
  deleteNote,
} from '../controllers/notesController.js';
import {
  noteCreateRequestSchema,
  noteUpdateRequestSchema,
  notesListQuerySchema,
  notesCompleteListQuerySchema,
} from '../schemas/requests.js';

export async function registerNotesRoutes(fastify) {
  // GET /api/notes/complete - Full notes with decryption (register before /notes/:id)
  fastify.get('/notes/complete', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const parseResult = notesCompleteListQuerySchema.safeParse(request.query);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }
        request.query = parseResult.data;
        return getAllNotesComplete(request, reply);
      } catch (error) {
        console.error('Error in GET /notes/complete route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // GET /api/notes - Lightweight list (id, patientEncounter_id, updated_at)
  fastify.get('/notes', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const parseResult = notesListQuerySchema.safeParse(request.query);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }
        request.query = parseResult.data;
        return getAllNotes(request, reply);
      } catch (error) {
        console.error('Error in GET /notes route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // GET /api/notes/:id - Get single note by ID
  fastify.get('/notes/:id', {
    preHandler: [fastify.authenticate],
    handler: getNote,
  });

  // POST /api/notes - Create new note
  fastify.post('/notes', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return createNote(request, reply);
      } catch (error) {
        console.error('Error in notes create route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH /api/notes/:id - Update note
  fastify.patch('/notes/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = noteUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return updateNote(request, reply);
      } catch (error) {
        console.error('Error in notes update route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // DELETE /api/notes/:id - Delete note
  fastify.delete('/notes/:id', {
    preHandler: [fastify.authenticate],
    handler: deleteNote,
  });
}

export default registerNotesRoutes;
