import { authenticateAccessToken } from './authenticateAccessToken.js';

/**
 * Extracts and verifies the JWT token from the request headers.
 * @param {object} req - The Next.js API request object.
 * @returns {Promise<{ user: object|null, error: string|null }>} - Returns a promise that resolves to an object containing the user and any error message.
 */
export async function authenticateRequest(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (!token) {
    return { user: null, error: 'JWT Token is required' };
  }

  return authenticateAccessToken(token);
}
