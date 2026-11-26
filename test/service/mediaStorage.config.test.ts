import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readMediaConfig } from '../../src/app/config.js';

const envExamplePath = new URL('../../.env.example', import.meta.url);

test('media storage config: exposes safe local defaults without credentials', () => {
  const config = readMediaConfig({});

  assert.equal(config.writeMode, 'local');
  assert.equal(config.readMode, 'local');
  assert.equal(config.writePaused, false);
  assert.equal(config.mutationsPaused, false);
  assert.equal(config.cdnBaseUrl, 'https://media.ydp321.asia');
  assert.equal(config.accountId, '');
  assert.equal(config.bucket, 'coderx-media-public');
  assert.equal(config.hardLimitBytes, 7_000_000_000);
  assert.equal(config.resumeLimitBytes, 6_000_000_000);
  assert.equal(config.accessKeyId, '');
  assert.equal(config.secretAccessKey, '');
});

test('.env.example: documents media switches with local/local safe defaults and blank credentials', () => {
  const env = fs.readFileSync(envExamplePath, 'utf8');

  assert.match(env, /^MEDIA_WRITE_MODE=local$/m);
  assert.match(env, /^MEDIA_READ_MODE=local$/m);
  assert.match(env, /^MEDIA_KEEP_LOCAL_AFTER_PROMOTE=true$/m);
  assert.match(env, /^MEDIA_R2_WRITE_PAUSED=false$/m);
  assert.match(env, /^MEDIA_MUTATIONS_PAUSED=false$/m);
  assert.match(env, /^MEDIA_CDN_BASE_URL=https:\/\/media\.ydp321\.asia$/m);
  assert.match(env, /^R2_BUCKET=coderx-media-public$/m);
  assert.match(env, /^R2_ACCESS_KEY_ID=$/m);
  assert.match(env, /^R2_SECRET_ACCESS_KEY=$/m);
  assert.match(env, /^R2_HARD_LIMIT_BYTES=7000000000$/m);
  assert.match(env, /^R2_RESUME_LIMIT_BYTES=6000000000$/m);
});
