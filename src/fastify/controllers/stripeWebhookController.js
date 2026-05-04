import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import { getStripe } from '../../utils/stripeClient.js';
import { syncOrganizationFromSubscription } from '../../utils/billingStripeSync.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {import('stripe').Stripe.Checkout.Session} session
 */
async function onCheckoutSessionCompleted(admin, session) {
  const orgId = session.metadata?.organization_id;
  if (!orgId) return;

  const customerId = session.customer;
  const subId = session.subscription;

  const patch = {};
  if (typeof customerId === 'string') patch.stripe_customer_id = customerId;
  if (typeof subId === 'string') patch.stripe_subscription_id = subId;

  if (Object.keys(patch).length === 0) return;

  const { error } = await admin.from('organizations').update(patch).eq('id', orgId);
  if (error) throw error;
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {import('stripe').Stripe.Invoice} invoice
 */
async function onInvoiceSubscriptionSync(stripe, admin, invoice) {
  const subId =
    typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (!subId) return;

  const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
  await syncOrganizationFromSubscription(admin, sub, sub.metadata?.organization_id);
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

  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from('stripe_webhook_events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle();

  if (existing) {
    return reply.send({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutSessionCompleted(admin, event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncOrganizationFromSubscription(
          admin,
          event.data.object,
          event.data.object.metadata?.organization_id
        );
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        await onInvoiceSubscriptionSync(stripe, admin, event.data.object);
        break;
      default:
        break;
    }
  } catch (err) {
    request.log.error(err, 'Stripe webhook handler error');
    return reply.status(500).send({ error: 'handler_failed' });
  }

  const { error: insErr } = await admin
    .from('stripe_webhook_events')
    .insert({ id: event.id, type: event.type });

  if (insErr && insErr.code !== '23505') {
    request.log.error(insErr, 'Stripe webhook idempotency insert failed');
  }

  return reply.send({ received: true });
}
