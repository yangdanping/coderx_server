import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackgroundJobsEnabled } from '../../src/app/runtime.config.js';

test('candidate HTTP defaults to no background jobs', () => {
  assert.equal(parseBackgroundJobsEnabled(undefined), false);
  assert.equal(parseBackgroundJobsEnabled('false'), false);
  assert.equal(parseBackgroundJobsEnabled('true'), true);
  assert.throws(() => parseBackgroundJobsEnabled('treu'));
});

import { parseRuntimeConfig } from '../../src/app/runtime.config.js';
import path from 'node:path';

test('runtime paths resolve against a stable configured base', () => {
  const cfg = parseRuntimeConfig({ APP_PORT: '3000', MEDIA_ROOT: 'media', JWT_PRIVATE_KEY_PATH: 'keys/private', JWT_PUBLIC_KEY_PATH: 'keys/public', LOG_ROOT: 'logs' }, '/tmp/config-base');
  assert.equal(cfg.mediaRoot, path.resolve('/tmp/config-base/media'));
  assert.equal(cfg.privateKeyPath, path.resolve('/tmp/config-base/keys/private'));
  assert.equal(cfg.publicKeyPath, path.resolve('/tmp/config-base/keys/public'));
  assert.equal(cfg.logRoot, path.resolve('/tmp/config-base/logs'));
  assert.throws(() => parseRuntimeConfig({ APP_PORT: '65536' }));
  assert.throws(() => parseRuntimeConfig({ APP_PORT: '3000', BACKGROUND_JOBS_ENABLED: 'yes' }));
});

test('legacy host origins resolve to bind hostnames safely', () => {
  assert.equal(parseRuntimeConfig({ APP_PORT: '0', APP_HOST: 'http://127.0.0.1' }).host, '127.0.0.1');
  assert.equal(parseRuntimeConfig({ APP_PORT: '0', APP_HOST: 'localhost' }).host, 'localhost');
  assert.equal(parseRuntimeConfig({ APP_PORT: '0' }).host, '127.0.0.1');
  assert.throws(() => parseRuntimeConfig({ APP_PORT: '0', APP_HOST: 'http://user:secret@localhost' }), /^Error: APP_HOST is invalid$/);
});
