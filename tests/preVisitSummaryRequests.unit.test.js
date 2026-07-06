import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  preVisitSummaryCreateRequestSchema,
  preVisitSummaryPatchRequestSchema,
} from '../src/fastify/schemas/preVisitSummaryRequests.js';
import { NOVA_CHAT_TITLE_MAX_LENGTH } from '../src/utils/novaChatTitle.js';

const CHAT_ID = '660e8400-e29b-41d4-a716-446655440001';

test('preVisitSummaryCreateRequestSchema accepts optional title', () => {
  const withTitle = preVisitSummaryCreateRequestSchema.safeParse({
    chat_id: CHAT_ID,
    text: 'body',
    title: 'Jane Doe F/U 7/6/26',
  });
  assert.equal(withTitle.success, true);
  assert.equal(withTitle.data.title, 'Jane Doe F/U 7/6/26');

  const withoutTitle = preVisitSummaryCreateRequestSchema.safeParse({
    chat_id: CHAT_ID,
  });
  assert.equal(withoutTitle.success, true);
  assert.equal(withoutTitle.data.title, undefined);
});

test('preVisitSummaryCreateRequestSchema rejects empty title', () => {
  const result = preVisitSummaryCreateRequestSchema.safeParse({
    chat_id: CHAT_ID,
    title: '   ',
  });
  assert.equal(result.success, false);
});

test('preVisitSummaryPatchRequestSchema requires at least one of text or title', () => {
  assert.equal(preVisitSummaryPatchRequestSchema.safeParse({}).success, false);
  assert.equal(preVisitSummaryPatchRequestSchema.safeParse({ text: 'x' }).success, true);
  assert.equal(preVisitSummaryPatchRequestSchema.safeParse({ title: 'Jane Doe' }).success, true);
  assert.equal(
    preVisitSummaryPatchRequestSchema.safeParse({ text: 'x', title: 'Jane Doe' }).success,
    true
  );
});

test('preVisitSummaryPatchRequestSchema rejects overlong title', () => {
  const longTitle = 'x'.repeat(NOVA_CHAT_TITLE_MAX_LENGTH + 1);
  const result = preVisitSummaryPatchRequestSchema.safeParse({ title: longTitle });
  assert.equal(result.success, false);
});
