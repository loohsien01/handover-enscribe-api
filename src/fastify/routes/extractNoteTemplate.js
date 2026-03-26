/**
 * Extract Note Template Routes
 *
 * POST /api/extract-note-template
 *   Accepts a multipart file upload, sends the file to Claude Bedrock as a
 *   native document block, and returns an array of noteTemplateSection objects.
 *   This is a preview-only operation — nothing is persisted to the database.
 */

import { extractNoteTemplateSections } from '../controllers/extractNoteTemplateController.js';

export async function registerExtractNoteTemplateRoutes(fastify) {
  fastify.post('/extract-note-template', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        return extractNoteTemplateSections(request, reply);
      } catch (error) {
        console.error('Error in POST /extract-note-template:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });
}

export default registerExtractNoteTemplateRoutes;
