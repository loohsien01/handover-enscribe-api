import fp from 'fastify-plugin';
import * as authController from '../controllers/authController.js';
import { serializeZodError } from '../../utils/serializeZodError.js';
import { verifyTurnstile } from '../../utils/turnstile.js';
import {
  authSignUpRequestSchema,
  authSignInRequestSchema,
  authSignOutRequestSchema,
  authCheckValidityRequestSchema,
  authResendRequestSchema,
  authForgotPasswordRequestSchema,
  authConfirmForgotPasswordRequestSchema,
} from '../schemas/requests.js';

/**
 * Fastify plugin for authentication routes
 * Handles: sign-up, sign-in, sign-out, check-validity, resend, forgot-password
 */
async function authRoutes(fastify, opts) {
  // Extract auth header from request
  const getAuthHeader = (request) => {
    return request.headers.authorization || null;
  };

  // Check if client prefers JSON (mobile) or HTML (browser)
  const isJsonClient = (request) => {
    const accept = request.headers['accept'] || '';
    return accept.includes('application/json');
  };

  /** Redact secrets for server logs (matches payload shape sent to FE). */
  const redactSessionForLog = (session) => {
    if (!session || typeof session !== 'object') return session;
    const out = { ...session };
    if (out.access_token) {
      out.access_token = `${String(out.access_token).slice(0, 50)}...`;
    }
    if (out.refresh_token) {
      out.refresh_token = '[REDACTED]';
    }
    return out;
  };

  const userSummaryForLog = (user) =>
    user && typeof user === 'object' ? { id: user.id, email: user.email } : user;

  /**
   * POST /auth
   * Handles: sign-up, sign-in, sign-out, check-validity, resend, forgot-password
   * 
   * Body:
   * {
   *   action: 'sign-up' | 'sign-in' | 'sign-out' | 'check-validity' | 'resend' | 'forgot-password',
   *   email?: string,
   *   password?: string,
   *   emailRedirectTo?: string,
   *   redirectTo?: string, // optional for 'forgot-password'; default is FRONTEND_URL + /reset-password
   *   userProfile: { username: string, specialty: string }  // required; same shape as POST /user-profile body
   * }
   */
  fastify.post('/auth', async (request, reply) => {
    const { action, email, password, emailRedirectTo } = request.body || {};

    console.log(`[POST /auth] action=${action}, email=${email}`);

    try {
      // Validate action field first
      if (!action || typeof action !== 'string') {
        return reply.status(400).send({
          error: serializeZodError({
            issues: [{
              code: 'invalid_type',
              path: ['action'],
              message: 'Action is required and must be a string',
            }],
          }),
        });
      }

      // Validate request based on action
      let validation;
      switch (action) {
        case 'sign-up': {
          validation = authSignUpRequestSchema.safeParse(request.body);
          if (!validation.success) {
            const errBody = { error: serializeZodError(validation.error) };
            console.log('[sign-up] Response to FE', { status: 400, body: errBody });
            return reply.status(400).send(errBody);
          }
          const { userProfile: signUpUserProfile } = validation.data;
          const result = await authController.signUp(email, password, {
            userProfile: signUpUserProfile,
          });
          
          if (!result.success) {
            const status = result.status || 400;
            const errBody = {
              error: result.error,
              ...(result.code ? { code: result.code } : {}),
            };
            console.log('[sign-up] Response to FE', { status, body: errBody });
            return reply.status(status).send(errBody);
          }

          const signupProfileFields = {
            userProfile: result.userProfile,
          };

          if (result.session) {
            // User is logged in - create wrapper JWT with tid
            let wrapper = null;
            if (result.tid) {
              try {
                wrapper = authController.createRefreshWrapper(result.user.id, result.tid);
                console.log('[sign-up] Wrapper JWT created for tid:', result.tid);
              } catch (err) {
                console.error('[sign-up] Failed to create wrapper JWT:', err);
              }
            }
            
            const setCookie = wrapper ? authController.makeRefreshCookie(wrapper) : '';
            
            // For mobile (JSON) clients: include refresh_token in response
            // For web clients: exclude refresh_token, use HTTP-only cookie instead
            const sessionForResponse = isJsonClient(request)
              ? result.session  // Mobile: return full session with refresh_token
              : (() => {
                  const safeSession = { ...result.session };
                  delete safeSession.refresh_token;  // Web: remove refresh_token
                  return safeSession;
                })();
            
            if (isJsonClient(request)) {
              if (setCookie) reply.header('set-cookie', setCookie);
              const body = {
                message: result.message,
                user: result.user,
                token: sessionForResponse,
                ...signupProfileFields,
              };
              console.log('[sign-up] Response to FE', {
                status: 201,
                jsonClient: true,
                setCookie: Boolean(setCookie),
                body: {
                  message: body.message,
                  user: userSummaryForLog(body.user),
                  token: redactSessionForLog(body.token),
                  ...signupProfileFields,
                },
              });
              return reply.status(201).send(body);
            } else {
              if (setCookie) reply.header('set-cookie', setCookie);
              const body = {
                user: result.user,
                token: sessionForResponse,
                ...signupProfileFields,
              };
              console.log('[sign-up] Response to FE', {
                status: 201,
                jsonClient: false,
                setCookie: Boolean(setCookie),
                body: {
                  user: userSummaryForLog(body.user),
                  token: redactSessionForLog(body.token),
                  ...signupProfileFields,
                },
              });
              return reply.status(201).send(body);
            }
          } else {
            // Email confirmation required
            const body = {
              message: result.message,
              user: result.user,
              session: null,
              ...signupProfileFields,
            };
            console.log('[sign-up] Response to FE', {
              status: 201,
              body: {
                message: body.message,
                user: userSummaryForLog(body.user),
                session: body.session,
                ...signupProfileFields,
              },
            });
            return reply.status(201).send(body);
          }
        }

        case 'sign-in': {
          validation = authSignInRequestSchema.safeParse(request.body);
          if (!validation.success) {
            return reply.status(400).send({ error: serializeZodError(validation.error) });
          }

          // Bot-protection soft rollout (docs/AUTH_BOT_PROTECTION.md).
          // Verify-if-present: the beta login page sends a Turnstile token; the
          // stable page omits it. When present we verify server-side and reject
          // on failure. Absent token = stable path, proceeds unverified for now.
          const { turnstileToken, channel } = validation.data;
          if (turnstileToken) {
            const turnstile = await verifyTurnstile(turnstileToken, {
              remoteip: request.ip,
            });
            console.log('[sign-in] Turnstile check', {
              channel: channel || 'unspecified',
              success: turnstile.success,
              reason: turnstile.reason,
            });
            if (!turnstile.success) {
              // Generic message; do not leak Cloudflare error codes to clients.
              return reply.status(400).send({
                error: 'Verification failed. Please retry the challenge.',
              });
            }
          }

          const result = await authController.signIn(email, password);
          
          if (!result.success) {
            return reply.status(401).send({ error: result.error });
          }

          // Create wrapper JWT with tid for cookie
          let wrapper = null;
          if (result.tid) {
            try {
              wrapper = authController.createRefreshWrapper(result.user.id, result.tid);
              console.log('[sign-in] Wrapper JWT created for tid:', result.tid);
              console.log('[sign-in] Wrapper JWT value:', wrapper);
              console.log('[sign-in] Wrapper JWT length:', wrapper.length);
            } catch (err) {
              console.error('[sign-in] Failed to create wrapper JWT:', err);
            }
          }
          
          const setCookie = wrapper ? authController.makeRefreshCookie(wrapper) : '';
          console.log('[sign-in] Set-Cookie header value:', setCookie);
          
          // For mobile (JSON) clients: include refresh_token in response
          // For web clients: exclude refresh_token, use HTTP-only cookie instead
          const sessionForResponse = isJsonClient(request)
            ? result.session  // Mobile: return full session with refresh_token
            : (() => {
                const safeSession = { ...result.session };
                delete safeSession.refresh_token;  // Web: remove refresh_token
                return safeSession;
              })();
          
          console.log('[sign-in] sessionForResponse keys:', Object.keys(sessionForResponse));
          console.log('[sign-in] sessionForResponse.access_token:', sessionForResponse.access_token ? `${String(sessionForResponse.access_token).slice(0, 50)}...` : 'MISSING');
          
          if (isJsonClient(request)) {
            if (setCookie) reply.header('set-cookie', setCookie);
            return reply.status(200).send({
              message: 'Signed in successfully',
              user: result.user,
              token: sessionForResponse,
              tid: result.tid,
            });
          } else {
            if (setCookie) reply.header('set-cookie', setCookie);
            return reply.status(200).send({
              user: result.user,
              token: sessionForResponse,
              tid: result.tid,
            });
          }
        }

        case 'sign-out': {
          validation = authSignOutRequestSchema.safeParse(request.body);
          if (!validation.success) {
            return reply.status(400).send({ error: serializeZodError(validation.error) });
          }
          // Get user from auth header
          const authHeader = getAuthHeader(request);
          const tokenCheck = await authController.checkTokenValidity(authHeader);

          if (!tokenCheck.success) {
            return reply.status(401).send({ error: 'Not authenticated' });
          }

          // Get refresh token from cookie
          const refreshTokenFromCookie = request.cookies.refresh_token || null;
          const result = await authController.signOut(tokenCheck.user.id, refreshTokenFromCookie);

          if (!result.success) {
            return reply.status(500).send({ error: result.error });
          }

          // Clear cookie
          const clearCookie = authController.makeRefreshCookie('', { maxAge: 0 });
          reply.header('set-cookie', clearCookie);
          return reply.status(200).send({ message: 'Signed out successfully' });
        }

        case 'check-validity': {
          validation = authCheckValidityRequestSchema.safeParse(request.body);
          if (!validation.success) {
            return reply.status(400).send({ error: serializeZodError(validation.error) });
          }
          const authHeader = getAuthHeader(request);
          const result = await authController.checkTokenValidity(authHeader);

          if (!result.success) {
            return reply.status(401).send({ error: result.error });
          }

          return reply.status(200).send({
            valid: true,
            message: 'Token is valid',
            user: result.user,
          });
        }

        case 'resend': {
          validation = authResendRequestSchema.safeParse(request.body);
          if (!validation.success) {
            return reply.status(400).send({ error: serializeZodError(validation.error) });
          }
          const result = await authController.resendConfirmationEmail(
            email,
            emailRedirectTo
          );

          if (!result.success) {
            return reply.status(400).send({ error: result.error });
          }

          return reply.status(200).send({
            message: 'Confirmation email sent',
          });
        }

        case 'forgot-password': {
          validation = authForgotPasswordRequestSchema.safeParse(request.body);
          if (!validation.success) {
            return reply.status(400).send({ error: serializeZodError(validation.error) });
          }

          const result = await authController.forgotPassword(validation.data.email, {
            redirectTo: validation.data.redirectTo,
          });

          // Security: never reveal whether an email exists. Always 200 on "handled".
          if (!result.success) {
            console.error('[forgot-password] Error:', result.error);
          }

          return reply.status(200).send({
            message:
              'If an account exists for that email, password reset instructions have been sent.',
          });
        }

        case 'confirm-forgot-password': {
          validation = authConfirmForgotPasswordRequestSchema.safeParse(request.body);
          if (!validation.success) {
            return reply.status(400).send({ error: serializeZodError(validation.error) });
          }

          const { email: resetEmail, code, newPassword } = validation.data;
          const result = await authController.confirmForgotPassword(resetEmail, code, newPassword);

          if (!result.success) {
            return reply.status(400).send({ error: result.error });
          }

          return reply.status(200).send({
            message: 'Password has been reset successfully',
          });
        }

        default: {
          return reply.status(400).send({
            error: `Unknown action: ${action}. Must be one of: sign-up, sign-in, sign-out, check-validity, resend, forgot-password, confirm-forgot-password`,
          });
        }
      }
    } catch (err) {
      console.error('[POST /auth] Error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * POST /auth/refresh
   * Refreshes access token using refresh token from cookie (web) or body (mobile)
   * Returns new access token with new wrapper JWT (token rotation)
   * 
   * Web: Cookie contains signed wrapper JWT
   * Mobile: Body contains { refresh_token: "raw_supabase_token" }
   */
  fastify.post('/auth/refresh', async (request, reply) => {
    try {
      // Get refresh token from body (mobile) or cookie (web)
      const wrapperFromBody = request.body?.refresh_token;
      const wrapperFromCookie = request.cookies.refresh_token;
      const wrapper = wrapperFromBody || wrapperFromCookie;

      if (!wrapper) {
        return reply.status(401).send({ error: 'No refresh token provided' });
      }

      const isFromMobile = !!wrapperFromBody;

      // Mobile path: exchange raw token with Supabase
      if (isFromMobile) {
        const exchangeResult = await authController.exchangeRawRefreshTokenWithSupabase(wrapper);
        if (!exchangeResult.success) {
          return reply.status(401).send({ error: 'Token exchange failed' });
        }

        const userId =
          (await authController.resolveAppUserIdFromAccessToken(exchangeResult.accessToken)) ||
          authController.extractUserIdFromAccessToken(exchangeResult.accessToken);
        if (!userId) {
          return reply.status(401).send({ error: 'Token exchange failed' });
        }
        const storeResult = await authController.storeAndWrapNewRefreshToken(exchangeResult.refreshToken, userId);
        
        if (!storeResult.success) {
          return reply.status(500).send({ error: 'Token storage failed' });
        }

        // Set cookie for mobile (may be ignored)
        reply.setCookie('refresh_token', storeResult.wrapper, {
          httpOnly: true,
          secure: process.env.REFRESH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
          sameSite: (process.env.REFRESH_COOKIE_SAMESITE || 'lax').toLowerCase(),
          path: '/',
          maxAge: Number(process.env.REFRESH_MAX_AGE_SECONDS || 3 * 24 * 3600),
        });

        const user = await authController.resolveRefreshResponseUser(exchangeResult.accessToken);
        if (!user) {
          return reply.status(401).send({ error: 'Token exchange failed' });
        }

        return reply.status(200).send({
          accessToken: exchangeResult.accessToken,
          refreshToken: exchangeResult.refreshToken,
          user,
        });
      }

      // Web path: validate wrapper JWT and exchange stored token
      const result = await authController.refreshRefreshToken(wrapper, fastify.log);

      if (!result.success) {
        // Clear invalid cookie
        reply.setCookie('refresh_token', '', {
          httpOnly: true,
          secure: process.env.REFRESH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
          sameSite: (process.env.REFRESH_COOKIE_SAMESITE || 'lax').toLowerCase(),
          path: '/',
          maxAge: 0,
        });
        return reply.status(401).send({ error: result.error });
      }

      // Use app user id from refresh flow (wrapper sub for web; Cognito access token sub is cognito_sub)
      const userId = result.userId || authController.extractUserIdFromAccessToken(result.accessToken);
      if (!userId) {
        return reply.status(401).send({ error: result.error || 'invalid_refresh' });
      }
      const newWrapper = authController.createRefreshWrapper(userId, result.newTokenId);

      // Set new refresh token cookie
      const REFRESH_MAX_AGE_SECONDS = Number(process.env.REFRESH_MAX_AGE_SECONDS || 3 * 24 * 3600);
      const REFRESH_COOKIE_SAMESITE = (process.env.REFRESH_COOKIE_SAMESITE || 'lax').toLowerCase();
      const REFRESH_COOKIE_SECURE = process.env.REFRESH_COOKIE_SECURE
        ? process.env.REFRESH_COOKIE_SECURE === 'true'
        : process.env.NODE_ENV === 'production';
      const REFRESH_COOKIE_DOMAIN = process.env.REFRESH_COOKIE_DOMAIN || undefined;

      reply.setCookie('refresh_token', newWrapper, {
        httpOnly: true,
        secure: REFRESH_COOKIE_SECURE,
        sameSite: REFRESH_COOKIE_SAMESITE,
        path: '/',
        maxAge: REFRESH_MAX_AGE_SECONDS,
        ...(REFRESH_COOKIE_DOMAIN && { domain: REFRESH_COOKIE_DOMAIN }),
      });

      const user = await authController.resolveRefreshResponseUser(result.accessToken);
      if (!user) {
        return reply.status(401).send({ error: result.error || 'invalid_refresh' });
      }

      return reply.status(200).send({
        accessToken: result.accessToken,
        user,
      });
    } catch (err) {
      fastify.log.error('[POST /auth/refresh] Error:', err);
      return reply.status(500).send({ error: 'Refresh failed' });
    }
  });

  /**
   * GET /auth/cookie-status
   * Checks if refresh token cookie is valid and present
   * Used for detecting incognito/private browsing mode
   */
  fastify.get('/auth/cookie-status', async (request, reply) => {
    try {
      const wrapper = request.cookies.refresh_token || null;
      
      if (!wrapper) {
        return reply.status(200).send({ cookiePresent: false });
      }

      console.log('[GET /auth/cookie-status] Checking cookie validity');
      const result = await authController.checkRefreshCookieStatus(wrapper);

      return reply.status(200).send({
        cookiePresent: result.cookiePresent,
      });
    } catch (err) {
      console.error('[GET /auth/cookie-status] Error:', err);
      return reply.status(200).send({ cookiePresent: false });
    }
  });
}

export default fp(authRoutes);
