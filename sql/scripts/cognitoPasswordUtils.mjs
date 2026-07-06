import crypto from 'node:crypto';

/**
 * Random password satisfying typical Cognito pools: 8+ chars, upper, lower, number, symbol.
 * Used for unknown permanent passwords before users set their own via Forgot password.
 *
 * @param {number} [length=24]
 * @returns {string}
 */
export function generateCognitoCompliantPassword(length = 24) {
  const minLen = Math.max(8, length);
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const pick = (chars) => chars[crypto.randomInt(chars.length)];

  /** @type {string[]} */
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const all = upper + lower + digits + symbols;
  while (chars.length < minLen) {
    chars.push(pick(all));
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}
