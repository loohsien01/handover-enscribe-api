/**
 * Unit tests for pgQueryHelpers.js
 */
import assert from 'node:assert/strict';
import {
  pgErrorMessage,
  isPgUniqueViolation,
  toPgJsonbParam,
  pgIdToNumber,
  pgCoerceBigIntFields,
} from '../src/utils/pgQueryHelpers.js';

function testPgErrorMessage() {
  assert.equal(pgErrorMessage(new Error('boom')), 'boom');
  assert.equal(pgErrorMessage('plain'), 'plain');
  console.log('  pgErrorMessage — ok');
}

function testIsPgUniqueViolation() {
  assert.equal(isPgUniqueViolation({ code: '23505' }), true);
  assert.equal(isPgUniqueViolation({ code: '23503' }), false);
  assert.equal(isPgUniqueViolation(new Error('nope')), false);
  console.log('  isPgUniqueViolation — ok');
}

function testToPgJsonbParam() {
  assert.equal(toPgJsonbParam(null), null);
  assert.equal(toPgJsonbParam([{ id: 1 }]), '[{"id":1}]');
  console.log('  toPgJsonbParam — ok');
}

function testPgIdToNumber() {
  assert.equal(pgIdToNumber('42'), 42);
  assert.equal(pgIdToNumber(42n), 42);
  assert.equal(pgIdToNumber(42), 42);
  console.log('  pgIdToNumber — ok');
}

function testPgCoerceBigIntFields() {
  const row = pgCoerceBigIntFields({ id: '99', name: 'x' }, ['id']);
  assert.equal(row.id, 99);
  assert.equal(row.name, 'x');
  console.log('  pgCoerceBigIntFields — ok');
}

console.log('pgQueryHelpers unit tests');
testPgErrorMessage();
testIsPgUniqueViolation();
testToPgJsonbParam();
testPgIdToNumber();
testPgCoerceBigIntFields();
console.log('All pgQueryHelpers unit tests passed.');
