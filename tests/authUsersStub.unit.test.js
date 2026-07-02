import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureAuthUsersStubAfterSignup } from '../src/utils/authUsersStub.js';

test('ensureAuthUsersStubAfterSignup skips when Postgres target is not RDS', async () => {
  let queryCalled = false;
  const result = await ensureAuthUsersStubAfterSignup('11111111-1111-4111-8111-111111111111', 'a@b.com', {
    isRdsTarget: () => false,
    query: async () => {
      queryCalled = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_rds_target');
  assert.equal(queryCalled, false);
});

test('ensureAuthUsersStubAfterSignup skips when userId or email missing', async () => {
  let queryCalled = false;
  const result = await ensureAuthUsersStubAfterSignup('', 'a@b.com', {
    isRdsTarget: () => true,
    query: async () => {
      queryCalled = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'missing_fields');
  assert.equal(queryCalled, false);
});

test('ensureAuthUsersStubAfterSignup inserts stub on RDS target', async () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const email = 'newuser@example.com';
  /** @type {unknown[][]} */
  const calls = [];

  const result = await ensureAuthUsersStubAfterSignup(userId, email, {
    isRdsTarget: () => true,
    query: async (sql, params) => {
      calls.push([sql, params]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /INSERT INTO auth\.users/i);
  assert.deepEqual(calls[0][1], [userId, email]);
});

test('ensureAuthUsersStubAfterSignup inserts stub with cognito_sub on RDS target', async () => {
  const userId = '44444444-4444-4444-8444-444444444444';
  const email = 'cognito@example.com';
  const cognitoSub = 'cognito-sub-abc';
  /** @type {unknown[][]} */
  const calls = [];

  const result = await ensureAuthUsersStubAfterSignup(userId, email, cognitoSub, {
    isRdsTarget: () => true,
    query: async (sql, params) => {
      calls.push([sql, params]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /cognito_sub/i);
  assert.deepEqual(calls[0][1], [userId, email, cognitoSub]);
});

test('ensureAuthUsersStubAfterSignup returns error without throwing when insert fails', async () => {
  const result = await ensureAuthUsersStubAfterSignup('33333333-3333-4333-8333-333333333333', 'x@y.com', {
    isRdsTarget: () => true,
    query: async () => {
      throw new Error('relation "auth.users" does not exist');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /auth\.users/);
});
