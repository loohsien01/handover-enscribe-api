import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  rollbackSignupPostgresBundle,
  updateAuthUsersCognitoSub,
} from '../src/utils/signupPersistence.js';

test('rollbackSignupPostgresBundle deletes profile and auth.users on RDS', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  /** @type {string[]} */
  const calls = [];

  const result = await rollbackSignupPostgresBundle(userId, {
    isRdsTarget: () => true,
    query: async (sql, params) => {
      calls.push(String(sql));
      assert.equal(params[0], userId);
      return { rowCount: 1, rows: [] };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /DELETE FROM public\."userProfiles"/i);
  assert.match(calls[1], /DELETE FROM auth\.users/i);
});

test('updateAuthUsersCognitoSub skips when not RDS target', async () => {
  let queryCalled = false;
  const result = await updateAuthUsersCognitoSub('id', 'a@b.com', 'sub', {
    isRdsTarget: () => false,
    query: async () => {
      queryCalled = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(queryCalled, false);
});
