import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSupabasePostgresUrl } from '../src/utils/supabasePostgresUrl.js';
import {
  isLocalRdsTunnelTarget,
  isRdsPostgresTarget,
} from '../src/utils/postgresConnection.js';

const RDS_URL =
  'postgresql://enscribe_app:secret@enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com:5432/enscribe?sslmode=require';
const LOCAL_TUNNEL_URL =
  'postgresql://enscribe_app:secret@127.0.0.1:15432/enscribe?sslmode=require';
const SUPABASE_URL =
  'postgresql://postgres.ref:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

/**
 * @param {Record<string, string | undefined>} env
 * @param {() => void} fn
 */
function withEnv(env, fn) {
  const prev = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('getSupabasePostgresUrl prefers DATABASE_URL_LOCAL in development', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      DATABASE_URL_LOCAL: LOCAL_TUNNEL_URL,
      DATABASE_URL: RDS_URL,
      SUPABASE_DB_DIRECT_URL: SUPABASE_URL,
    },
    () => {
      assert.equal(getSupabasePostgresUrl(), LOCAL_TUNNEL_URL);
    }
  );
});

test('getSupabasePostgresUrl ignores DATABASE_URL_LOCAL in production', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL_LOCAL: LOCAL_TUNNEL_URL,
      DATABASE_URL: RDS_URL,
      SUPABASE_DB_DIRECT_URL: undefined,
    },
    () => {
      assert.equal(getSupabasePostgresUrl(), RDS_URL);
    }
  );
});

test('isRdsPostgresTarget is true for local tunnel when DATABASE_URL is RDS', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      DATABASE_URL_LOCAL: LOCAL_TUNNEL_URL,
      DATABASE_URL: RDS_URL,
      SUPABASE_DB_DIRECT_URL: undefined,
    },
    () => {
      assert.equal(isLocalRdsTunnelTarget('127.0.0.1'), true);
      assert.equal(isRdsPostgresTarget(), true);
    }
  );
});

test('isRdsPostgresTarget is false when only Supabase legacy URL is set', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      DATABASE_URL_LOCAL: undefined,
      DATABASE_URL: undefined,
      SUPABASE_DB_DIRECT_URL: SUPABASE_URL,
    },
    () => {
      assert.equal(isRdsPostgresTarget(), false);
    }
  );
});
