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

test('ingest runtime carries media flags and credentials without web config or a second database', () => {
  const config = loadRuntimeConfig({
    MEDIA_WRITE_MODE: 'r2_on_publish',
    MEDIA_R2_WRITE_PAUSED: 'true',
    MEDIA_MUTATIONS_PAUSED: 'true',
    R2_HARD_LIMIT_BYTES: '9999',
    R2_ACCOUNT_ID: 'test-account',
  });
  assert.equal(config.media.writeMode, 'r2_on_publish');
  assert.equal(config.media.writePaused, true);
  assert.equal(config.media.mutationsPaused, true);
  assert.equal(config.media.hardLimitBytes, 9999);
  assert.equal(config.media.accountId, 'test-account');
});
