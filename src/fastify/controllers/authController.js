import { getSupabaseClient } from '../../utils/supabase.js';
import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import crypto from 'crypto';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import { upsertUserProfileForUser } from './userProfileController.js';
import { ensurePersonalOrganization } from '../../services/personalOrganization.js';

// Refresh token storage settings
const REFRESH_MAX_AGE_SECONDS = Number(process.env.REFRESH_MAX_AGE_SECONDS || 3 * 24 * 3600);
const refreshTokensTable = 'refreshTokens';

/** App route for Supabase recovery (must be allowlisted in Supabase + match your SPA). */
const PASSWORD_RESET_REDIRECT_PATH = '/auth/reset-password';

function defaultPasswordResetRedirectTo() {
  const base = process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
  return `${String(base).replace(/\/$/, '')}${PASSWORD_RESET_REDIRECT_PATH}`;
}

// Cookie options configurable via env
const REFRESH_COOKIE_SAMESITE = (process.env.REFRESH_COOKIE_SAMESITE || 'lax').toLowerCase();
const REFRESH_COOKIE_DOMAIN = process.env.REFRESH_COOKIE_DOMAIN || undefined;
const REFRESH_COOKIE_SECURE = process.env.REFRESH_COOKIE_SECURE
  ? process.env.REFRESH_COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

/**
 * Create refresh token cookie with secure settings
 */
export function makeRefreshCookie(wrapper, opts = {}) {
  const maxAge = opts.maxAge ?? REFRESH_MAX_AGE_SECONDS;
  const cookieValue = wrapper || '';
  
  const parts = [
    'refresh_token=' + encodeURIComponent(cookieValue),
    'HttpOnly',
    REFRESH_COOKIE_SECURE ? 'Secure' : '',
    `SameSite=${REFRESH_COOKIE_SAMESITE}`,
    'Path=/',
  ];
  
  if (maxAge) {
    parts.push(`Max-Age=${maxAge}`);
  }
  
  if (REFRESH_COOKIE_DOMAIN) {
    parts.push(`Domain=${REFRESH_COOKIE_DOMAIN}`);
  }
  
  return parts.filter(Boolean).join('; ');
}

/**
 * Create a signed wrapper JWT for refresh token
 * Contains tid (token ID) and user ID, signed with HMAC-SHA256
 * This is what goes in the HTTP-Only cookie
 */
