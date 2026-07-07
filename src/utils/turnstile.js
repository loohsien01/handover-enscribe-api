/**
 * Cloudflare Turnstile server-side verification.
 *
 * Bot-protection soft rollout (see docs/AUTH_BOT_PROTECTION.md). During the beta
 * phase this is "verify-if-present": the beta FE login page sends `turnstileToken`,
 * the stable login page does not. Callers only invoke this when a token is present.
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
  process.env.TURNSTILE_SITEVERIFY_TIMEOUT_MS || 4000,
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
 * Verify a Turnstile token with Cloudflare siteverify.
 *
 * @param {string} token - The `cf-turnstile-response` token from the client.
 * @param {{ remoteip?: string | null }} [opts]
 * @returns {Promise<{ success: boolean, errorCodes?: string[], reason?: string }>}
 *   `success` is only true when Cloudflare confirms the token. On any failure
 *   (missing token/secret, network/timeout, non-2xx, `success !== true`) this
 *   resolves `{ success: false, ... }` — callers should treat that as reject.
 */
export async function verifyTurnstile(token, opts = {}) {
  const { remoteip = null } = opts;

  if (typeof token !== 'string' || token.trim().length === 0) {
    return { success: false, reason: 'missing_token' };
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

    return { success: true };
  } catch (err) {
    // Timeout / network error → fail closed.
    console.error('[turnstile] siteverify request error:', err?.message || err);
    return { success: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
