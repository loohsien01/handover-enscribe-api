import { randomUUID } from 'crypto';
import { getRedisClient } from '../../utils/redisClient.js';
import {
  createEmptyNovaSession,
  novaSessionGet,
  novaSessionSave,
  novaSessionTtlSeconds,
} from '../../utils/novaRedisSession.js';

async function redisOr503(reply) {
  const redis = await getRedisClient();
  if (!redis) {
    reply.status(503).send({
      error: 'Redis is not configured',
      code: 'REDIS_UNAVAILABLE',
      detail: 'Set REDIS_URL in the environment to use Nova chat sessions.',
    });
    return null;
  }
  return redis;
}

/**
 * POST /api/nova/chat-sessions
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function createNovaChatSession(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const chatId = randomUUID();
  const session = createEmptyNovaSession(chatId);
  const ttl = novaSessionTtlSeconds();

  await novaSessionSave(redis, userId, session, ttl);

  return reply.status(201).send({ chatId, session });
}

/**
 * GET /api/nova/chat-sessions/:chatId
 */
export async function getNovaChatSession(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId } = request.params;

  const session = await novaSessionGet(redis, userId, chatId);
  if (!session) {
    return reply.status(404).send({ error: 'Chat session not found or expired', code: 'NOVA_SESSION_NOT_FOUND' });
  }

  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, session, ttl);

  return reply.send({ session });
}

/**
 * PATCH /api/nova/chat-sessions/:chatId
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function patchNovaChatSession(request, reply) {
  const redis = await redisOr503(reply);
  if (!redis) return;

  const userId = request.user.id;
  const { chatId } = request.params;
  const body = request.body;

  const session = await novaSessionGet(redis, userId, chatId);
  if (!session) {
    return reply.status(404).send({ error: 'Chat session not found or expired', code: 'NOVA_SESSION_NOT_FOUND' });
  }

  if (body.summary !== undefined) session.summary = body.summary;
  if (body.token_estimate !== undefined) session.token_estimate = body.token_estimate;
  if (body.messages !== undefined) session.messages = body.messages;
  if (body.appendMessages?.length) {
    session.messages = [...session.messages, ...body.appendMessages];
  }

  const ttl = novaSessionTtlSeconds();
  await novaSessionSave(redis, userId, session, ttl);

  return reply.send({ session });
}
