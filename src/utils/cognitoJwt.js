import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getCognitoClientId, getCognitoUserPoolId } from './cognitoClient.js';

/** @type {ReturnType<typeof CognitoJwtVerifier.create> | null} */
let verifier = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: getCognitoUserPoolId(),
      tokenUse: 'access',
      clientId: getCognitoClientId(),
    });
  }
  return verifier;
}

/**
 * Verify Cognito access JWT locally (JWKS cached by aws-jwt-verify).
 * @param {string} token
 * @returns {Promise<Record<string, unknown>>} payload; `sub` is cognito_sub (not auth.users.id)
 */
export async function verifyAccessToken(token) {
  return getVerifier().verify(token);
}

/**
 * Decode JWT payload without verification — only use on tokens just issued by Cognito API.
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
export function decodeAccessTokenPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
