import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NOVA_CHAT_DEFAULT_TITLE,
  NOVA_CHAT_TITLE_MAX_LENGTH,
  normalizeNovaChatTitle,
  pickFirstTurnForNovaChatTitle,
  postProcessAiNovaChatTitle,
  truncateNovaChatTitle,
} from '../src/utils/novaChatTitle.js';
import { getNovaChatTitleRequestBody } from '../src/utils/claudeRequestBody.js';
import { generateNovaChatTitleWithModel } from '../src/utils/novaChatTitleService.js';
import { normalizeNovaSessionShape, createEmptyNovaSession } from '../src/utils/novaRedisSession.js';

test('createEmptyNovaSession defaults title to New Chat', () => {
  const s = createEmptyNovaSession('id');
  assert.equal(s.title, NOVA_CHAT_DEFAULT_TITLE);
});

test('createEmptyNovaSession accepts custom title', () => {
  const s = createEmptyNovaSession('id', 'Custom');
  assert.equal(s.title, 'Custom');
});

test('normalizeNovaSessionShape backfills missing title', () => {
  const s = normalizeNovaSessionShape({
    chat_id: 'x',
    messages: [],
    summary: '',
    last_active: 0,
    token_estimate: 0,
  });
  assert.equal(s?.title, NOVA_CHAT_DEFAULT_TITLE);
});

test('normalizeNovaChatTitle trims and caps length', () => {
  assert.equal(normalizeNovaChatTitle('  BP follow-up  '), 'BP follow-up');
  const long = 'a'.repeat(50);
  assert.equal(normalizeNovaChatTitle(long).length, NOVA_CHAT_TITLE_MAX_LENGTH);
});

test('truncateNovaChatTitle prefers word boundary', () => {
  const t = truncateNovaChatTitle('Hypertension medication adjustment plan', 30);
  assert.ok(t.length <= 30);
  assert.ok(!t.endsWith('adjust'));
});

test('postProcessAiNovaChatTitle strips quotes and title prefix', () => {
  assert.equal(postProcessAiNovaChatTitle('"Penicillin allergy"'), 'Penicillin allergy');
  assert.equal(postProcessAiNovaChatTitle("Title: Contract review"), 'Contract review');
});

test('pickFirstTurnForNovaChatTitle finds first user and assistant', () => {
  const picked = pickFirstTurnForNovaChatTitle([
    { role: 'system', content: 'ignored' },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
  ]);
  assert.equal(picked.userMessage, 'Q1');
  assert.equal(picked.assistantMessage, 'A1');
});

test('getNovaChatTitleRequestBody includes first-turn context', () => {
  const body = getNovaChatTitleRequestBody({
    modelId: 'haiku-test',
    userMessage: 'Hello',
    assistantMessage: 'Hi',
  });
  assert.equal(body.modelId, 'haiku-test');
  assert.ok(String(body.messages[0].content).includes('Hello'));
  assert.ok(String(body.messages[0].content).includes('Hi'));
});

test('generateNovaChatTitleWithModel uses injectable invokeModel', async () => {
  const title = await generateNovaChatTitleWithModel('user q', 'assistant a', async () => ({
    text: 'Medication refill question',
  }));
  assert.equal(title, 'Medication refill question');
});

test('generateNovaChatTitleWithModel returns null when model output is empty', async () => {
  const title = await generateNovaChatTitleWithModel('u', 'a', async () => ({ text: '   ' }));
  assert.equal(title, null);
});
