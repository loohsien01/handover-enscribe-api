import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  verifyTurnstile,
  isTurnstileConfigured,
} from '../src/utils/turnstile.js';

const SECRET_KEYS = [
  'CLOUDFLARE_TURNSTILE_SECRET_KEY',
  'TURNSTILE_SECRET_KEY',
];

function snapshotSecrets() {
  const prev = {};
  for (const k of SECRET_KEYS) prev[k] = process.env[k];
  return prev;
}

function restoreSecrets(prev) {
  for (const k of SECRET_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

function withMockedFetch(impl, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  return (async () => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  })();
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('isTurnstileConfigured reflects secret presence', () => {
  const prev = snapshotSecrets();
  try {
    delete process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    assert.equal(isTurnstileConfigured(), false);

    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
    assert.equal(isTurnstileConfigured(), true);
  } finally {
    restoreSecrets(prev);
  }
});

test('missing token fails closed without calling siteverify', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  let called = false;
  try {
    await withMockedFetch(
      async () => {
        called = true;
        return jsonResponse({ success: true });
      },
      async () => {
        const r = await verifyTurnstile('');
        assert.equal(r.success, false);
        assert.equal(r.reason, 'missing_token');
      },
    );
    assert.equal(called, false, 'siteverify should not be called for empty token');
  } finally {
    restoreSecrets(prev);
  }
});

test('missing secret fails closed', async () => {
  const prev = snapshotSecrets();
  delete process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  try {
    await withMockedFetch(
      async () => jsonResponse({ success: true }),
      async () => {
        const r = await verifyTurnstile('some-token');
        assert.equal(r.success, false);
        assert.equal(r.reason, 'missing_secret');
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('valid token verified by siteverify returns success', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    let sentBody = null;
    await withMockedFetch(
      async (url, init) => {
        assert.match(url, /siteverify/);
        sentBody = init.body;
        return jsonResponse({ success: true });
      },
      async () => {
        const r = await verifyTurnstile('good-token', { remoteip: '203.0.113.5' });
        assert.equal(r.success, true);
      },
    );
    const params = new URLSearchParams(sentBody);
    assert.equal(params.get('secret'), 'sk_test');
    assert.equal(params.get('response'), 'good-token');
    assert.equal(params.get('remoteip'), '203.0.113.5');
  } finally {
    restoreSecrets(prev);
  }
});

test('valid token returns the siteverify action', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      async () => jsonResponse({ success: true, action: 'sign-in' }),
      async () => {
        const r = await verifyTurnstile('good-token');
        assert.equal(r.success, true);
        assert.equal(r.action, 'sign-in');
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('expectedAction match passes', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      async () => jsonResponse({ success: true, action: 'sign-up' }),
      async () => {
        const r = await verifyTurnstile('good-token', { expectedAction: 'sign-up' });
        assert.equal(r.success, true);
        assert.equal(r.action, 'sign-up');
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('expectedAction mismatch fails closed', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      async () => jsonResponse({ success: true, action: 'sign-in' }),
      async () => {
        const r = await verifyTurnstile('good-token', { expectedAction: 'sign-up' });
        assert.equal(r.success, false);
        assert.equal(r.reason, 'action_mismatch');
        assert.equal(r.action, 'sign-in');
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('siteverify success:false surfaces error codes and fails', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      async () =>
        jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }),
      async () => {
        const r = await verifyTurnstile('bad-token');
        assert.equal(r.success, false);
        assert.equal(r.reason, 'verification_failed');
        assert.deepEqual(r.errorCodes, ['invalid-input-response']);
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('non-2xx siteverify response fails closed', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      async () => jsonResponse({}, { ok: false, status: 500 }),
      async () => {
        const r = await verifyTurnstile('any-token');
        assert.equal(r.success, false);
        assert.equal(r.reason, 'http_500');
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('network error fails closed', async () => {
  const prev = snapshotSecrets();
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      async () => {
        throw new Error('boom');
      },
      async () => {
        const r = await verifyTurnstile('any-token');
        assert.equal(r.success, false);
        assert.equal(r.reason, 'network_error');
      },
    );
  } finally {
    restoreSecrets(prev);
  }
});

test('non-prod bypass token succeeds without calling siteverify', async () => {
  const prevSecrets = snapshotSecrets();
  const prevEnv = process.env.NODE_ENV;
  const prevBypass = process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN;
  process.env.NODE_ENV = 'development';
  process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN = 'bypass-123';
  // No secret configured: bypass must short-circuit before the secret check.
  delete process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  let called = false;
  try {
    await withMockedFetch(
      async () => {
        called = true;
        return jsonResponse({ success: true });
      },
      async () => {
        const r = await verifyTurnstile('bypass-123', { expectedAction: 'sign-in' });
        assert.equal(r.success, true);
        assert.equal(r.bypass, true);
        // expectedAction is satisfied by the bypass.
        assert.equal(r.action, 'sign-in');
      },
    );
    assert.equal(called, false, 'siteverify should not be called for the bypass token');
  } finally {
    restoreSecrets(prevSecrets);
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevBypass === undefined) delete process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN;
    else process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN = prevBypass;
  }
});

test('bypass token is ignored in production (fails closed)', async () => {
  const prevSecrets = snapshotSecrets();
  const prevEnv = process.env.NODE_ENV;
  const prevBypass = process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN;
  process.env.NODE_ENV = 'production';
  process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN = 'bypass-123';
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'sk_test';
  try {
    await withMockedFetch(
      // In production the bypass is inert; the token is sent to siteverify, which
      // (mocked) rejects it — proving no bypass path exists in prod.
      async () => jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }),
      async () => {
        const r = await verifyTurnstile('bypass-123', { expectedAction: 'sign-in' });
        assert.equal(r.success, false);
        assert.notEqual(r.bypass, true);
      },
    );
  } finally {
    restoreSecrets(prevSecrets);
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevBypass === undefined) delete process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN;
    else process.env.CLOUDFLARE_TURNSTILE_TEST_BYPASS_TOKEN = prevBypass;
  }
});
