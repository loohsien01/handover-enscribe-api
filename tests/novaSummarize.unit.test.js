import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  novaCompletionContextUsageRatio,
  novaPresetContextLimitTokens,
} from '../src/utils/bedrockClaudeModels.js';
import { getNovaChatCompletionRequestBody } from '../src/utils/claudeRequestBody.js';
import { novaPriorDialogMessagesForBedrock } from '../src/utils/novaRedisSession.js';
import {
  applyNovaSummarizeDeltaWithModel,
  mergeNovaRollingSummary,
  pickMessagesForSummarize,
  shouldEnqueueNovaSummarize,
} from '../src/utils/novaSummarizeService.js';

test('novaPresetContextLimitTokens returns positive for presets', () => {
  assert.ok(novaPresetContextLimitTokens('haiku') > 0);
  assert.ok(novaPresetContextLimitTokens('sonnet') > 0);
});

test('novaCompletionContextUsageRatio uses input_tokens / limit', () => {
  const limit = novaPresetContextLimitTokens('haiku');
  const ratio = novaCompletionContextUsageRatio({ input_tokens: Math.floor(limit * 0.71) }, 'haiku');
  assert.ok(ratio >= 0.7 && ratio < 0.75);
});

test('shouldEnqueueNovaSummarize is false when summarize_pending', () => {
  const limit = novaPresetContextLimitTokens('haiku');
  const session = {
    chat_id: 'x',
    messages: [],
    summary: '',
    last_active: 0,
    token_estimate: 0,
    summarize_pending: true,
    summary_covered_message_count: 0,
  };
  assert.equal(shouldEnqueueNovaSummarize(session, { input_tokens: limit }, 'haiku'), false);
});

test('shouldEnqueueNovaSummarize when ratio crosses default threshold', () => {
  const limit = novaPresetContextLimitTokens('haiku');
  const session = {
    chat_id: 'x',
    messages: [],
    summary: '',
    last_active: 0,
    token_estimate: 0,
    summarize_pending: false,
    summary_covered_message_count: 0,
  };
  assert.equal(
    shouldEnqueueNovaSummarize(session, { input_tokens: Math.floor(limit * 0.71) }, 'haiku'),
    true
  );
});

test('pickMessagesForSummarize respects char cap with whole messages', () => {
  const msgs = [
    { role: 'user', content: 'a'.repeat(80) },
    { role: 'assistant', content: 'b'.repeat(80) },
  ];
  const picked = pickMessagesForSummarize(msgs, 200);
  assert.ok(picked.length >= 1);
  assert.ok(picked.length <= msgs.length);
});

test('mergeNovaRollingSummary caps total length', () => {
  const merged = mergeNovaRollingSummary('hello', 'world', 8);
  assert.equal(merged.length, 8);
});

test('novaPriorDialogMessagesForBedrock: empty tail when checkpoint covers all messages', () => {
  const session = {
    chat_id: 'x',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
    summary: 'S',
    summary_covered_message_count: 2,
    summarize_pending: false,
    last_active: 0,
    token_estimate: 0,
  };
  assert.deepEqual(novaPriorDialogMessagesForBedrock(session), []);
});

test('novaPriorDialogMessagesForBedrock: only messages since checkpoint', () => {
  const session = {
    chat_id: 'x',
    messages: [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old2' },
      { role: 'user', content: 'new' },
    ],
    summary: 'folded',
    summary_covered_message_count: 2,
    summarize_pending: false,
    last_active: 0,
    token_estimate: 0,
  };
  const tail = novaPriorDialogMessagesForBedrock(session);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].content, 'new');
});

test('completion request: summarized history → dialog is new user turn only', () => {
  const session = {
    chat_id: 'x',
    messages: [
      { role: 'user', content: 'long ago' },
      { role: 'assistant', content: 'reply' },
    ],
    summary: 'Folded thread.',
    summary_covered_message_count: 2,
    last_active: 0,
    token_estimate: 0,
    summarize_pending: false,
  };
  const prior = novaPriorDialogMessagesForBedrock(session);
  const body = getNovaChatCompletionRequestBody({
    modelId: 'mid',
    summary: session.summary,
    priorMessages: prior,
    userMessage: 'Fresh question',
  });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, 'Fresh question');
  assert.ok(body.system.some((b) => String(b.text).includes('Folded thread')));
});

