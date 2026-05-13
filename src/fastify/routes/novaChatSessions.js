import fp from 'fastify-plugin';
import { serializeZodError } from '../../utils/serializeZodError.js';
import {
  novaChatSessionIdParamsSchema,
  novaChatSessionPatchRequestSchema,
  novaChatSessionsListQuerySchema,
  novaChatTokenUsageRequestSchema,
  novaChatCompletionRequestSchema,
} from '../schemas/novaChatRequests.js';
import {
  createNovaChatSession,
  listNovaChatSessions,
  getNovaChatSession,
  patchNovaChatSession,
  postNovaChatTokenUsage,
  postNovaChatCompletion,
} from '../controllers/novaChatSessionsController.js';

/**
 * Nova AI — Redis hot cache + Supabase encrypted persistence (chat_sessions / chat_messages).
 *
 * - GET    /api/nova/chat-sessions (paginated metadata; query limit, offset, sortBy, order)
 * - POST   /api/nova/chat-sessions
 * - GET    /api/nova/chat-sessions/:chatId
 * - PATCH  /api/nova/chat-sessions/:chatId
 * - POST   /api/nova/chat-sessions/:chatId/token-usage
 * - POST   /api/nova/chat-sessions/:chatId/completions (Bedrock: haiku | sonnet | opus; 409 if concurrent)
 */
export default fp(async function novaChatSessionsRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/nova/chat-sessions', preAuth, async (request, reply) => {
    try {
      const queryResult = novaChatSessionsListQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: serializeZodError(queryResult.error) });
      }
      request.query = queryResult.data;
      return listNovaChatSessions(request, reply);
    } catch (err) {
      fastify.log.error('GET /nova/chat-sessions:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

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

  fastify.post('/nova/chat-sessions/:chatId/completions', preAuth, async (request, reply) => {
    try {
      const paramsResult = novaChatSessionIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: serializeZodError(paramsResult.error) });
      }
      request.params = paramsResult.data;

      const bodyResult = novaChatCompletionRequestSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: serializeZodError(bodyResult.error) });
      }
      request.body = bodyResult.data;

      return postNovaChatCompletion(request, reply);
    } catch (err) {
      fastify.log.error('POST /nova/chat-sessions/:chatId/completions:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/nova/chat-sessions/:chatId/token-usage', preAuth, async (request, reply) => {
    try {
      const paramsResult = novaChatSessionIdParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: serializeZodError(paramsResult.error) });
      }
      request.params = paramsResult.data;

      const bodyResult = novaChatTokenUsageRequestSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: serializeZodError(bodyResult.error) });
      }
      request.body = bodyResult.data;

      return postNovaChatTokenUsage(request, reply);
    } catch (err) {
      fastify.log.error('POST /nova/chat-sessions/:chatId/token-usage:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
