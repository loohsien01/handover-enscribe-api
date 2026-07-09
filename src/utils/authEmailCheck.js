import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { pgQueryOne } from './pgQueryHelpers.js';
import { isCognitoAuth } from './authProvider.js';
import { getCognitoIdpClient, getCognitoUserPoolId } from './cognitoClient.js';
import supabaseAdmin from './supabaseAdmin.js';

export const EMAIL_ALREADY_REGISTERED_PAYLOAD = {
  error: 'An account with this email already exists',
  code: 'EMAIL_ALREADY_REGISTERED',
};

const SELECT_EMAIL_SQL = `
  SELECT 1 AS registered
  FROM auth.users
  WHERE lower(email) = lower($1)
  LIMIT 1
`;

/**
 * @param {string} email
 * @returns {Promise<boolean | null>} true/false when known; null when Postgres lookup unavailable
 */
async function isEmailInAuthUsersTable(email) {
  try {
    const row = await pgQueryOne(SELECT_EMAIL_SQL, [email.trim()]);
    return Boolean(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[isEmailAlreadyRegistered] Postgres lookup failed:', message);
    return null;
  }
}

/**
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function isEmailInCognito(email) {
  try {
    const client = getCognitoIdpClient();
    await client.send(
      new AdminGetUserCommand({
        UserPoolId: getCognitoUserPoolId(),
        Username: email.trim(),
      })
    );
    return true;
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
    if (name === 'UserNotFoundException') {
      return false;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[isEmailAlreadyRegistered] Cognito AdminGetUser failed:', message);
    throw err;
  }
}

/**
 * Slow fallback when direct Postgres to auth.users is unavailable.
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function isEmailInSupabaseAdminList(email) {
  const admin = supabaseAdmin();
  const target = email.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;

  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`auth.admin.listUsers: ${error.message}`);
    }

    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return true;
    if (users.length < perPage) return false;

    page += 1;
    if (page > 50) {
      console.warn(
        '[isEmailAlreadyRegistered] listUsers fallback stopped after 50 pages; treating email as available.'
      );
      return false;
    }
  }
}

/**
 * Server-side check before sign-up. Rejects duplicate email with no auth or profile writes.
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function isEmailAlreadyRegistered(email) {
  const normalized = email?.trim();
  if (!normalized || !normalized.includes('@')) {
    return false;
  }

  if (isCognitoAuth()) {
    if (await isEmailInCognito(normalized)) {
      return true;
    }
    const pgResult = await isEmailInAuthUsersTable(normalized);
    return pgResult === true;
  }

  const pgResult = await isEmailInAuthUsersTable(normalized);
  if (pgResult !== null) {
    return pgResult;
  }

  return isEmailInSupabaseAdminList(normalized);
}