test('applyNovaSummarizeDeltaWithModel: multi-turn clinical excerpt → merged summary + checkpoint', async () => {
  const session = {
    chat_id: '00000000-0000-4000-8000-000000000001',
    messages: [
      { role: 'user', content: 'Follow-up: blood pressure still 150s on home cuff.' },
      {
        role: 'assistant',
        content: 'Are you taking metoprolol as prescribed? Any dizziness or edema?',
      },
      { role: 'user', content: 'Yes daily; no edema; occasional lightheadedness in AM.' },
      {
        role: 'assistant',
        content: 'Consider morning BP log for 1 week; discuss titration with PCP if sustained.',
      },
    ],
    summary: '',
    last_active: 0,
    token_estimate: 0,
    summary_covered_message_count: 0,
    summarize_pending: true,
  };

  const mockInvoke = async (reqBody) => {
    const userContent = String(reqBody.messages?.[0]?.content ?? '');
    assert.ok(userContent.includes('blood pressure'), 'prompt should include user clinical detail');
    assert.ok(userContent.includes('metoprolol'), 'prompt should include assistant follow-up');
    assert.ok(userContent.includes('lightheadedness'), 'prompt should include second user turn');
    assert.ok(Array.isArray(reqBody.system) && reqBody.system.length >= 1);
    return {
      text: 'HTN follow-up: home BP 150s; adherent metoprolol; AM lightheadedness; plan BP diary and titration review.',
    };
  };

  const result = await applyNovaSummarizeDeltaWithModel(session, mockInvoke);
  assert.deepEqual(result, { ok: true, didSummarize: true });
  assert.ok(session.summary.includes('HTN follow-up'));
  assert.ok(session.summary.includes('metoprolol'));
  assert.equal(session.summary_covered_message_count, 4);
  assert.equal(session.summarize_pending, false);
});

test('applyNovaSummarizeDeltaWithModel: only messages after checkpoint are sent to model', async () => {
  const session = {
    chat_id: '00000000-0000-4000-8000-000000000002',
    messages: [
      { role: 'user', content: 'Prior: allergy to penicillin noted.' },
      { role: 'assistant', content: 'Acknowledged; will avoid beta-lactams.' },
      { role: 'user', content: 'New: started azithromycin yesterday for sinusitis.' },
      { role: 'assistant', content: 'Watch for QT symptoms; finish course unless rash.' },
    ],
    summary: 'EARLIER: penicillin allergy documented.',
    last_active: 0,
    token_estimate: 0,
    summary_covered_message_count: 2,
    summarize_pending: true,
  };

  const mockInvoke = async (reqBody) => {
    const userContent = String(reqBody.messages?.[0]?.content ?? '');
    assert.ok(userContent.includes('azithromycin'), 'delta should include new user message');
    assert.ok(!userContent.includes('penicillin'), 'prior-summary segment should not be in summarizer user blob');
    return { text: 'NEW: azithromycin for sinusitis; counsel on QT/rash.' };
  };

  const result = await applyNovaSummarizeDeltaWithModel(session, mockInvoke);
  assert.deepEqual(result, { ok: true, didSummarize: true });
  assert.ok(session.summary.includes('EARLIER: penicillin'));
  assert.ok(session.summary.includes('NEW: azithromycin'));
  assert.ok(session.summary.includes('---'));
  assert.equal(session.summary_covered_message_count, 4);
  assert.equal(session.summarize_pending, false);
});

test('applyNovaSummarizeDeltaWithModel: empty model text → failure', async () => {
  const session = {
    chat_id: '00000000-0000-4000-8000-000000000003',
    messages: [{ role: 'user', content: 'Any red flags for chest pain?' }],
    summary: '',
    last_active: 0,
    token_estimate: 0,
    summary_covered_message_count: 0,
    summarize_pending: true,
  };

  const result = await applyNovaSummarizeDeltaWithModel(session, async () => ({ text: '   ' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'empty_model_output');
  assert.equal(session.summarize_pending, true);
});

test('applyNovaSummarizeDeltaWithModel: no delta → skip without calling model', async () => {
  const session = {
    chat_id: '00000000-0000-4000-8000-000000000004',
    messages: [{ role: 'user', content: 'Hi' }],
    summary: 'Already folded.',
    last_active: 0,
    token_estimate: 0,
    summary_covered_message_count: 1,
    summarize_pending: true,
  };

  let called = 0;
  const result = await applyNovaSummarizeDeltaWithModel(session, async () => {
    called += 1;
    return { text: 'should not run' };
  });
  assert.deepEqual(result, { ok: true, didSummarize: false });
  assert.equal(called, 0);
  assert.equal(session.summarize_pending, false);
});
