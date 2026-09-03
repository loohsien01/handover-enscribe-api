import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCognitoChangePasswordError } from '../src/utils/cognitoAuthService.js';

function cognitoErr(name, message = '') {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

test('wrong previous password maps to 401', () => {
  const mapped = mapCognitoChangePasswordError(
    cognitoErr('NotAuthorizedException', 'Incorrect username or password.')
  );
  assert.equal(mapped.status, 401);
  assert.equal(mapped.error, 'Current password is incorrect');
});

test('invalid access token maps to 401 Not authenticated', () => {
  const mapped = mapCognitoChangePasswordError(
    cognitoErr('NotAuthorizedException', 'Invalid Access Token')
  );
  assert.equal(mapped.status, 401);
  assert.equal(mapped.error, 'Not authenticated');
});

test('weak proposed password maps to 400', () => {
  const mapped = mapCognitoChangePasswordError(cognitoErr('InvalidPasswordException'));
  assert.equal(mapped.status, 400);
  assert.match(mapped.error, /password requirements/i);
});

test('rate limit maps to 429', () => {
  const mapped = mapCognitoChangePasswordError(cognitoErr('LimitExceededException'));
  assert.equal(mapped.status, 429);
});

test('unknown Cognito error maps to 500 without leaking the name', () => {
  const mapped = mapCognitoChangePasswordError(cognitoErr('AccessDeniedException', 'not authorized'));
  assert.equal(mapped.status, 500);
  assert.equal(mapped.error, 'Unable to change password');
});
