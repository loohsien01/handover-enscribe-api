import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_UI_EXPERIENCE_VERSION,
  computeEntitlements,
  organizationHasProPlan,
} from '../src/utils/billingEntitlements.js';

test('organizationHasProPlan: true only for pro + active/trialing', () => {
  assert.equal(organizationHasProPlan(null), false);
  assert.equal(organizationHasProPlan({}), false);
  assert.equal(organizationHasProPlan({ plan_key: 'free', subscription_status: 'active' }), false);
  assert.equal(organizationHasProPlan({ plan_key: 'pro', subscription_status: 'none' }), false);
  assert.equal(organizationHasProPlan({ plan_key: 'pro', subscription_status: 'past_due' }), false);
  assert.equal(organizationHasProPlan({ plan_key: 'pro', subscription_status: 'active' }), true);
  assert.equal(organizationHasProPlan({ plan_key: 'pro', subscription_status: 'trialing' }), true);
});

test('computeEntitlements: free user with no internal access -> not entitled, stable UI', () => {
  const e = computeEntitlements({
    userId: 'u1',
    org: { plan_key: 'free', subscription_status: 'none' },
    internalAccess: null,
  });
  assert.equal(e.user_id, 'u1');
  assert.equal(e.entitled, false);
  assert.equal(e.entitlement_source, 'none');
  assert.equal(e.has_pro_plan, false);
  assert.equal(e.has_internal_access, false);
  assert.equal(e.ui_experience_version, DEFAULT_UI_EXPERIENCE_VERSION);
  assert.equal(e.internal_access_expires_at, null);
});

test('computeEntitlements: pro subscriber -> entitled via subscription, stable UI', () => {
  const e = computeEntitlements({
    userId: 'u2',
    org: { plan_key: 'pro', subscription_status: 'active' },
    internalAccess: null,
  });
  assert.equal(e.entitled, true);
  assert.equal(e.entitlement_source, 'subscription');
  assert.equal(e.has_pro_plan, true);
  assert.equal(e.has_internal_access, false);
  assert.equal(e.ui_experience_version, DEFAULT_UI_EXPERIENCE_VERSION);
});

test('computeEntitlements: active internal access trumps subscription source and unlocks beta UI', () => {
  const e = computeEntitlements({
    userId: 'u3',
    org: { plan_key: 'free', subscription_status: 'none' },
    internalAccess: {
      active: true,
      ui_experience_version: 'beta',
      expires_at: '2030-01-01T00:00:00.000Z',
    },
  });
  assert.equal(e.entitled, true);
  assert.equal(e.entitlement_source, 'internal_access');
  assert.equal(e.has_internal_access, true);
  assert.equal(e.ui_experience_version, 'beta');
  assert.equal(e.internal_access_expires_at, '2030-01-01T00:00:00.000Z');
});

test('computeEntitlements: expired internal access falls back to subscription + stable UI', () => {
  const e = computeEntitlements({
    userId: 'u4',
    org: { plan_key: 'pro', subscription_status: 'active' },
    internalAccess: {
      active: false,
      ui_experience_version: 'beta',
      expires_at: '2000-01-01T00:00:00.000Z',
    },
  });
  assert.equal(e.entitled, true);
  assert.equal(e.entitlement_source, 'subscription');
  assert.equal(e.has_internal_access, false);
  assert.equal(e.ui_experience_version, DEFAULT_UI_EXPERIENCE_VERSION);
  assert.equal(e.internal_access_expires_at, null);
});

test('computeEntitlements: no org + no internal access -> safe nulls and not entitled', () => {
  const e = computeEntitlements({});
  assert.equal(e.user_id, null);
  assert.equal(e.plan_key, null);
  assert.equal(e.subscription_status, null);
  assert.equal(e.entitled, false);
  assert.equal(e.entitlement_source, 'none');
  assert.equal(e.has_internal_access, false);
  assert.equal(e.has_pro_plan, false);
  assert.equal(e.ui_experience_version, DEFAULT_UI_EXPERIENCE_VERSION);
});
