import fp from 'fastify-plugin';
import { postStripeWebhook } from '../controllers/stripeWebhookController.js';

/**
 * Stripe webhook: raw JSON body required for signature verification.
 * Register this plugin in an encapsulated Fastify scope that sets
 * addContentTypeParser('application/json', { parseAs: 'buffer' }, ...).
 */
export default fp(async function stripeWebhookRoutes(fastify) {
  fastify.post('/stripe/webhook', async (request, reply) => {
    try {
      return postStripeWebhook(request, reply);
    } catch (err) {
      fastify.log.error('POST /stripe/webhook:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
});
