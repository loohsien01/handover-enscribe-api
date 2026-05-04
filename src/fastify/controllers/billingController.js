import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import { ensurePersonalOrganization } from '../../services/personalOrganization.js';

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

  return reply.status(200).send({
    organization: {
      id: org.id,
      name: org.name,
      type: org.type,
      plan_key: org.plan_key,
      subscription_status: org.subscription_status,
      current_period_end: org.current_period_end,
      cancel_at_period_end: org.cancel_at_period_end,
      stripe_customer_id: org.stripe_customer_id,
    },
  });
}
