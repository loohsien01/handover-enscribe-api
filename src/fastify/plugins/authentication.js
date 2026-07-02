import fp from 'fastify-plugin';
import { authenticateAccessToken } from '../../utils/authenticateAccessToken.js';

/**
 * Fastify plugin for authentication
 * Verifies JWT token from Authorization header and attaches user to request object
 *
 * Usage: fastify.register(authenticationPlugin)
 * Then add { onRequest: [fastify.authenticate] } to any route that needs auth
 */
export default fp(async function (fastify, options) {
  /**
   * Authenticate hook - verifies JWT token and sets request.user
   * Can be used as preHandler in route definitions:
   *
   * fastify.get('/protected', { preHandler: [fastify.authenticate] }, handler)
   */
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      const authHeader = request.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');

      if (!token) {
        return reply.status(401).send({ error: 'JWT Token is required' });
      }

      const { user, error } = await authenticateAccessToken(token);

      if (error || !user) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }

      request.user = user;
    } catch (err) {
      fastify.log.error('Authentication error:', err);
      return reply.status(401).send({ error: 'Authentication failed' });
    }
  });
});