export function createRefreshWrapper(userId, tid) {
  const secret = process.env.REFRESH_TOKEN_SIGNING_KEY_HEX;
  if (!secret) {
    throw new Error('REFRESH_TOKEN_SIGNING_KEY_HEX not configured');
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + REFRESH_MAX_AGE_SECONDS;
  const payload = { sub: userId, tid, iat, exp };

  const toEncode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${toEncode(header)}.${toEncode(payload)}`;
  const sig = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');

  return `${unsigned}.${sig}`;
}

/**
 * Sign up a new user
 * @param {{ userProfile?: { username: string, specialty: string } }} [opts]
 */
export async function signUp(email, password, opts = {}) {
  try {
    // Route validates email format and password requirements - trust the data
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      return { success: false, error: error.message };
    }

    console.log('[signUp] sign-up result', { hasSession: !!data?.session, hasUser: !!data?.user });

    /** Optional profile row (service role); only set when client sent `userProfile`. */
    const signupProfileExtras = {};
    if (opts.userProfile && data?.user?.id) {
      const admin = supabaseAdmin();
      const prof = await upsertUserProfileForUser(admin, data.user.id, opts.userProfile);
      if (prof.ok) {
        signupProfileExtras.userProfile = prof.data;
        if (prof.created) {
          try {
            await ensurePersonalOrganization(data.user.id, {
              name: opts.userProfile.username,
            });
          } catch (orgErr) {
            console.error('[signUp] ensurePersonalOrganization:', orgErr);
          }
        }
      } else {
        console.error('[signUp] Optional profile save failed:', prof.payload);
        signupProfileExtras.profileError = prof.payload;
      }
    }

    if (data?.session) {
      // Email confirmation disabled - user is immediately signed in
      // Persist refresh token server-side (same as sign-in)
      let tid = null;
      try {
        const admin = supabaseAdmin();
        const refreshToken = data?.session?.refresh_token;

        if (refreshToken) {
          tid = crypto.randomUUID();
          const hashed = encryptionUtils.hashToken(refreshToken);
          const enc = encryptionUtils.encryptRefreshToken(refreshToken);

          const { error: insertErr } = await admin
            .from(refreshTokensTable)
            .insert([
              {
                id: tid,
                user_id: data.user.id,
                token_hash: hashed,
                token_enc: enc,
                issued_at: new Date().toISOString(),
                last_activity_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + REFRESH_MAX_AGE_SECONDS * 1000).toISOString(),
                revoked: false,
              },
            ]);

          if (insertErr) {
            console.error('[signUp] Failed to store refresh token:', insertErr);
          } else {
            console.log('[signUp] Refresh token stored with id:', tid);
          }
        }
      } catch (err) {
        console.error('[signUp] Error storing refresh token:', err);
      }

      return {
        success: true,
        error: null,
        session: data.session,
        user: data.user,
        message: 'signed up and logged in',
        tid: tid,
        ...signupProfileExtras,
      };
    } else if (data?.user) {
      // Email confirmation enabled
      return {
        success: true,
        error: null,
        session: null,
        user: data.user,
        message: 'Email confirmation required',
        ...signupProfileExtras,
      };
    }

    return { success: false, error: 'Unknown sign-up result' };
  } catch (err) {
    console.error('[signUp] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Sign in an existing user
 */
export async function signIn(email, password) {
  try {
    // Route validates email format and password requirements - trust the data
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      console.log('[signIn] Sign-in failed:', error.message);
      return { success: false, error: error.message };
    }

    console.log('[signIn] Sign-in successful for user:', data.user.id);

    // Log full session object for diagnostics
    console.log('[signIn] Session object details', {
      hasSession: !!data?.session,
      sessionKeys: Object.keys(data?.session || {}),
      hasRefreshToken: !!data?.session?.refresh_token,
      refreshTokenLength: data?.session?.refresh_token?.length || 0,
      refreshTokenType: typeof data?.session?.refresh_token,
      refreshTokenPreview: data?.session?.refresh_token ? data.session.refresh_token.substring(0, 100) : 'null',
      hasAccessToken: !!data?.session?.access_token,
      accessTokenLength: data?.session?.access_token?.length || 0,
      expiresIn: data?.session?.expires_in,
    });

    // Persist refresh token server-side
    try {
      const admin = supabaseAdmin();
      const refreshToken = data?.session?.refresh_token;

      if (refreshToken) {
        const tid = crypto.randomUUID();
        const hashed = encryptionUtils.hashToken(refreshToken);
        const enc = encryptionUtils.encryptRefreshToken(refreshToken);

        console.log('[signIn] Storing encrypted token', {
          tid,
          rawRefreshToken: refreshToken,
          refreshTokenLength: refreshToken.length,
          encryptedTokenLength: enc.length,
          encryptedTokenPreview: enc.substring(0, 50),
        });

        const { data: insertData, error: insertErr } = await admin
          .from(refreshTokensTable)
          .insert([
            {
              id: tid,
              user_id: data.user.id,
              token_hash: hashed,
              token_enc: enc,
              issued_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + REFRESH_MAX_AGE_SECONDS * 1000).toISOString(),
              revoked: false,
            },
          ]);

        if (insertErr) {
          console.error('[signIn] Failed to store refresh token:', insertErr);
        } else {
          console.log('[signIn] Refresh token stored with id:', tid);
        }

        return {
          success: true,
          error: null,
          session: data.session,
          user: data.user,
          tid: tid,
        };
      }
    } catch (err) {
      console.error('[signIn] Error storing refresh token:', err);
      // Still return successful sign-in even if refresh token storage fails
    }

    return {
      success: true,
      error: null,
      session: data.session,
      user: data.user,
      tid: null,
    };
  } catch (err) {
    console.error('[signIn] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Sign out a user (requires authentication)
 */
export async function signOut(userId, refreshTokenFromCookie = null) {
  try {
    // Revoke server-side refresh token
    if (refreshTokenFromCookie) {
      try {
        const admin = supabaseAdmin();
        const parts = refreshTokenFromCookie.split('.');

        if (parts.length === 3) {
          const [h64, p64, sig] = parts;
          const unsigned = `${h64}.${p64}`;
          const secret = process.env.REFRESH_TOKEN_SIGNING_KEY_HEX;

          if (secret) {
            const expected = crypto
              .createHmac('sha256', secret)
              .update(unsigned)
              .digest('base64url');

            if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
              const payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
              const tid = payload.tid;

              if (tid) {
                await admin
                  .from(refreshTokensTable)
                  .update({
                    revoked: true,
                    last_activity_at: new Date().toISOString(),
                  })
                  .eq('id', tid);

                console.log('[signOut] Refresh token revoked:', tid);
              }
            }
          }
        }
      } catch (err) {
        console.error('[signOut] Error revoking refresh token:', err);
      }
    }

    // Sign out from Supabase
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signOut();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, error: null };
  } catch (err) {
    console.error('[signOut] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Resend confirmation email
 */
export async function resendConfirmationEmail(email, emailRedirectTo = null) {
  try {
    if (!email) {
      return { success: false, error: 'Email is required' };
    }

    if (!email.includes('@')) {
      return { success: false, error: `Invalid email format: ${email}` };
    }

    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: emailRedirectTo ? { emailRedirectTo } : undefined,
    });

    if (error) {
      console.log('[resendConfirmationEmail] Error:', error.message);
      return { success: false, error: error.message };
    }

    console.log('[resendConfirmationEmail] Email sent to:', email);
    return { success: true, error: null };
  } catch (err) {
    console.error('[resendConfirmationEmail] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Send Supabase password recovery email.
 * Security: caller should return a generic 200 regardless of whether the user exists.
 * Uses optional client `redirectTo`, else `{FRONTEND_URL|APP_BASE_URL|localhost}${PASSWORD_RESET_REDIRECT_PATH}`.
 * @param {string} email
 * @param {{ redirectTo?: string }} [opts]
 */
export async function forgotPassword(email, opts = {}) {
  try {
    if (!email) return { success: false, error: 'Email is required' };
    if (!email.includes('@')) return { success: false, error: `Invalid email format: ${email}` };

    const explicit = typeof opts?.redirectTo === 'string' ? opts.redirectTo.trim() : '';
    const redirectTo = explicit || defaultPasswordResetRedirectTo();

    const supabase = getSupabaseClient();

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      // Do NOT leak to client; route returns generic success message.
      console.error('[forgotPassword] Supabase error:', error.message);
      return { success: false, error: error.message };
    }

    return { success: true, error: null };
  } catch (err) {
    console.error('[forgotPassword] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Refresh a refresh token
 * Validates refresh token from cookie, checks inactivity, exchanges with Supabase
 * Updates token in DB and returns new access token
 * @param {string} wrapper - The wrapper JWT from cookie
 * @param {object} logger - Pino logger instance
 */
export async function refreshRefreshToken(wrapper, logger = null) {
  try {
    const log = logger || { info: console.log, error: console.error, warn: console.warn };
    const REFRESH_INACTIVITY_LIMIT_SECONDS = Number(process.env.REFRESH_INACTIVITY_LIMIT_SECONDS || 3 * 24 * 3600);
    const secret = process.env.REFRESH_TOKEN_SIGNING_KEY_HEX;

    if (!secret) {
      log.error({ event: 'refreshRefreshToken', step: 'config_error', error: 'REFRESH_TOKEN_SIGNING_KEY_HEX missing' });
      return { success: false, error: 'Server misconfigured' };
    }

    if (!wrapper) {
      return { success: false, error: 'no_refresh_token' };
    }

    // Decode and validate wrapper JWT
    let payload;
    try {
      const parts = wrapper.split('.');
      if (parts.length !== 3) throw new Error('invalid_token_format');
      
      const [h64, p64, sig] = parts;
      const unsigned = `${h64}.${p64}`;
      const expected = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
      
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        throw new Error('invalid_sig');
      }
      
      payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
    } catch (err) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'wrapper_validation_failed',
        error: err.message,
        wrapperLength: wrapper?.length || 0,
        wrapperPreview: wrapper ? wrapper.substring(0, 50) + '...' : 'null',
      });
      return { success: false, error: 'invalid_refresh' };
    }

    const { sub: userId, tid: oldTokenId, exp, iat } = payload;
    if (!userId || !oldTokenId) {
      log.error({ event: 'refreshRefreshToken', step: 'invalid_payload', userId, oldTokenId });
      return { success: false, error: 'invalid_refresh_payload' };
    }

    log.info({
      event: 'refreshRefreshToken',
      step: 'wrapper_validated',
      tid: oldTokenId,
      userId,
      issuedAt: new Date(iat * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (exp && nowSeconds > exp) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'wrapper_jwt_expired',
        tid: oldTokenId,
        userId,
        issuedAt: new Date(iat * 1000).toISOString(),
        expiresAt: new Date(exp * 1000).toISOString(),
        expiredBySeconds: nowSeconds - exp,
      });
      return { success: false, error: 'refresh_expired', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    // Lookup old token row in DB
    const admin = supabaseAdmin();
    log.info({ event: 'refreshRefreshToken', step: 'db_lookup', tid: oldTokenId, userId });
    
    const { data: oldRow, error: lookupErr } = await admin
      .from(refreshTokensTable)
      .select('*')
      .eq('id', oldTokenId)
      .limit(1)
      .maybeSingle();

    if (lookupErr) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'db_lookup_error',
        error: lookupErr.message,
        tid: oldTokenId,
        userId,
      });
      return { success: false, error: 'db_error', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    if (!oldRow) {
      log.info({
        event: 'refreshRefreshToken',
        step: 'token_not_found',
        tid: oldTokenId,
        userId,
        queryTime: new Date().toISOString(),
      });
      return { success: false, error: 'token_revoked_or_notfound', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    log.info({
      event: 'refreshRefreshToken',
      step: 'token_found',
      tid: oldTokenId,
      userId,
      revoked: oldRow.revoked,
      issuedAt: oldRow.issued_at,
      expiresAt: oldRow.expires_at,
      lastActivityAt: oldRow.last_activity_at,
      dbUserId: oldRow.user_id,
      storedEncTokenLength: oldRow.token_enc?.length || 0,
    });

    if (oldRow.revoked) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'token_revoked',
        tid: oldTokenId,
        userId,
      });
      return { success: false, error: 'token_revoked', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    const expiresTime = new Date(oldRow.expires_at).getTime();
    if (expiresTime < Date.now()) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'token_expired_in_db',
        tid: oldTokenId,
        userId,
        expiresAt: oldRow.expires_at,
        now: new Date().toISOString(),
        expiredByMs: Date.now() - expiresTime,
      });
      return { success: false, error: 'refresh_expired_db', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    // Check inactivity
    const lastActivityMs = new Date(oldRow.last_activity_at).getTime();
    const inactivityMs = Date.now() - lastActivityMs;
    const inactivityLimitMs = REFRESH_INACTIVITY_LIMIT_SECONDS * 1000;
    
    if (oldRow.last_activity_at && inactivityMs > inactivityLimitMs) {
      await admin.from(refreshTokensTable).update({ revoked: true }).eq('id', oldTokenId);
      log.error({
        event: 'refreshRefreshToken',
        step: 'inactivity_timeout',
        tid: oldTokenId,
        userId,
        lastActivityAt: oldRow.last_activity_at,
        inactivityMs,
        inactivityLimitMs,
        inactivityDays: (inactivityMs / (1000 * 60 * 60 * 24)).toFixed(2),
      });
      return { success: false, error: 'session_inactive', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    // Decrypt stored encrypted token and verify hash
    let rawStoredRefresh;
    try {
      rawStoredRefresh = encryptionUtils.decryptRefreshToken(oldRow.token_enc);
      
      // Create a hash of the decrypted token for comparison
      const tokenHash = crypto.createHash('sha256').update(rawStoredRefresh).digest('hex');
      const tokenPreview = rawStoredRefresh.substring(0, 50);
      
      log.info({
        event: 'refreshRefreshToken',
        step: 'decryption_success',
        tid: oldTokenId,
        userId,
        encryptedTokenLength: oldRow.token_enc?.length || 0,
        decryptedTokenLength: rawStoredRefresh?.length || 0,
        decryptedTokenHash: tokenHash,
        decryptedTokenPreview: tokenPreview,
      });
    } catch (err) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'decryption_failed',
        error: err.message,
        tid: oldTokenId,
        userId,
        tokenEncLength: oldRow.token_enc?.length || 0,
      });
      await admin.from(refreshTokensTable).update({ revoked: true }).eq('id', oldTokenId);
      return { success: false, error: 'invalid_refresh', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    const hashOk = encryptionUtils.verifyTokenHash(rawStoredRefresh, oldRow.token_hash);
    if (!hashOk) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'hash_verification_failed',
        tid: oldTokenId,
        userId,
        decryptedTokenLength: rawStoredRefresh?.length || 0,
      });
      await admin.from(refreshTokensTable).update({ revoked: true }).eq('id', oldTokenId);
      return { success: false, error: 'invalid_refresh', debugUserId: userId, debugOldTokenId: oldTokenId };
    }

    log.info({
      event: 'refreshRefreshToken',
      step: 'hash_verified',
      tid: oldTokenId,
      userId,
    });

    // Exchange with Supabase
    try {
      const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
      
      if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase not configured');
      }

      const url = `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
      
      // Log token details before sending to Supabase
      const tokenToSendHash = crypto.createHash('sha256').update(rawStoredRefresh).digest('hex');
      const tokenToSendPreview = rawStoredRefresh.substring(0, 50);
      
      log.info({
        event: 'refreshRefreshToken',
        step: 'supabase_exchange_start',
        tid: oldTokenId,
        userId,
        storedRefreshTokenLength: rawStoredRefresh?.length || 0,
        tokenToSendHash,
        tokenToSendPreview,
      });
      
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnonKey,
        },
        body: JSON.stringify({ refresh_token: rawStoredRefresh }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '<no body>');
        log.error({
          event: 'refreshRefreshToken',
          step: 'supabase_exchange_failed',
          status: resp.status,
          statusText: resp.statusText,
          fullResponse: text,
          tid: oldTokenId,
          userId,
          tokenToSendHash,
          tokenToSendPreview,
          storedEncTokenLength: oldRow.token_enc?.length || 0,
          decryptedTokenLength: rawStoredRefresh?.length || 0,
        });
        await admin.from(refreshTokensTable).update({ revoked: true }).eq('id', oldTokenId);
        return { success: false, error: 'invalid_refresh_exchange', debugUserId: userId, debugOldTokenId: oldTokenId };
      }

      const session = await resp.json();
      const accessToken = session.access_token;
      const newRefreshToken = session.refresh_token;

      if (!accessToken) {
        log.error({
          event: 'refreshRefreshToken',
          step: 'no_access_token_from_supabase',
          tid: oldTokenId,
          userId,
          hasRefreshToken: !!newRefreshToken,
          responseKeys: Object.keys(session),
        });
        return { success: false, error: 'no_access_token_from_supabase', debugUserId: userId, debugOldTokenId: oldTokenId };
      }
      
      log.info({
        event: 'refreshRefreshToken',
        step: 'supabase_exchange_success',
        tid: oldTokenId,
        userId,
        accessTokenLength: accessToken?.length || 0,
        newRefreshTokenLength: newRefreshToken?.length || 0,
      });

      // Create NEW token row with new tid (token rotation with revocation of old row)
      try {
        const newTokenId = crypto.randomUUID();
        const hashed = encryptionUtils.hashToken(newRefreshToken);
        const enc = encryptionUtils.encryptRefreshToken(newRefreshToken);

        // Insert new row with new tid
        const { error: insertErr } = await admin
          .from(refreshTokensTable)
          .insert([{
            id: newTokenId,
            user_id: userId,
            token_hash: hashed,
            token_enc: enc,
            issued_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + REFRESH_MAX_AGE_SECONDS * 1000).toISOString(),
            revoked: false,
          }]);

        if (insertErr) {
          log.error({
            event: 'refreshRefreshToken',
            step: 'token_rotation_insert_failed',
            error: insertErr.message,
            userId,
          });
          return { success: false, error: 'token_rotation_failed' };
        }

        // Revoke old row for security
        await admin.from(refreshTokensTable).update({ revoked: true }).eq('id', oldTokenId);

        log.info({
          event: 'refreshRefreshToken',
          step: 'token_rotated',
          oldTokenId,
          newTokenId,
          userId,
        });

        return {
          success: true,
          accessToken,
          newTokenId, // Return new tid so route can create new wrapper JWT
        };
      } catch (err) {
        log.error({
          event: 'refreshRefreshToken',
          step: 'token_rotation_failed',
          error: err.message,
          userId,
        });
        return { success: false, error: 'token_rotation_failed' };
      }
    } catch (err) {
      log.error({
        event: 'refreshRefreshToken',
        step: 'supabase_exchange_error',
        error: err.message,
        userId: userId || 'unknown',
      });
      return { success: false, error: 'refresh_error' };
    }
  } catch (err) {
    log?.error?.({
      event: 'refreshRefreshToken',
      step: 'unexpected_error',
      error: err.message,
    });
    return { success: false, error: err.message };
  }
}

