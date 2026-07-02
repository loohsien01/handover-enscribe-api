import { getStripe } from '../../utils/stripeClient.js';
import { syncOrganizationFromSubscription } from '../../utils/billingStripeSync.js';
import { pgQueryOne } from '../../utils/pgQueryHelpers.js';
import { querySupabasePostgres } from '../../utils/supabasePostgresPool.js';

/**
 * @param {import('stripe').Stripe.Checkout.Session} session
 */
async function onCheckoutSessionCompleted(session) {
  const orgId = session.metadata?.organization_id;
  if (!orgId) return;

  const customerId = session.customer;
  const subId = session.subscription;

  const sets = [];
  const params = [orgId];
  let idx = 2;

  if (typeof customerId === 'string') {
    sets.push(`stripe_customer_id = $${idx++}`);
    params.push(customerId);
  }
  if (typeof subId === 'string') {
    sets.push(`stripe_subscription_id = $${idx++}`);
    params.push(subId);
  }

  if (sets.length === 0) return;

  await querySupabasePostgres(
    `UPDATE public.organizations SET ${sets.join(', ')} WHERE id = $1`,
    params
  );
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {import('stripe').Stripe.Invoice} invoice
 */
async function onInvoiceSubscriptionSync(stripe, invoice) {
  const subId =
    typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (!subId) return;

  const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
  await syncOrganizationFromSubscription(sub, sub.metadata?.organization_id);
}

/**
 * POST /api/stripe/webhook — request.body must be raw Buffer (see route plugin).
 */
export async function postStripeWebhook(request, reply) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !secret) {
    return reply.status(503).send({ error: 'Webhook not configured' });
  }

  const sig = request.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    return reply.status(400).send({ error: 'Missing stripe-signature' });
  }

  const buf = request.body;
  if (!Buffer.isBuffer(buf)) {
    return reply.status(400).send({ error: 'Invalid body' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, secret);
  } catch (err) {
    request.log.warn({ err: String(err) }, 'Stripe webhook signature verification failed');
    return reply.status(400).send({ error: 'Invalid signature' });
  }

  const existing = await pgQueryOne(
    `SELECT id FROM public.stripe_webhook_events WHERE id = $1 LIMIT 1`,
    [event.id]
  );

  if (existing) {
    return reply.send({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutSessionCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncOrganizationFromSubscription(
          event.data.object,
          event.data.object.metadata?.organization_id
        );
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        await onInvoiceSubscriptionSync(stripe, event.data.object);
        break;
      default:
        break;
    }
  } catch (err) {
    request.log.error(err, 'Stripe webhook handler error');
    return reply.status(500).send({ error: 'handler_failed' });
  }

  try {
    await querySupabasePostgres(
      `INSERT INTO public.stripe_webhook_events (id, type) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type]
    );
  } catch (insErr) {
    if (insErr?.code !== '23505') {
      request.log.error(insErr, 'Stripe webhook idempotency insert failed');
    }
  }

  return reply.send({ received: true });
}
