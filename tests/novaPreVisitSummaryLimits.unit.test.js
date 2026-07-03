import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRE_VISIT_SUMMARY_MAX_CHARS,
  PRE_VISIT_SUMMARY_TARGET_WORDS,
  NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS_DEFAULT,
  novaPreVisitSummaryTurn1MaxTokens,
} from '../src/utils/novaPreVisitSummaryLimits.js';

test('pre-visit summary length constants match architecture', () => {
  assert.equal(PRE_VISIT_SUMMARY_TARGET_WORDS, 350);
  assert.equal(PRE_VISIT_SUMMARY_MAX_CHARS, 1500);
  assert.equal(NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS_DEFAULT, 400);
});

test('novaPreVisitSummaryTurn1MaxTokens returns default when env unset', () => {
  const prev = process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
  delete process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
  try {
    assert.equal(novaPreVisitSummaryTurn1MaxTokens(), 400);
  } finally {
    if (prev !== undefined) {
      process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS = prev;
    }
  }
});

test('novaPreVisitSummaryTurn1MaxTokens respects env override within bounds', () => {
  const prev = process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
  process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS = '512';
  try {
    assert.equal(novaPreVisitSummaryTurn1MaxTokens(), 512);
  } finally {
    if (prev !== undefined) {
      process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS = prev;
    } else {
      delete process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
    }
  }
});

test('novaPreVisitSummaryTurn1MaxTokens rejects out-of-range env', () => {
  const prev = process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
  process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS = '99999';
  try {
    assert.equal(novaPreVisitSummaryTurn1MaxTokens(), 400);
  } finally {
    if (prev !== undefined) {
      process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS = prev;
    } else {
      delete process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
    }
  }
});
