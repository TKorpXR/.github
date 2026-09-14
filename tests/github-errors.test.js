'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRateLimitError, runWithRateLimitGuard } = require('../scripts/lib/github-errors');
const { createCore, graphqlRateLimitError } = require('./helpers/fakes');

test('reconnait la limite GraphQL renvoyee en HTTP 200', () => {
  assert.equal(isRateLimitError(graphqlRateLimitError()), true);
});

test('reconnait la limite REST primaire', () => {
  const error = Object.assign(new Error('API rate limit exceeded'), {
    status: 403,
    response: { headers: { 'x-ratelimit-remaining': '0' } },
  });
  assert.equal(isRateLimitError(error), true);
});

test('reconnait la limite REST anti-rafale', () => {
  const error = Object.assign(
    new Error('You have exceeded a secondary rate limit. Please wait a few minutes.'),
    { status: 403, response: { headers: {} } },
  );
  assert.equal(isRateLimitError(error), true);
});

test('reconnait un 429', () => {
  const error = Object.assign(new Error('Too Many Requests: rate limit'), { status: 429 });
  assert.equal(isRateLimitError(error), true);
});

test("n'assimile pas un refus de permission a une limite", () => {
  const error = Object.assign(new Error('Resource not accessible by integration'), {
    status: 403,
    response: { headers: { 'x-ratelimit-remaining': '4999' } },
  });
  assert.equal(isRateLimitError(error), false);
});

test("n'assimile pas une autre erreur GraphQL a une limite", () => {
  const error = Object.assign(new Error('Could not resolve to a node'), {
    errors: [{ type: 'NOT_FOUND' }],
  });
  assert.equal(isRateLimitError(error), false);
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError('rate limit'), false);
});

test('le garde transforme une limite en avertissement, sans echec', async () => {
  const core = createCore();
  const result = await runWithRateLimitGuard({ core, workflow: 'test' }, async () => {
    throw graphqlRateLimitError();
  });

  assert.deepEqual(result, { rateLimited: true });
  assert.equal(core.calls.failed.length, 0);
  assert.equal(core.calls.warnings.length, 1);
  assert.match(core.calls.warnings[0], /limite de debit/);
  assert.ok(core.calls.summary.some((entry) => entry.written));
});

test('le garde relance toute autre erreur', async () => {
  const core = createCore();
  await assert.rejects(
    runWithRateLimitGuard({ core, workflow: 'test' }, async () => {
      throw new Error('panne reelle');
    }),
    /panne reelle/,
  );
  assert.equal(core.calls.warnings.length, 0);
});

test('le garde rend le resultat du passage quand tout va bien', async () => {
  const core = createCore();
  const result = await runWithRateLimitGuard({ core, workflow: 'test' }, async () => 42);
  assert.equal(result, 42);
});
