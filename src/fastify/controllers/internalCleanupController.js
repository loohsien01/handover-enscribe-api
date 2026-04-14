/**
 * Internal maintenance endpoints (Bearer INTERNAL_CLEANUP_SECRET, not user JWT).
 */
import { internalCleanupRunBodySchema } from '../schemas/requests.js';
import supabaseAdmin from '../../utils/supabaseAdmin.js';
import {
  runUnattachedStorageCleanup,
  safeEqualUtf8,
} from '../../utils/unattachedStorageCleanup.js';

function extractBearerToken(authorizationHeader) {
  const auth = authorizationHeader || '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m?.[1] ?? '';
}

/**
 * POST /api/internal/cleanup/run
 */
export async function postInternalCleanupRun(request, reply) {
  const secret = process.env.INTERNAL_CLEANUP_SECRET;
  if (!secret) {
    return reply.status(503).send({ error: 'INTERNAL_CLEANUP_SECRET is not configured' });
  }

  const token = extractBearerToken(request.headers.authorization);
  if (!safeEqualUtf8(token, secret)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const parsed = internalCleanupRunBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const tasks = [...new Set(parsed.data.tasks)];

  const results = {};
  let anyError = false;

  for (const task of tasks) {
    if (task === 'unattached_storage') {
      try {
        const supabase = supabaseAdmin();
        const out = await runUnattachedStorageCleanup(supabase);
        results.unattached_storage = { status: 'ok', ...out };
      } catch (err) {
        anyError = true;
        request.log.error({ err }, '[postInternalCleanupRun] unattached_storage failed');
        results.unattached_storage = {
          status: 'error',
          message: err?.message || 'cleanup failed',
        };
      }
    }
  }

  if (anyError) {
    return reply.status(500).send({ ok: false, results });
  }

  return reply.status(200).send({ ok: true, results });
}