/**
 * Check if refresh cookie is valid and present
 */
export async function checkRefreshCookieStatus(wrapper) {
  try {
    const secret = process.env.REFRESH_TOKEN_SIGNING_KEY_HEX;

    if (!wrapper || !secret) {
      return { success: true, cookiePresent: false };
    }

    // Validate wrapper JWT
    let payload;
    try {
      const parts = wrapper.split('.');
      if (parts.length !== 3) throw new Error('invalid_token_format');
      
      const [h64, p64, sig] = parts;
      const unsigned = `${h64}.${p64}`;
      const expected = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
      
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        throw new Error('invalid_sig');
      }
      
      payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
    } catch (err) {
      return { success: true, cookiePresent: false };
    }

    const { tid: tokenId, exp } = payload;
    if (!tokenId) return { success: true, cookiePresent: false };
    if (exp && Date.now() > exp * 1000) return { success: true, cookiePresent: false };

    // Lookup in DB
    const admin = supabaseAdmin();
    const { data: row, error } = await admin
      .from(refreshTokensTable)
      .select('*')
      .eq('id', tokenId)
      .limit(1)
      .maybeSingle();

    if (error || !row) return { success: true, cookiePresent: false };
    if (row.revoked) return { success: true, cookiePresent: false };
    if (new Date(row.expires_at).getTime() < Date.now()) return { success: true, cookiePresent: false };

    // Verify hash
    try {
      const rawStoredRefresh = encryptionUtils.decryptRefreshToken(row.token_enc);
      const ok = encryptionUtils.verifyTokenHash(rawStoredRefresh, row.token_hash);
      if (!ok) return { success: true, cookiePresent: false };
    } catch (err) {
      return { success: true, cookiePresent: false };
    }

    return { success: true, cookiePresent: true };
  } catch (err) {
    console.error('[checkRefreshCookieStatus] Error:', err);
    return { success: true, cookiePresent: false };
  }
}

