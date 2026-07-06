import assert from 'node:assert/strict';
import { test } from 'node:test';
import { novaChatSessionsListQuerySchema } from '../src/fastify/schemas/novaChatRequests.js';
import {
  preVisitSummaryFilterWhereClause,
  resolvePreVisitSummaryListFilter,
} from '../src/utils/novaChatPersistence.js';

test('resolvePreVisitSummaryListFilter defaults to exclude', () => {
  assert.equal(resolvePreVisitSummaryListFilter({}), 'exclude');
  assert.equal(
    resolvePreVisitSummaryListFilter({ includePreVisitSummary: false, onlyPreVisitSummary: false }),
    'exclude'
  );
});

test('resolvePreVisitSummaryListFilter honors include and only flags', () => {
  assert.equal(resolvePreVisitSummaryListFilter({ includePreVisitSummary: true }), 'include');
  assert.equal(resolvePreVisitSummaryListFilter({ onlyPreVisitSummary: true }), 'only');
  assert.equal(
    resolvePreVisitSummaryListFilter({ includePreVisitSummary: true, onlyPreVisitSummary: true }),
    'only'
  );
});

test('preVisitSummaryFilterWhereClause returns expected SQL fragments', () => {
  assert.equal(preVisitSummaryFilterWhereClause('include'), '');
  assert.match(preVisitSummaryFilterWhereClause('exclude'), /NOT EXISTS/);
  assert.match(preVisitSummaryFilterWhereClause('only'), /EXISTS/);
  assert.doesNotMatch(preVisitSummaryFilterWhereClause('only'), /NOT EXISTS/);
});

test('novaChatSessionsListQuerySchema defaults pre-visit summary filters to false', () => {
  const parsed = novaChatSessionsListQuerySchema.parse({});
  assert.equal(parsed.includePreVisitSummary, false);
  assert.equal(parsed.onlyPreVisitSummary, false);
  assert.equal(parsed.limit, 50);
});

test('novaChatSessionsListQuerySchema coerces string booleans', () => {
  const include = novaChatSessionsListQuerySchema.parse({ includePreVisitSummary: 'true' });
  assert.equal(include.includePreVisitSummary, true);

  const only = novaChatSessionsListQuerySchema.parse({ onlyPreVisitSummary: '1' });
  assert.equal(only.onlyPreVisitSummary, true);
});

test('novaChatSessionsListQuerySchema rejects conflicting pre-visit summary flags', () => {
  assert.throws(
    () =>
      novaChatSessionsListQuerySchema.parse({
        includePreVisitSummary: true,
        onlyPreVisitSummary: true,
      }),
    /cannot both be true/
  );
});
