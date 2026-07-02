import { getSupabaseClient } from './supabase.js';
import { isCognitoAuth } from './authProvider.js';
import { verifyAccessToken } from './cognitoJwt.js';
import { resolveAppUserFromCognito } from './resolveAppUserFromCognito.js';

/**
 * Verify Bearer access token and return canonical app user `{ id, email }`.
 * @param {string} token - Raw JWT (no "Bearer " prefix)
 * @returns {Promise<{ user: { id: string, email: string } | null, error: string | null }>}
 */
export async function authenticateAccessToken(token) {
  if (!token) {
    return { user: null, error: 'JWT Token is required' };
  }

  if (isCognitoAuth()) {
    try {
      const payload = await verifyAccessToken(token);
      const cognitoSub = typeof payload.sub === 'string' ? payload.sub : '';
      const emailHint =
        (typeof payload.email === 'string' && payload.email) ||
        (typeof payload.username === 'string' && payload.username) ||
        undefined;
      const appUser = await resolveAppUserFromCognito(cognitoSub, emailHint);
      if (!appUser) {
        return { user: null, error: 'Invalid or expired token' };
      }
      return { user: appUser, error: null };
    } catch (err) {
      console.error('[authenticateAccessToken] Cognito verify failed:', err);
      return { user: null, error: 'Invalid or expired token' };
    }
  }

  const supabase = getSupabaseClient(`Bearer ${token}`);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, error: 'Invalid or expired token' };
  }
  return { user: data.user, error: null };
}
