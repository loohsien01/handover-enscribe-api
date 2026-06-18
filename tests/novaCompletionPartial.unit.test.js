import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyClaudeBedrockStreamChunk } from '../src/utils/bedrockClient.js';
import {
  NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS,
  NOVA_COMPLETION_PARTIAL_TTL_SEC,
  createNovaCompletionPartialWriter,
  enrichNovaCompletionPollWithPartial,
  isNovaCompletionPartialEnabled,
  novaCompletionPartialRedisKey,
  readNovaCompletionPartial,
  writeNovaCompletionPartial,
} from '../src/utils/novaCompletionPartial.js';

function mockRedis() {
  /** @type {Map<string, string>} */
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, opts) {
      store.set(key, value);
      return opts;
    },
    async del(key) {
      store.delete(key);
    },
  };
}

test('novaCompletionPartialRedisKey scopes by job id', () => {
  assert.equal(novaCompletionPartialRedisKey('job-1'), 'nova:completion:partial:job-1');
});

test('isNovaCompletionPartialEnabled is false only when NOVA_COMPLETION_PARTIAL=0', () => {
  const prev = process.env.NOVA_COMPLETION_PARTIAL;
  try {
    delete process.env.NOVA_COMPLETION_PARTIAL;
    assert.equal(isNovaCompletionPartialEnabled(), true);
    process.env.NOVA_COMPLETION_PARTIAL = '0';
    assert.equal(isNovaCompletionPartialEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.NOVA_COMPLETION_PARTIAL;
    else process.env.NOVA_COMPLETION_PARTIAL = prev;
  }
});

test('read/writeNovaCompletionPartial round-trips text and revision', async () => {
  const redis = mockRedis();
  const jobId = '11111111-1111-4111-8111-111111111111';
  await writeNovaCompletionPartial(redis, jobId, 'Hello', 1);
  const partial = await readNovaCompletionPartial(redis, jobId);
  assert.deepEqual(partial, { text: 'Hello', revision: 1 });
  const raw = redis.store.get(novaCompletionPartialRedisKey(jobId));
  assert.ok(raw);
  const written = await redis.set(novaCompletionPartialRedisKey(jobId), raw, { EX: NOVA_COMPLETION_PARTIAL_TTL_SEC });
  assert.equal(written.EX, NOVA_COMPLETION_PARTIAL_TTL_SEC);
});

test('enrichNovaCompletionPollWithPartial attaches partial on running', async () => {
  const prev = process.env.NOVA_COMPLETION_PARTIAL;
  process.env.NOVA_COMPLETION_PARTIAL = '1';
  try {
    const redis = mockRedis();
    const jobId = '22222222-2222-4222-8222-222222222222';
    await writeNovaCompletionPartial(redis, jobId, 'Partial reply', 3);
    const payload = await enrichNovaCompletionPollWithPartial(
      redis,
      { id: jobId, status: 'running' },
      { id: jobId, status: 'running', chat_id: 'chat-1' }
    );
    assert.equal(payload.assistant_partial, 'Partial reply');
    assert.equal(payload.partial_revision, 3);
    assert.ok(redis.store.has(novaCompletionPartialRedisKey(jobId)));
  } finally {
    if (prev === undefined) delete process.env.NOVA_COMPLETION_PARTIAL;
    else process.env.NOVA_COMPLETION_PARTIAL = prev;
  }
});

test('enrichNovaCompletionPollWithPartial attaches then deletes partial on failed', async () => {
  const prev = process.env.NOVA_COMPLETION_PARTIAL;
  process.env.NOVA_COMPLETION_PARTIAL = '1';
  try {
    const redis = mockRedis();
    const jobId = '33333333-3333-4333-8333-333333333333';
    await writeNovaCompletionPartial(redis, jobId, 'Cut off', 2);
    const payload = await enrichNovaCompletionPollWithPartial(
      redis,
      { id: jobId, status: 'failed' },
      { id: jobId, status: 'failed', chat_id: 'chat-1', code: 'X', error: 'y' }
    );
    assert.equal(payload.assistant_partial, 'Cut off');
    assert.equal(payload.partial_revision, 2);
    assert.equal(redis.store.has(novaCompletionPartialRedisKey(jobId)), false);
  } finally {
    if (prev === undefined) delete process.env.NOVA_COMPLETION_PARTIAL;
    else process.env.NOVA_COMPLETION_PARTIAL = prev;
  }
});

test('enrichNovaCompletionPollWithPartial is no-op when disabled', async () => {
  const prev = process.env.NOVA_COMPLETION_PARTIAL;
  process.env.NOVA_COMPLETION_PARTIAL = '0';
  try {
    const redis = mockRedis();
    const jobId = '44444444-4444-4444-8444-444444444444';
    await writeNovaCompletionPartial(redis, jobId, 'Hidden', 1);
    const payload = await enrichNovaCompletionPollWithPartial(
      redis,
      { id: jobId, status: 'running' },
      { id: jobId, status: 'running', chat_id: 'chat-1' }
    );
    assert.equal(payload.assistant_partial, undefined);
    assert.equal(payload.partial_revision, undefined);
  } finally {
    if (prev === undefined) delete process.env.NOVA_COMPLETION_PARTIAL;
    else process.env.NOVA_COMPLETION_PARTIAL = prev;
  }
});

test('createNovaCompletionPartialWriter debounces Redis writes', async () => {
  const prev = process.env.NOVA_COMPLETION_PARTIAL;
  process.env.NOVA_COMPLETION_PARTIAL = '1';
  const prevNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const redis = mockRedis();
    const jobId = '55555555-5555-4555-8555-555555555555';
    const writer = createNovaCompletionPartialWriter(redis, jobId);

    writer.onText('A');
    await new Promise((r) => setImmediate(r));
    assert.equal((await readNovaCompletionPartial(redis, jobId))?.revision, 1);

    now += NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS - 1;
    writer.onText('AB');
    assert.equal((await readNovaCompletionPartial(redis, jobId))?.text, 'A');

    now += NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS;
    await new Promise((r) => setTimeout(r, NOVA_COMPLETION_PARTIAL_DEBOUNCE_MS + 20));
    assert.equal((await readNovaCompletionPartial(redis, jobId))?.text, 'AB');
    assert.equal((await readNovaCompletionPartial(redis, jobId))?.revision, 2);

    await writer.flush('Final');
    assert.deepEqual(await readNovaCompletionPartial(redis, jobId), {
      text: 'Final',
      revision: 3,
    });
  } finally {
    Date.now = prevNow;
    if (prev === undefined) delete process.env.NOVA_COMPLETION_PARTIAL;
    else process.env.NOVA_COMPLETION_PARTIAL = prev;
  }
});

test('applyClaudeBedrockStreamChunk accumulates text and usage', () => {
  const state = { text: '', inputTokens: null, outputTokens: null };
  applyClaudeBedrockStreamChunk(
    { type: 'message_start', message: { usage: { input_tokens: 12 } } },
    state
  );
  applyClaudeBedrockStreamChunk(
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    state
  );
  applyClaudeBedrockStreamChunk(
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
    state
  );
  applyClaudeBedrockStreamChunk(
    { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'end_turn' } },
    state
  );
  assert.equal(state.text, 'Hi there');
  assert.equal(state.inputTokens, 12);
  assert.equal(state.outputTokens, 5);
  assert.equal(state.stopReason, 'end_turn');
});
