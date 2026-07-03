import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNovaBedrockModelId } from '../src/utils/bedrockClaudeModels.js';
import {
  getNovaChatCompletionRequestBody,
  getNovaSummarizeDeltaRequestBody,
  getSoapNoteRequestBody,
} from '../src/utils/claudeRequestBody.js';

test('resolveNovaBedrockModelId returns defaults for presets', () => {
  assert.match(resolveNovaBedrockModelId('haiku'), /haiku/i);
  assert.match(resolveNovaBedrockModelId('sonnet'), /sonnet/i);
  assert.match(resolveNovaBedrockModelId('opus'), /opus/i);
  assert.equal(resolveNovaBedrockModelId('unknown'), null);
});

test('getNovaChatCompletionRequestBody builds messages and system', () => {
  const body = getNovaChatCompletionRequestBody({
    modelId: 'us.anthropic.claude-haiku-test',
    summary: 'Prior topics: vitals.',
    priorMessages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ],
    userMessage: 'Next question?',
    max_tokens: 1000,
  });

  assert.equal(body.modelId, 'us.anthropic.claude-haiku-test');
  assert.equal(body.max_tokens, 1000);
  assert.ok(Array.isArray(body.system));
  assert.ok(body.system.some((b) => b.type === 'text' && String(b.text).includes('vitals')));
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[2], { role: 'user', content: 'Next question?' });
});

test('getNovaSummarizeDeltaRequestBody builds user blob from delta messages only', () => {
  const body = getNovaSummarizeDeltaRequestBody({
    modelId: 'us.anthropic.claude-haiku-test',
    deltaMessages: [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ],
    max_tokens: 512,
  });
  assert.equal(body.modelId, 'us.anthropic.claude-haiku-test');
  assert.equal(body.max_tokens, 512);
  assert.equal(body.messages.length, 1);
  assert.ok(String(body.messages[0].content).includes('Q1'));
  assert.ok(String(body.messages[0].content).includes('A1'));
});

test('getNovaChatCompletionRequestBody adds pre-visit summary plain-text guidance when forPreVisitSummary', () => {
  const body = getNovaChatCompletionRequestBody({
    modelId: 'm',
    summary: '',
    priorMessages: [],
    userMessage: 'Create pre-visit summary',
    forPreVisitSummary: true,
  });

  const systemText = body.system.map((b) => b.text).join('\n');
  assert.ok(systemText.includes('Pre-Visit Summary responses'));
  assert.ok(systemText.includes('plain, compact text instead of markdown'));
  assert.ok(systemText.includes('follow their instructions instead'));
  assert.ok(!systemText.includes('never more than 1500 characters'));
});

test('getNovaChatCompletionRequestBody adds Turn 1 length guidance when forPreVisitSummaryTurn1', () => {
  const body = getNovaChatCompletionRequestBody({
    modelId: 'm',
    summary: '',
    priorMessages: [],
    userMessage: 'Create pre-visit summary',
    forPreVisitSummary: true,
    forPreVisitSummaryTurn1: true,
  });

  const systemText = body.system.map((b) => b.text).join('\n');
  assert.ok(systemText.includes('never more than 1500 characters'));
  assert.ok(systemText.includes('about 350 words'));
});

test('getNovaChatCompletionRequestBody omits pre-visit summary guidance by default', () => {
  const body = getNovaChatCompletionRequestBody({
    modelId: 'm',
    summary: '',
    priorMessages: [],
    userMessage: 'Hello',
  });

  const systemText = body.system.map((b) => b.text).join('\n');
  assert.ok(!systemText.includes('Pre-Visit Summary responses'));
});

test('getNovaChatCompletionRequestBody hoists system-role history into system blocks', () => {
  const body = getNovaChatCompletionRequestBody({
    modelId: 'm',
    summary: '',
    priorMessages: [
      { role: 'system', content: 'Custom rule: be brief.' },
      { role: 'user', content: 'Q' },
    ],
    userMessage: 'Follow-up',
  });

  const systemText = body.system.map((b) => b.text).join('\n');
  assert.ok(systemText.includes('Custom rule'));
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'Q' },
    { role: 'user', content: 'Follow-up' },
  ]);
});

test('getSoapNoteRequestBody includes medication-name exception in system prompt', () => {
  const body = getSoapNoteRequestBody('Doctor: continue met Foreman ten milligrams daily.');
  const systemText = body.system.map((b) => b.text).join('\n');
  assert.ok(systemText.includes('Default: base the note solely on the encounter transcript'));
  assert.ok(systemText.includes('Exception (medication names only)'));
  assert.ok(systemText.includes('<dotphrase source="doctor">'));
  assert.ok(String(body.messages[0].content).includes('medication names only'));
});
