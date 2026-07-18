import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmptyNovaSession,
  novaSessionDelete,
  novaSessionGet,
  novaSessionRedisKey,
  novaSessionSave,
} from '../src/utils/novaRedisSession.js';

function mockRedis() {
  /** @type {Map<string, string>} */
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

test('novaSessionRedisKey scopes by user and chat', () => {
  assert.equal(novaSessionRedisKey('user-1', 'chat-1'), 'nova:chat:user-1:chat-1');
});

test('novaSessionDelete removes the hot session key', async () => {
  const redis = mockRedis();
  const userId = 'user-del';
  const chatId = 'chat-del';
  const session = createEmptyNovaSession(chatId, 'Linked PVS chat');

  await novaSessionSave(redis, userId, session, 3600);
  assert.ok(await novaSessionGet(redis, userId, chatId));

  await novaSessionDelete(redis, userId, chatId);
  assert.equal(await novaSessionGet(redis, userId, chatId), null);
  assert.equal(redis.store.has(novaSessionRedisKey(userId, chatId)), false);
});

test('novaSessionDelete is a no-op when the key is already absent', async () => {
  const redis = mockRedis();
  await novaSessionDelete(redis, 'user-x', 'chat-missing');
  assert.equal(redis.store.size, 0);
});
