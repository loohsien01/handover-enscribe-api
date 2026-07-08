import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  USAGE_METRICS,
  evaluateUsageAllowance,
  effectivePlanKeyForLimits,
  getCalendarMonthPeriod,
  resolveNovaUsageMetric,
} from '../src/utils/billingUsage.js';
import { organizationHasProPlan } from '../src/utils/billingEntitlements.js';

test('getCalendarMonthPeriod: UTC month boundaries', () => {
  const { periodStartIso, periodEndIso } = getCalendarMonthPeriod(new Date('2026-05-15T12:00:00Z'));
  assert.equal(periodStartIso, '2026-05-01T00:00:00.000Z');
  assert.equal(periodEndIso, '2026-06-01T00:00:00.000Z');
});

test('evaluateUsageAllowance: bypass and unlimited', () => {
  assert.deepEqual(evaluateUsageAllowance({ used: 99, limit: 10, bypass: true }), {
    allowed: true,
    used: 99,
    limit: null,
  });
  assert.deepEqual(evaluateUsageAllowance({ used: 99, limit: null }), {
    allowed: true,
    used: 99,
    limit: null,
  });
});

test('evaluateUsageAllowance: at or over cap', () => {
  assert.equal(evaluateUsageAllowance({ used: 9, limit: 10 }).allowed, true);
  assert.equal(evaluateUsageAllowance({ used: 10, limit: 10 }).allowed, false);
  assert.equal(evaluateUsageAllowance({ used: 11, limit: 10 }).allowed, false);
});

test('effectivePlanKeyForLimits: past_due stays on free limits', () => {
  assert.equal(
    effectivePlanKeyForLimits({ plan_key: 'pro', subscription_status: 'past_due' }),
    'free'
  );
  assert.equal(
    effectivePlanKeyForLimits({ plan_key: 'pro', subscription_status: 'active' }),
    'pro'
  );
  assert.equal(organizationHasProPlan({ plan_key: 'pro', subscription_status: 'past_due' }), false);
});

test('USAGE_METRICS constants', () => {
  assert.equal(USAGE_METRICS.NOTES_SAVED, 'notes_saved');
  assert.equal(USAGE_METRICS.NOVA_RESPONSE, 'nova_response');
  assert.equal(USAGE_METRICS.PRE_VISIT_SUMMARY, 'pre_visit_summary');
  assert.equal(USAGE_METRICS.PRE_VISIT_SUMMARY_CHAT_TURN, 'pre_visit_summary_chat_turn');
});

test('resolveNovaUsageMetric: pre-visit summary vs follow-up vs regular chat', () => {
  // Turn 1 save route → its own metric, regardless of existing summary row.
  assert.equal(
    resolveNovaUsageMetric({ savePreVisitSummary: true, chatHasPreVisitSummary: false }),
    'pre_visit_summary'
  );
  assert.equal(
    resolveNovaUsageMetric({ savePreVisitSummary: true, chatHasPreVisitSummary: true }),
    'pre_visit_summary'
  );
  // Follow-up turn in a chat that already has a summary.
  assert.equal(
    resolveNovaUsageMetric({ savePreVisitSummary: false, chatHasPreVisitSummary: true }),
    'pre_visit_summary_chat_turn'
  );
  // Regular Nova chat.
  assert.equal(
    resolveNovaUsageMetric({ savePreVisitSummary: false, chatHasPreVisitSummary: false }),
    'nova_response'
  );
  assert.equal(resolveNovaUsageMetric({}), 'nova_response');
});
