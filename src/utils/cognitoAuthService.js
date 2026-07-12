import crypto from 'crypto';
import {
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  getCognitoClientId,
  getCognitoIdpClient,
  getCognitoUserPoolId,
} from './cognitoClient.js';
import { decodeAccessTokenPayload } from './cognitoJwt.js';
import { resolveAppUserFromCognito } from './resolveAppUserFromCognito.js';
import { EMAIL_ALREADY_REGISTERED_PAYLOAD } from './authEmailCheck.js';

/**
 * @param {import('@aws-sdk/client-cognito-identity-provider').AuthenticationResultType | undefined} authResult
 */
export function mapCognitoAuthResultToSession(authResult) {
  if (!authResult?.AccessToken) return null;
  return {
    access_token: authResult.AccessToken,
    refresh_token: authResult.RefreshToken,
    expires_in: authResult.ExpiresIn,
    token_type: authResult.TokenType || 'Bearer',
  };
}

/**
 * @param {string} accessToken
 * @param {string} email
 */
async function resolveAppUserFromAccessToken(accessToken, email) {
  const payload = decodeAccessTokenPayload(accessToken);
  const cognitoSub = typeof payload?.sub === 'string' ? payload.sub : '';
  const emailHint =
    email ||
    (typeof payload?.email === 'string' ? payload.email : '') ||
    (typeof payload?.username === 'string' ? payload.username : '');
  return resolveAppUserFromCognito(cognitoSub, emailHint);
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function cognitoSignIn(email, password) {
  const client = getCognitoIdpClient();
  const out = await client.send(
    new AdminInitiateAuthCommand({
      UserPoolId: getCognitoUserPoolId(),
      ClientId: getCognitoClientId(),
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    })
  );

  if (out.ChallengeName) {
    return {
      success: false,
      error: `Sign-in challenge required: ${out.ChallengeName}`,
    };
  }

  const session = mapCognitoAuthResultToSession(out.AuthenticationResult);
  if (!session?.access_token) {
    return { success: false, error: 'No access token returned' };
  }

  const appUser = await resolveAppUserFromAccessToken(session.access_token, email);
  if (!appUser) {
    return {
      success: false,
      error: 'Account not linked. Contact support if this persists.',
    };
  }

  return {
    success: true,
    session,
    user: { id: appUser.id, email: appUser.email },
  };
}

/**
 * @param {string} email
 * @param {string} password
 * @param {string} [appUserId] - Pre-generated auth.users.id (Option A)
 */
export async function cognitoSignUp(email, password, appUserId = crypto.randomUUID()) {
  const client = getCognitoIdpClient();

  let signUpOut;
  try {
    signUpOut = await client.send(
      new SignUpCommand({
        ClientId: getCognitoClientId(),
        Username: email,
        Password: password,
        UserAttributes: [{ Name: 'email', Value: email }],
      })
    );
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (name === 'UsernameExistsException') {
      return {
        success: false,
        status: 409,
        error: EMAIL_ALREADY_REGISTERED_PAYLOAD.error,
        code: EMAIL_ALREADY_REGISTERED_PAYLOAD.code,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }

  const cognitoSub = signUpOut.UserSub || null;
  const userConfirmed = Boolean(signUpOut.UserConfirmed);

  return {
    success: true,
    user: { id: appUserId, email },
    session: null,
    cognitoSub,
    userConfirmed,
  };
}

/**
 * Compensating delete after sign-up Postgres bundle failure (best-effort).
 * @param {string} email - Cognito username (email sign-up)
 */
export async function cognitoAdminDeleteUser(email) {
  if (!email) return { ok: true, skipped: true };

  try {
    const client = getCognitoIdpClient();
    await client.send(
      new AdminDeleteUserCommand({
        UserPoolId: getCognitoUserPoolId(),
        Username: email,
      })
    );
    return { ok: true };
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (name === 'UserNotFoundException') {
      return { ok: true, skipped: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cognitoAdminDeleteUser] Failed:', message);
    return { ok: false, error: message };
  }
}

/**
 * @param {string} accessToken
 */
export async function cognitoGlobalSignOut(accessToken) {
  if (!accessToken) return { success: true };
  try {
    const client = getCognitoIdpClient();
    await client.send(
      new GlobalSignOutCommand({
        AccessToken: accessToken,
      })
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cognitoGlobalSignOut] Error:', message);
    return { success: false, error: message };
  }
}

/**
 * @param {string} email
 */
export async function cognitoResendConfirmationCode(email) {
  const client = getCognitoIdpClient();
  try {
    await client.send(
      new ResendConfirmationCodeCommand({
        ClientId: getCognitoClientId(),
        Username: email,
      })
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Confirm a new user's email with the verification code from SignUp / ResendConfirmationCode.
 * @param {string} email
 * @param {string} code
 */
export async function cognitoConfirmSignUp(email, code) {
  const client = getCognitoIdpClient();
  try {
    await client.send(
      new ConfirmSignUpCommand({
        ClientId: getCognitoClientId(),
        Username: email,
        ConfirmationCode: code,
      })
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * @param {string} email
 */
export async function cognitoForgotPassword(email) {
  const client = getCognitoIdpClient();
  try {
    await client.send(
      new ForgotPasswordCommand({
        ClientId: getCognitoClientId(),
        Username: email,
      })
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cognitoForgotPassword] Error:', message);
    return { success: false, error: message };
  }
}

/**
 * @param {string} email
 * @param {string} code
 * @param {string} newPassword
 */
export async function cognitoConfirmForgotPassword(email, code, newPassword) {
  const client = getCognitoIdpClient();
  try {
    await client.send(
      new ConfirmForgotPasswordCommand({
        ClientId: getCognitoClientId(),
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
      })
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * @param {string} rawRefreshToken
 */
export async function cognitoRefreshTokens(rawRefreshToken) {
  const client = getCognitoIdpClient();
  const out = await client.send(
    new InitiateAuthCommand({
      ClientId: getCognitoClientId(),
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: rawRefreshToken,
      },
    })
  );

  const session = mapCognitoAuthResultToSession(out.AuthenticationResult);
  if (!session?.access_token) {
    return { success: false, error: 'No access token from Cognito refresh' };
  }

  return {
    success: true,
    accessToken: session.access_token,
    refreshToken: session.refresh_token || rawRefreshToken,
  };
}

/**
 * Resolve canonical app user id from a Cognito access token.
 * @param {string} accessToken
 */
export async function resolveAppUserIdFromAccessToken(accessToken) {
  const payload = decodeAccessTokenPayload(accessToken);
  if (!payload?.sub) return null;
  const emailHint =
    (typeof payload.email === 'string' && payload.email) ||
    (typeof payload.username === 'string' && payload.username) ||
    undefined;
  const appUser = await resolveAppUserFromCognito(String(payload.sub), emailHint);
  return appUser?.id ?? null;
}
