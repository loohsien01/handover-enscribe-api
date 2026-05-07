/**
 * Optional Redis connection for session cache (Nova AI) and similar.
 *
 * Set REDIS_URL in .env.local (e.g. redis://127.0.0.1:6379). If unset, {@link getRedisClient}
 * returns null so the rest of the API can run without Redis.
 *
 * Production: use rediss:// with ElastiCache when TLS is enabled; auth belongs in the URL
 * or use ElastiCache IAM auth when you wire that path.
 */

import { createClient } from 'redis';

/** @type {import('redis').RedisClientType | null} */
let client = null;

/** @type {Promise<import('redis').RedisClientType | null> | null} */
let connectPromise = null;

export function getRedisUrl() {
  const u = process.env.REDIS_URL;
  return typeof u === 'string' ? u.trim() : '';
}

/**
 * Shared Redis client, or null if REDIS_URL is not configured.
 * @returns {Promise<import('redis').RedisClientType | null>}
 */
export async function getRedisClient() {
  const url = getRedisUrl();
  if (!url) return null;

  if (client?.isOpen) return client;

  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const c = createClient({ url });
      c.on('error', (err) => {
        console.error('[redis] client error:', err.message);
      });
      await c.connect();
      client = c;
      return client;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

/**
 * Close the shared client if it was opened. Safe to call multiple times.
 */
export async function closeRedisClient() {
  if (!client?.isOpen) {
    client = null;
    return;
  }
  try {
    await client.quit();
  } catch {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  }
  client = null;
}
