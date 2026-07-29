const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { loadRuntimeConfig, parseIdList } = require('@/ingest/config/runtime');

test('parseIdList reads a unique positive integer author pool', () => {
  assert.deepEqual(parseIdList('1,2,3,4,5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseIdList(''), []);
  assert.throws(() => parseIdList('1,2,2'), /duplicate/i);
  assert.throws(() => parseIdList('1,0'), /positive integer/i);
  assert.throws(() => parseIdList('1,9007199254740993'), /positive integer/i);
});

test('loadRuntimeConfig exposes rich-backfill author IDs without enabling publication', () => {
  const config = loadRuntimeConfig({
    INGEST_AUTHOR_IDS: '1,2,3,4,5',
    INGEST_ENABLED: 'false',
    INGEST_AUTO_PUBLISH: 'false',
  });

  assert.deepEqual(config.authorIds, [1, 2, 3, 4, 5]);
  assert.equal(config.enabled, false);
  assert.equal(config.autoPublish, false);
});
