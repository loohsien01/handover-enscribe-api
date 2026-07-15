/**
 * Cloudflare Turnstile server-side verification.
 *
 * Bot protection for sign-in, sign-up, and forgot-password
 * (see docs/AUTH_BOT_PROTECTION.md). These flows require a token and verify it
 * server-side before invoking their auth controllers.
 *
 * Security notes:
 *  - The token is verified against Cloudflare `siteverify` with the server-only
 *    secret. A token from the browser alone proves nothing.
 *  - Fail closed: if the secret is missing or `siteverify` is unreachable, this
 *    returns `{ success: false }` so callers reject the auth action.
 *  - Never leak Cloudflare internals (error codes) to API clients; log server-side
 *    and return a generic error to the FE.
 */

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Outbound request timeout for siteverify (ms). */
const SITEVERIFY_TIMEOUT_MS = Number(
  process.env.CLOUDFLARE_TURNSTILE_SITEVERIFY_TIMEOUT_MS ||
    process.env.CLOUDFLARE_TURNSTILE_SITEVERIFY_TIMEOUT_MS || process.env.TURNSTILE_SITEVERIFY_TIMEOUT_MS ||
    4000,
);

/** Server-only secret. Named to match .env.local / deploy.yml. */
function getSecret() {
  return (
    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ||
    process.env.TURNSTILE_SECRET_KEY ||
    ''
  );
}

/**
 * @returns {boolean} true when a Turnstile secret is configured.
 */
export function isTurnstileConfigured() {
  return getSecret().trim().length > 0;
}

/**
 * Non-production test/dev bypass token.
 *
 * Returns the configured bypass token ONLY when not running in production. When a
 * caller's token exactly equals this value, `verifyTurnstile` short-circuits to
 * success (satisfying any `expectedAction`). This lets integration tests exercise
 * the auth flows without a live Turnstile challenge, and is impossible to enable
 * in production: the `NODE_ENV === 'production'` guard returns '' there regardless
 * of how `CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN` is set. Disabled unless explicitly opted in.
 *
 * @returns {string}
 */
function getTestBypassToken() {
  if (process.env.NODE_ENV === 'production') return '';
  const v = process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Verify a Turnstile token with Cloudflare siteverify.
 *
 * @param {string} token - The `cf-turnstile-response` token from the client.
 * @param {{ remoteip?: string | null, expectedAction?: string | null }} [opts]
 *   `expectedAction` — when provided, the `action` returned by siteverify (the
 *   widget's `data-action`) must match exactly, otherwise verification fails with
 *   `reason: 'action_mismatch'`. This binds a token to the specific auth flow it
 *   was issued for (e.g. a `sign-in` token cannot be replayed against `sign-up`).
 * @returns {Promise<{ success: boolean, errorCodes?: string[], reason?: string, action?: string | null }>}
 *   `success` is only true when Cloudflare confirms the token (and the action
 *   matches when `expectedAction` is set). On any failure (missing token/secret,
 *   network/timeout, non-2xx, `success !== true`, action mismatch) this resolves
 *   `{ success: false, ... }` — callers should treat that as reject.
 */
export async function verifyTurnstile(token, opts = {}) {
  const { remoteip = null, expectedAction = null } = opts;

  if (typeof token !== 'string' || token.trim().length === 0) {
    return { success: false, reason: 'missing_token' };
  }

  // Non-production only (see getTestBypassToken). Never active when
  // NODE_ENV === 'production'.
  const bypass = getTestBypassToken();
  if (bypass && token === bypass) {
    console.warn('[turnstile] TEST BYPASS token accepted (non-production only).');
    return { success: true, action: expectedAction ?? null, bypass: true };
  }

  const secret = getSecret();
  if (!secret) {
    // Fail closed: never allow the protected action through unverified in a
    // context where the caller decided verification is required.
    console.error('[turnstile] Secret not configured; failing closed.');
    return { success: false, reason: 'missing_secret' };
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteip) form.set('remoteip', remoteip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);

  try {
    const resp = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.error('[turnstile] siteverify HTTP error', resp.status);
      return { success: false, reason: `http_${resp.status}` };
    }

    const data = await resp.json().catch(() => null);
    if (!data || data.success !== true) {
      const errorCodes = Array.isArray(data?.['error-codes'])
        ? data['error-codes']
        : [];
      console.warn('[turnstile] verification failed', { errorCodes });
      return { success: false, errorCodes, reason: 'verification_failed' };
    }

    const action = typeof data.action === 'string' ? data.action : null;
    if (expectedAction && action !== expectedAction) {
      console.warn('[turnstile] action mismatch', {
        expected: expectedAction,
        received: action,
      });
      return { success: false, reason: 'action_mismatch', action };
    }

    return { success: true, action };
  } catch (err) {
    // Timeout / network error → fail closed.
    console.error('[turnstile] siteverify request error:', err?.message || err);
    return { success: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
