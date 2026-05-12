import fp from 'fastify-plugin';
import { serializeZodError } from '../../utils/serializeZodError.js';
import { billingCheckoutRequestSchema } from '../schemas/requests.js';
import {
  getBillingStatus,
  createCheckoutSession,
  createPortalSession,
  scheduleSubscriptionCancel,
} from '../controllers/billingController.js';

/**
 * Authenticated billing routes (Stripe Checkout + Customer Portal).
 * Prefix: /api (registered from server).
 */
export default fp(async function billingRoutes(fastify) {
  const preAuth = { preHandler: [fastify.authenticate] };

  fastify.get('/billing/status', preAuth, async (request, reply) => {
    try {
      return getBillingStatus(request, reply);
    } catch (err) {
      fastify.log.error('GET /billing/status:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/billing/checkout-session', preAuth, async (request, reply) => {
    try {
      const parseResult = billingCheckoutRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: serializeZodError(parseResult.error) });
      }
      request.body = parseResult.data;
      return createCheckoutSession(request, reply);
    } catch (err) {
      fastify.log.error('POST /billing/checkout-session:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/billing/portal-session', preAuth, async (request, reply) => {
    try {
      return createPortalSession(request, reply);
    } catch (err) {
      fastify.log.error('POST /billing/portal-session:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/billing/schedule-cancel', preAuth, async (request, reply) => {
    try {
      return scheduleSubscriptionCancel(request, reply);
    } catch (err) {
      fastify.log.error('POST /billing/schedule-cancel:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
