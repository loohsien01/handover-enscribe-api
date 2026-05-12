import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import { getStripe } from '../../utils/stripeClient.js';
import { ensurePersonalOrganization } from '../../services/personalOrganization.js';
import {
  computeEntitlements,
  loadInternalAccess,
} from '../../utils/billingEntitlements.js';

const PRO_PRICE_ENV = 'STRIPE_PRICE_PRO_MONTHLY';

function getFrontendBase() {
  const base = process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
  return String(base).replace(/\/$/, '');
}

async function getPersonalOrgAndMembership(admin, userId) {
  const { data: org, error: orgErr } = await admin
    .from('organizations')
    .select('*')
    .eq('personal_owner_user_id', userId)
    .eq('type', 'personal')
    .maybeSingle();

  if (orgErr) {
    console.error('[billing] load org:', orgErr);
    return { error: orgErr };
  }
  if (!org) {
    return { org: null, member: null };
  }

  const { data: member, error: memErr } = await admin
    .from('organization_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (memErr) {
    console.error('[billing] load member:', memErr);
    return { error: memErr };
  }

  return { org, member };
}

async function getOrCreatePersonalOrgAndMembership(admin, user) {
  const userId = user.id;
  const first = await getPersonalOrgAndMembership(admin, userId);
  if (first.error || first.org) return first;

  try {
    await ensurePersonalOrganization(userId, { name: user.email || 'Personal' });
  } catch (err) {
    console.error('[billing] ensurePersonalOrganization:', err);
    return { error: err };
  }

  return await getPersonalOrgAndMembership(admin, userId);
}

/**
 * GET /api/billing/status
 */
export async function getBillingStatus(request, reply) {
  const admin = supabaseAdmin();
  const { org, member, error } = await getOrCreatePersonalOrgAndMembership(admin, request.user);
  if (error) {
    return reply.status(500).send({ error: 'Failed to load billing' });
  }
  if (!org) {
    return reply.status(404).send({
      error: 'No personal organization',
      code: 'PERSONAL_ORG_MISSING',
    });
  }
  if (!member) {
    return reply.status(403).send({ error: 'Not a member of this organization' });
  }

  const internalAccess = await loadInternalAccess(request.user.id).catch((err) => {
    console.error('[billing] loadInternalAccess:', err);
    return null;
  });

  const entitlements = computeEntitlements({
    userId: request.user.id,
    org,
    internalAccess,
  });

  return reply.status(200).send({
    organization: {
      id: org.id,
      name: org.name,
      type: org.type,
      current_period_end: org.current_period_end,
      cancel_at_period_end: org.cancel_at_period_end,
      stripe_customer_id: org.stripe_customer_id,
    },
    entitlements,
  });
}

/**
 * POST /api/billing/checkout-session
 */
export async function createCheckoutSession(request, reply) {
  const stripe = getStripe();
  if (!stripe) {
    return reply.status(503).send({ error: 'Stripe not configured' });
  }

  const priceId = process.env[PRO_PRICE_ENV];
  if (!priceId) {
    return reply.status(503).send({ error: 'Pro price not configured' });
  }

  const userId = request.user.id;
  const admin = supabaseAdmin();
  const { org, member, error } = await getOrCreatePersonalOrgAndMembership(admin, request.user);
  if (error) {
    return reply.status(500).send({ error: 'Failed to load organization' });
  }
  if (!org) {
    return reply.status(404).send({
      error: 'No personal organization',
      code: 'PERSONAL_ORG_MISSING',
    });
  }
  if (!member || member.role !== 'owner') {
    return reply.status(403).send({ error: 'Only organization owners can manage billing' });
  }

  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: request.user.email || undefined,
      metadata: { organization_id: org.id, user_id: userId },
    });
    customerId = customer.id;
    const { error: upErr } = await admin
      .from('organizations')
      .update({ stripe_customer_id: customerId })
      .eq('id', org.id);
    if (upErr) {
      console.error('[billing] save customer id:', upErr);
      return reply.status(500).send({ error: 'Failed to persist Stripe customer' });
    }
  }

  const base = getFrontendBase();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/billing/cancel`,
    metadata: { organization_id: org.id, user_id: userId },
    subscription_data: {
      metadata: { organization_id: org.id, user_id: userId },
    },
  });

  if (!session.url) {
    return reply.status(500).send({ error: 'Checkout session missing URL' });
  }

  return reply.status(200).send({ url: session.url });
}

/**
 * POST /api/billing/portal-session
 */
export async function createPortalSession(request, reply) {
  const stripe = getStripe();
  if (!stripe) {
    return reply.status(503).send({ error: 'Stripe not configured' });
  }

  const admin = supabaseAdmin();
  const { org, member, error } = await getOrCreatePersonalOrgAndMembership(admin, request.user);
  if (error) {
    return reply.status(500).send({ error: 'Failed to load organization' });
  }
  if (!org) {
    return reply.status(404).send({
      error: 'No personal organization',
      code: 'PERSONAL_ORG_MISSING',
    });
  }
  if (!member || member.role !== 'owner') {
    return reply.status(403).send({ error: 'Only organization owners can manage billing' });
  }
  if (!org.stripe_customer_id) {
    return reply.status(400).send({
      error: 'No Stripe customer for this organization',
      code: 'STRIPE_CUSTOMER_MISSING',
    });
  }

  const base = getFrontendBase();
  const portal = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${base}/billing`,
  });

  if (!portal.url) {
    return reply.status(500).send({ error: 'Portal session missing URL' });
  }

  return reply.status(200).send({ url: portal.url });
}
