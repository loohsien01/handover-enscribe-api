import assert from 'node:assert/strict';
import { computeBaaStatus } from '../src/utils/baaStatus.js';

const activeVersion = { id: 'v-active', version_number: '1.1.0' };
const acceptanceForActive = {
  id: 'a1',
  baa_version_id: 'v-active',
  accepted_at: '2026-06-21T00:00:00.000Z',
  accepted_by_user_id: 'u1',
  version_number: '1.1.0',
};
const acceptanceForOld = {
  id: 'a0',
  baa_version_id: 'v-old',
  accepted_at: '2026-06-01T00:00:00.000Z',
  accepted_by_user_id: 'u1',
  version_number: '1.0.0',
};

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    throw err;
  }
}

test('needs_acceptance when active exists and org never signed', () => {
  const result = computeBaaStatus({
    activeVersion,
    acceptance: null,
    memberRole: 'owner',
  });
  assert.equal(result.needs_acceptance, true);
  assert.equal(result.can_accept, true);
  assert.equal(result.acceptance, null);
});

test('needs_acceptance when org signed an older version only (strict re-sign)', () => {
  const result = computeBaaStatus({
    activeVersion,
    acceptance: acceptanceForOld,
    memberRole: 'owner',
  });
  assert.equal(result.needs_acceptance, true);
  assert.equal(result.acceptance?.version_number, '1.0.0');
});

test('no needs_acceptance when org signed active version', () => {
  const result = computeBaaStatus({
    activeVersion,
    acceptance: acceptanceForActive,
    memberRole: 'owner',
  });
  assert.equal(result.needs_acceptance, false);
  assert.equal(result.active_version, '1.1.0');
});

test('can_accept false for non-owner', () => {
  const result = computeBaaStatus({
    activeVersion,
    acceptance: null,
    memberRole: 'member',
  });
  assert.equal(result.can_accept, false);
});

test('no active version → no acceptance required', () => {
  const result = computeBaaStatus({
    activeVersion: null,
    acceptance: null,
    memberRole: 'owner',
  });
  assert.equal(result.needs_acceptance, false);
  assert.equal(result.can_accept, false);
  assert.equal(result.active_version, null);
});

console.log('\nAll baaStatus unit tests passed.\n');
