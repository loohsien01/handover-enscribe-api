import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPgHost,
  isRdsPostgresHost,
  isRdsPostgresTarget,
  isSupabasePostgresHost,
  resolveSslAndConnectionString,
  resetRdsCaBundleCacheForTests,
} from '../src/utils/postgresConnection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RDS_CA_PATH = path.join(__dirname, '../certs/rds-global-bundle.crt');

test('extractPgHost parses standard postgresql URI', () => {
  assert.equal(
    extractPgHost('postgresql://user:pass@enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com:5432/enscribe'),
    'enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com'
  );
  assert.equal(
    extractPgHost('postgresql://postgres.ref:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres'),
    'aws-0-us-east-1.pooler.supabase.com'
  );
});

test('isSupabasePostgresHost recognizes Supabase pooler and db hosts', () => {
  assert.equal(isSupabasePostgresHost('aws-0-us-east-1.pooler.supabase.com'), true);
  assert.equal(isSupabasePostgresHost('db.abcdef.supabase.co'), true);
  assert.equal(isSupabasePostgresHost('enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com'), false);
});

test('isRdsPostgresHost recognizes RDS endpoints', () => {
  assert.equal(isRdsPostgresHost('enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com'), true);
  assert.equal(isRdsPostgresHost('aws-0-us-east-1.pooler.supabase.com'), false);
  assert.equal(isRdsPostgresHost(''), false);
});

test('resolveSslAndConnectionString: RDS host uses strict TLS with bundled CA', () => {
  resetRdsCaBundleCacheForTests(null);
  const rdsUrl =
    'postgresql://enscribe_app:secret@enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com:5432/enscribe?sslmode=require';
  const prev = process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
  delete process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;

  try {
    const { ssl, connectionString } = resolveSslAndConnectionString(rdsUrl);
    assert.equal(ssl?.rejectUnauthorized, true);
    assert.ok(typeof ssl?.ca === 'string' && ssl.ca.includes('BEGIN CERTIFICATE'));
    assert.equal(connectionString, rdsUrl);
    assert.ok(fs.existsSync(RDS_CA_PATH), 'bundled RDS CA file should exist');
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
    else process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED = prev;
    resetRdsCaBundleCacheForTests(null);
  }
});

test('resolveSslAndConnectionString: Supabase host relaxes TLS by default', () => {
  const supabaseUrl =
    'postgresql://postgres.ref:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require';
  const prev = process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
  delete process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;

  try {
    const { ssl, connectionString } = resolveSslAndConnectionString(supabaseUrl);
    assert.equal(ssl?.rejectUnauthorized, false);
    assert.equal(connectionString.includes('sslmode='), false);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
    else process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED = prev;
  }
});

test('resolveSslAndConnectionString: explicit false disables verify even on RDS', () => {
  const rdsUrl =
    'postgresql://enscribe_app:secret@enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com:5432/enscribe?sslmode=require';
  const prev = process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
  process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED = 'false';

  try {
    const { ssl, connectionString } = resolveSslAndConnectionString(rdsUrl);
    assert.equal(ssl?.rejectUnauthorized, false);
    assert.equal(connectionString.includes('sslmode='), false);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED;
    else process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED = prev;
  }
});

test('isRdsPostgresTarget reflects resolved env URL host', () => {
  const prevDirect = process.env.SUPABASE_DB_DIRECT_URL;
  const prevDatabase = process.env.DATABASE_URL;

  process.env.SUPABASE_DB_DIRECT_URL =
    'postgresql://postgres.ref:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
  delete process.env.DATABASE_URL;
  assert.equal(isRdsPostgresTarget(), false);

  process.env.SUPABASE_DB_DIRECT_URL =
    'postgresql://enscribe_app:secret@enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com:5432/enscribe';
  assert.equal(isRdsPostgresTarget(), true);

  if (prevDirect === undefined) delete process.env.SUPABASE_DB_DIRECT_URL;
  else process.env.SUPABASE_DB_DIRECT_URL = prevDirect;
  if (prevDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabase;
});
