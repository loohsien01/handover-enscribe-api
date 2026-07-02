import {
  ensurePersonalOrganization,
  loadPersonalOrgAndMembership,
} from '../../services/personalOrganization.js';
import {
  computeBaaStatus,
  insertBaaAcceptance,
  loadActiveBaaVersion,
  loadBaaAcceptanceForVersion,
} from '../../utils/baaStatus.js';

async function getOrCreatePersonalOrgAndMembership(user) {
  const userId = user.id;
  const first = await loadPersonalOrgAndMembership(userId);
  if (first.error || first.org) return first;

  try {
    await ensurePersonalOrganization(userId, { name: user.email || 'Personal' });
  } catch (err) {
    console.error('[baa] ensurePersonalOrganization:', err);
    return { error: err };
  }

  return loadPersonalOrgAndMembership(userId);
}

function formatAcceptanceResponse(acceptance) {
  return {
    id: acceptance.id,
    version_number: acceptance.version_number,
    accepted_at: acceptance.accepted_at,
    organization_id: acceptance.organization_id,
    accepted_by_user_id: acceptance.accepted_by_user_id,
  };
}

/**
 * GET /api/baa/active
 */
export async function getActiveBaa(request, reply) {
  try {
    const activeVersion = await loadActiveBaaVersion();
    if (!activeVersion) {
      return reply.status(404).send({
        error: 'No active BAA version',
        code: 'BAA_ACTIVE_VERSION_MISSING',
      });
    }

    return reply.status(200).send({
      version_number: activeVersion.version_number,
      title: activeVersion.title,
      content_markdown: activeVersion.content_markdown,
      effective_date: activeVersion.effective_date,
    });
  } catch (err) {
    request.log?.error({ err }, '[baa] getActiveBaa');
    return reply.status(500).send({ error: 'Failed to load active BAA' });
  }
}

/**
 * GET /api/me/baa/status
 */
export async function getMyBaaStatus(request, reply) {
  const userId = request.user?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Unauthenticated' });
  }

  const { org, member, error } = await getOrCreatePersonalOrgAndMembership(request.user);
  if (error) {
    return reply.status(500).send({ error: 'Failed to load organization' });
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

  try {
    const activeVersion = await loadActiveBaaVersion();
    const acceptance =
      activeVersion != null
        ? await loadBaaAcceptanceForVersion(String(org.id), activeVersion.id)
        : null;

    const status = computeBaaStatus({
      activeVersion,
      acceptance,
      memberRole: member.role,
    });

    return reply.status(200).send({
      organization_id: org.id,
      ...status,
    });
  } catch (err) {
    request.log?.error({ err }, '[baa] getMyBaaStatus');
    return reply.status(500).send({ error: 'Failed to load BAA status' });
  }
}

/**
 * POST /api/me/baa/accept
 * Idempotent when org already accepted the active version.
 */
export async function acceptMyBaa(request, reply) {
  const userId = request.user?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Unauthenticated' });
  }

  const { org, member, error } = await getOrCreatePersonalOrgAndMembership(request.user);
  if (error) {
    return reply.status(500).send({ error: 'Failed to load organization' });
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
  if (member.role !== 'owner') {
    return reply.status(403).send({ error: 'Only organization owners can accept the BAA' });
  }

  const requestedVersion = request.body?.version_number;

  try {
    const activeVersion = await loadActiveBaaVersion();
    if (!activeVersion) {
      return reply.status(404).send({
        error: 'No active BAA version',
        code: 'BAA_ACTIVE_VERSION_MISSING',
      });
    }

    if (requestedVersion && requestedVersion !== activeVersion.version_number) {
      return reply.status(409).send({
        error: 'Active BAA version changed',
        code: 'BAA_VERSION_MISMATCH',
        active_version: activeVersion.version_number,
      });
    }

    const existing = await loadBaaAcceptanceForVersion(String(org.id), activeVersion.id);
    if (existing) {
      return reply.status(200).send({
        acceptance: formatAcceptanceResponse(existing),
      });
    }

    const inserted = await insertBaaAcceptance({
      organization_id: String(org.id),
      baa_version_id: activeVersion.id,
      accepted_by_user_id: userId,
    });

    return reply.status(201).send({
      acceptance: formatAcceptanceResponse(inserted),
    });
  } catch (err) {
    request.log?.error({ err }, '[baa] acceptMyBaa');
    return reply.status(500).send({ error: 'Failed to record BAA acceptance' });
  }
}
