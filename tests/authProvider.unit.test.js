import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getAuthProvider,
  isCognitoAuth,
  isSupabaseAuth,
} from '../src/utils/authProvider.js';

test('getAuthProvider defaults to supabase', () => {
  const prev = process.env.AUTH_PROVIDER;
  delete process.env.AUTH_PROVIDER;
  try {
    assert.equal(getAuthProvider(), 'supabase');
    assert.equal(isSupabaseAuth(), true);
    assert.equal(isCognitoAuth(), false);
  } finally {
    if (prev === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = prev;
  }
});

test('getAuthProvider returns cognito when configured', () => {
  const prev = process.env.AUTH_PROVIDER;
  process.env.AUTH_PROVIDER = 'cognito';
  try {
    assert.equal(getAuthProvider(), 'cognito');
    assert.equal(isCognitoAuth(), true);
    assert.equal(isSupabaseAuth(), false);
  } finally {
    if (prev === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = prev;
  }
});
