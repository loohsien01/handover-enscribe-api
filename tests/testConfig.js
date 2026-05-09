/**
 * Test Configuration
 * Loads test account credentials from environment variables
 * All credentials should be in .env.local (which is gitignored)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRedisConnectionUrl } from '../src/utils/redisClient.js';

// Load .env.local automatically
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

/**
 * Get test account credentials from environment
 */
export function getTestAccounts() {
  return {
    primary: {
      email: process.env.TEST_ACCOUNT_EMAIL,
      password: process.env.TEST_ACCOUNT_PASSWORD,
      description: 'Primary test account for sign-in/auth tests'
    }
  };
}

/**
 * Get single test account
 */
export function getTestAccount(name = 'primary') {
  const accounts = getTestAccounts();
  const account = accounts[name];
  
  if (!account || !account.email || !account.password) {
    console.warn(`⚠️  Test account '${name}' not configured in .env.local`);
    console.warn(`   Add these to .env.local:`);
    console.warn(`   TEST_ACCOUNT_EMAIL=your@email.com`);
    console.warn(`   TEST_ACCOUNT_PASSWORD=yourpassword`);
    return null;
  }
  
  return account;
}

/**
 * Check if test accounts are configured
 */
export function hasTestAccounts() {
  const primary = getTestAccount('primary');
  return !!primary;
}

/**
 * Confirmed user with profile (and ideally a personal org after billing migration).
 * Used by `tests/billing-org.test.js` — avoids sign-up / email verification.
 */
export function getBillingTestAccount() {
  const email = process.env.TEST_BILLING_ACCOUNT_EMAIL;
  const password = process.env.TEST_BILLING_ACCOUNT_PASSWORD;
  if (!email || !password) {
    return null;
  }
  return { email, password, description: 'Billing + organization API tests' };
}

export function hasBillingTestAccount() {
  return !!getBillingTestAccount();
}

/**
 * Get API base URL for tests
 * Can be overridden with API_BASE_URL environment variable
 * Default: http://localhost:3001 (local testing)
 * Production: https://api.enscribe.sjpedgi.doctor
 * 
 * Usage: API_BASE_URL=https://api.enscribe.sjpedgi.doctor npm test
 */
export function getApiBaseUrl() {
  return process.env.API_BASE_URL || 'http://localhost:3001';
}

/**
 * Redis URL from .env.local (same variable the Fastify server uses for Nova sessions).
 * @returns {string}
 */
export function getRedisUrlForTests() {
  return (getRedisConnectionUrl() || '').trim();
}

/**
 * Verifies REDIS_URL is set and a Redis server accepts PING (for Nova integration tests).
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function checkRedisReachableForTests() {
  const url = getRedisUrlForTests();
  if (!url) {
    return { ok: false, message: 'REDIS_URL is not set in .env.local.' };
  }
  try {
    const { createClient } = await import('redis');
    const client = createClient({
      url,
      socket: { connectTimeout: 8000 },
    });
    client.on('error', () => {});
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    if (pong !== 'PONG') {
      return { ok: false, message: `Unexpected PING reply: ${String(pong)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err && typeof err.message === 'string' ? err.message : String(err);
    return { ok: false, message: msg };
  }
}

/**
 * Log test account status (safe - only shows email prefix)
 */
export function logTestAccountStatus() {
  const account = getTestAccount('primary');
  if (!account) {
    console.log('❌ Test accounts not configured');
    return false;
  }
  
  const emailPrefix = account.email.split('@')[0];
  console.log(`✅ Test account configured: ${emailPrefix}@...`);
  return true;
}
