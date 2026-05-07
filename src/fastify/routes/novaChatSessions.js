import fp from 'fastify-plugin';
import { serializeZodError } from '../../utils/serializeZodError.js';
import {
  novaChatSessionIdParamsSchema,
  novaChatSessionPatchRequestSchema,
} from '../schemas/novaChatRequests.js';
import {
  createNovaChatSession,
  getNovaChatSession,
  patchNovaChatSession,
} from '../controllers/novaChatSessionsController.js';

/**
 * Nova AI — Redis-backed chat session (hot cache). Supabase persistence comes later.
 *
 * - POST   /api/nova/chat-sessions
 * - GET    /api/nova/chat-sessions/:chatId
 * - PATCH  /api/nova/chat-sessions/:chatId
 */
export default fp(async function novaChatSessionsRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.post('/nova/chat-sessions', preAuth, async (request, reply) => {
    try {
      return createNovaChatSession(request, reply);
    } catch (err) {
      fastify.log.error('POST /nova/chat-sessions:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/nova/chat-sessions/:chatId', preAuth, async (request, reply) => {
    try {
      const paramsResult = novaChatSessionIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: serializeZodError(paramsResult.error) });
      }
      request.params = paramsResult.data;
      return getNovaChatSession(request, reply);
    } catch (err) {
      fastify.log.error('GET /nova/chat-sessions/:chatId:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.patch('/nova/chat-sessions/:chatId', preAuth, async (request, reply) => {
    try {
      const paramsResult = novaChatSessionIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: serializeZodError(paramsResult.error) });
      }
      request.params = paramsResult.data;

      const bodyResult = novaChatSessionPatchRequestSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: serializeZodError(bodyResult.error) });
      }
      request.body = bodyResult.data;

      return patchNovaChatSession(request, reply);
    } catch (err) {
      fastify.log.error('PATCH /nova/chat-sessions/:chatId:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