/**
 * Check if a token is valid (verify authentication)
 */
export async function checkTokenValidity(authHeader) {
  try {
    if (!authHeader) {
      return { success: false, error: 'Authorization header required', user: null };
    }

    const supabase = getSupabaseClient(authHeader);
    const token = authHeader.replace(/^Bearer\s+/i, '');

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return { success: false, error: 'Invalid or expired token', user: null };
    }

    return { success: true, error: null, user: data.user };
  } catch (err) {
    console.error('[checkTokenValidity] Error:', err);
    return { success: false, error: err.message, user: null };
  }
}

/**
 * Extract user ID from an access token JWT
 * @param {string} token - JWT access token
 * @returns {string|null} User ID or null if extraction fails
 */
export function extractUserIdFromAccessToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return payload.sub || null;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Extract tid from wrapper JWT
 * @param {string} wrapper - Signed wrapper JWT
 * @returns {string|null} Token ID or null if extraction fails
 */
export function extractTidFromWrapper(wrapper) {
  try {
    const parts = wrapper.split('.');
    if (parts.length === 3) {
      const p64 = parts[1];
      const payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
      return payload.tid || null;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Decrypt and verify stored refresh token from DB row
 * @param {object} row - refreshTokens table row with token_enc and token_hash
 * @returns {object} { token: decrypted_token or null, error: error_message or null }
 */
export function decryptStoredRefreshToken(row) {
  try {
    const decrypted = encryptionUtils.decryptRefreshToken(row.token_enc);
    const isValid = encryptionUtils.verifyTokenHash(decrypted, row.token_hash);
    
    if (!isValid) {
      return { token: null, error: 'Hash verification failed' };
    }
    
    return { token: decrypted, error: null };
  } catch (err) {
    console.error('[decryptStoredRefreshToken] Error:', err);
    return { token: null, error: err.message };
  }
}

/**
 * Exchange raw refresh token with Supabase for new session
 * Used by mobile clients who send raw tokens
 * @param {string} rawRefreshToken - Raw Supabase refresh token
 * @returns {object} { success, accessToken, refreshToken, error }
 */
export async function exchangeRawRefreshTokenWithSupabase(rawRefreshToken) {
  try {
    const baseUrl = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token`;
    const url = `${baseUrl}?grant_type=refresh_token`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ refresh_token: rawRefreshToken }),
    });

    if (!response.ok) {
      let errorText = '<could not read body>';
      try {
        errorText = await response.text();
      } catch (e) {
        // ignore
      }
      console.error('[exchangeRawRefreshTokenWithSupabase] Supabase error:', errorText);
      return { success: false, error: 'Supabase exchange failed', status: response.status };
    }

    const session = await response.json();
    return {
      success: true,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      error: null,
    };
  } catch (err) {
    console.error('[exchangeRawRefreshTokenWithSupabase] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Store rotated refresh token in DB and return wrapper JWT
 * Used after exchanging tokens with Supabase
 * @param {string} rawRefreshToken - New raw refresh token from Supabase
 * @param {string} userId - User ID (extracted from access token or payload)
 * @returns {object} { success, newTid, wrapper, error }
 */
export async function storeAndWrapNewRefreshToken(rawRefreshToken, userId) {
  try {
    const admin = supabaseAdmin();
    const newTid = crypto.randomUUID();
    const hashed = encryptionUtils.hashToken(rawRefreshToken);
    const enc = encryptionUtils.encryptRefreshToken(rawRefreshToken);

    const { error: insertErr } = await admin
      .from(refreshTokensTable)
      .insert([
        {
          id: newTid,
          user_id: userId,
          token_hash: hashed,
          token_enc: enc,
          issued_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + REFRESH_MAX_AGE_SECONDS * 1000).toISOString(),
          revoked: false,
        },
      ]);

    if (insertErr) {
      console.error('[storeAndWrapNewRefreshToken] Insert error:', insertErr);
      return { success: false, error: insertErr.message };
    }

    const wrapper = createRefreshWrapper(userId, newTid);
    return { success: true, newTid, wrapper, error: null };
  } catch (err) {
    console.error('[storeAndWrapNewRefreshToken] Error:', err);
    return { success: false, error: err.message };
  }
}
