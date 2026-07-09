import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMAIL_ALREADY_REGISTERED_PAYLOAD,
  isEmailAlreadyRegistered,
} from '../src/utils/authEmailCheck.js';

test('EMAIL_ALREADY_REGISTERED_PAYLOAD shape', () => {
  assert.equal(EMAIL_ALREADY_REGISTERED_PAYLOAD.code, 'EMAIL_ALREADY_REGISTERED');
  assert.match(EMAIL_ALREADY_REGISTERED_PAYLOAD.error, /already exists/i);
});

test('isEmailAlreadyRegistered returns false for invalid email', async () => {
  assert.equal(await isEmailAlreadyRegistered(''), false);
  assert.equal(await isEmailAlreadyRegistered('not-an-email'), false);
});
