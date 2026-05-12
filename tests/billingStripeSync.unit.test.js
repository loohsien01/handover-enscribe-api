import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { derivePlanKeyFromSubscription } from '../src/utils/billingStripeSync.js';

const envKey = 'STRIPE_PRICE_PRO_MONTHLY';
const saved = process.env[envKey];

afterEach(() => {
  if (saved === undefined) delete process.env[envKey];
  else process.env[envKey] = saved;
});

function baseSubscription(overrides = {}) {
  return {
    id: 'sub_test',
    status: 'active',
    items: { data: [{ price: { id: 'price_pro_monthly' } }] },
    ...overrides,
  };
}

test('derivePlanKeyFromSubscription: canceled -> free', () => {
  process.env[envKey] = 'price_pro_monthly';
  assert.equal(
    derivePlanKeyFromSubscription(baseSubscription({ status: 'canceled' })),
    'free',
  );
});

test('derivePlanKeyFromSubscription: active + matching env price -> pro', () => {
  process.env[envKey] = 'price_pro_monthly';
  assert.equal(derivePlanKeyFromSubscription(baseSubscription()), 'pro');
});

test('derivePlanKeyFromSubscription: active + different price -> free', () => {
  process.env[envKey] = 'price_pro_monthly';
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      derivePlanKeyFromSubscription(
        baseSubscription({
          items: { data: [{ price: { id: 'price_annual_other' } }] },
        }),
      ),
      'free',
    );
  } finally {
    console.warn = prevWarn;
  }
});

test('derivePlanKeyFromSubscription: trialing + string price ref -> pro', () => {
  process.env[envKey] = 'price_pro_monthly';
  assert.equal(
    derivePlanKeyFromSubscription(
      baseSubscription({
        status: 'trialing',
        items: { data: [{ price: 'price_pro_monthly' }] },
      }),
    ),
    'pro',
  );
});
