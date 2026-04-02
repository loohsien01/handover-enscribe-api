import fp from 'fastify-plugin';
import { serializeZodError } from '../../utils/serializeZodError.js';
import {
  userProfileCreateRequestSchema,
  userProfilePatchRequestSchema,
} from '../schemas/requests.js';
import {
  getUserProfile,
  createOrUpdateUserProfile,
  patchUserProfile,
} from '../controllers/userProfileController.js';

/**
 * User profile routes (public."userProfiles")
 * GET/POST/PATCH /user-profile
 */
export default fp(async function userProfileRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/user-profile', preAuth, async (request, reply) => {
    try {
      return getUserProfile(request, reply);
    } catch (err) {
      fastify.log.error('GET /user-profile:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/user-profile', preAuth, async (request, reply) => {
    try {
      const parseResult = userProfileCreateRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: serializeZodError(parseResult.error) });
      }
      request.body = parseResult.data;
      return createOrUpdateUserProfile(request, reply);
    } catch (err) {
      fastify.log.error('POST /user-profile:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.patch('/user-profile', preAuth, async (request, reply) => {
    try {
      const parseResult = userProfilePatchRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: serializeZodError(parseResult.error) });
      }
      request.body = parseResult.data;
      return patchUserProfile(request, reply);
    } catch (err) {
      fastify.log.error('PATCH /user-profile:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
