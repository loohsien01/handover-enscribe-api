/**
 * Optional Redis connection for session cache (Nova AI) and similar.
 *
 * Set REDIS_URL in .env.local (e.g. redis://127.0.0.1:6379). If unset, {@link getRedisClient}
 * returns null so the rest of the API can run without Redis.
 *
 * If REDIS_URL is set but the server is unreachable, {@link getRedisClient} returns null after
 * a failed connect (no process crash). Retries are throttled so Nova routes return 503 without
 * reconnect spam. Set REDIS_VERBOSE=1 to log transient client errors (throttled).
 *
 * Production: use rediss:// with ElastiCache when TLS is enabled; auth belongs in the URL
 * or use ElastiCache IAM auth when you wire that path.
 */

import { createClient } from 'redis';

/** @type {import('redis').RedisClientType | null} */
let client = null;

/** @type {Promise<import('redis').RedisClientType | null> | null} */
let connectPromise = null;

/** After a failed connect, wait before trying again (avoids log + TCP storms on every request). */
let connectRetryNotBefore = 0;

const CONNECT_RETRY_COOLDOWN_MS = 60_000;

let lastVerboseRedisErrorLog = 0;

/** Avoid repeating the same connect-failure line until we succeed once. */
let loggedConnectFailureThisRun = false;

export function getRedisUrl() {
  const u = process.env.REDIS_URL;
  return typeof u === 'string' ? u.trim() : '';
}

/**
 * Shared Redis client, or null if REDIS_URL is not configured or Redis is unavailable.
 * Never throws; safe to call from request handlers.
 * @returns {Promise<import('redis').RedisClientType | null>}
 */
export async function getRedisClient() {
  const url = getRedisUrl();
  if (!url) return null;

  if (client?.isOpen) return client;

  const now = Date.now();
  if (now < connectRetryNotBefore) {
    return null;
  }

  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    /** @type {import('redis').RedisClientType | undefined} */
    let c;
    try {
      c = createClient({
        url,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 25) return false;
            return Math.min(retries * 100, 3000);
          },
        },
      });

      // Must attach a listener — otherwise "Unhandled error event" can crash the process.
      // Default: silent; node-redis handles reconnect. Opt-in: REDIS_VERBOSE=1 (throttled).
      c.on('error', (err) => {
        if (process.env.REDIS_VERBOSE !== '1') return;
        const t = Date.now();
        if (t - lastVerboseRedisErrorLog < 60_000) return;
        lastVerboseRedisErrorLog = t;
        console.warn('[redis] (verbose, 1/min max)', err.message);
      });

      await c.connect();
      client = c;
      connectRetryNotBefore = 0;
      loggedConnectFailureThisRun = false;
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      connectRetryNotBefore = Date.now() + CONNECT_RETRY_COOLDOWN_MS;
      if (!loggedConnectFailureThisRun) {
        loggedConnectFailureThisRun = true;
        console.warn(
          `[redis] Connect failed — Nova hot-cache disabled (retries throttled). ${msg} — On hosts without Redis, omit REDIS_URL; set REDIS_VERBOSE=1 for transient error traces.`
        );
      }
      try {
        if (c && c.isOpen) {
          await c.quit();
        } else if (c) {
          c.disconnect();
        }
      } catch {
        // ignore teardown errors
      }
      client = null;
      return null;
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
