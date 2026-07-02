import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAppUserFromCognito } from '../src/utils/resolveAppUserFromCognito.js';

test('resolveAppUserFromCognito returns user by cognito_sub', async () => {
  const result = await resolveAppUserFromCognito('cognito-sub-1', 'a@b.com', {
    queryOne: async (sql, params) => {
      if (String(sql).includes('cognito_sub = $1')) {
        assert.deepEqual(params, ['cognito-sub-1']);
        return { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.com' };
      }
      return null;
    },
    query: async () => ({ rows: [] }),
  });

  assert.deepEqual(result, {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'a@b.com',
  });
});

test('resolveAppUserFromCognito falls back to email and links cognito_sub', async () => {
  /** @type {unknown[][]} */
  const updates = [];

  const result = await resolveAppUserFromCognito('new-sub', 'user@example.com', {
    queryOne: async (sql) => {
      if (String(sql).includes('cognito_sub = $1')) return null;
      if (String(sql).includes('lower(email)')) {
        return {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'user@example.com',
          cognito_sub: null,
        };
      }
      return null;
    },
    query: async (sql, params) => {
      updates.push([sql, params]);
      return { rows: [] };
    },
  });

  assert.deepEqual(result, {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'user@example.com',
  });
  assert.equal(updates.length, 1);
  assert.match(String(updates[0][0]), /UPDATE auth\.users/i);
  assert.deepEqual(updates[0][1], ['new-sub', '22222222-2222-4222-8222-222222222222']);
});

test('resolveAppUserFromCognito returns null when no mapping exists', async () => {
  const result = await resolveAppUserFromCognito('orphan-sub', undefined, {
    queryOne: async () => null,
    query: async () => ({ rows: [] }),
  });
  assert.equal(result, null);
});
