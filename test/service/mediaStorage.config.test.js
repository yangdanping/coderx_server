const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(__dirname, '../../src/app/config.js');
const envExamplePath = path.resolve(__dirname, '../../.env.example');
const mediaVariableNames = [
  'MEDIA_WRITE_MODE',
  'MEDIA_READ_MODE',
  'MEDIA_KEEP_LOCAL_AFTER_PROMOTE',
  'MEDIA_R2_WRITE_PAUSED',
  'MEDIA_CDN_BASE_URL',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_HARD_LIMIT_BYTES',
  'R2_RESUME_LIMIT_BYTES',
];

test('media storage config: exposes safe local defaults without credentials', (t) => {
  const previous = Object.fromEntries(mediaVariableNames.map((name) => [name, process.env[name]]));
  for (const name of mediaVariableNames) delete process.env[name];
  delete require.cache[configPath];

  t.after(() => {
    delete require.cache[configPath];
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const config = require(configPath);

  assert.equal(config.MEDIA_WRITE_MODE, 'local');
  assert.equal(config.MEDIA_READ_MODE, 'local');
  assert.equal(config.MEDIA_KEEP_LOCAL_AFTER_PROMOTE, 'true');
  assert.equal(config.MEDIA_R2_WRITE_PAUSED, 'false');
  assert.equal(config.MEDIA_CDN_BASE_URL, 'https://media.ydp321.asia');
  assert.equal(config.R2_ACCOUNT_ID, '');
  assert.equal(config.R2_BUCKET, 'coderx-media-public');
  assert.equal(config.R2_HARD_LIMIT_BYTES, '7000000000');
  assert.equal(config.R2_RESUME_LIMIT_BYTES, '6000000000');
  assert.equal(config.R2_ACCESS_KEY_ID, '');
  assert.equal(config.R2_SECRET_ACCESS_KEY, '');
});

test('.env.example: documents media switches with local/local safe defaults and blank credentials', () => {
  const env = fs.readFileSync(envExamplePath, 'utf8');

  assert.match(env, /^MEDIA_WRITE_MODE=local$/m);
  assert.match(env, /^MEDIA_READ_MODE=local$/m);
  assert.match(env, /^MEDIA_KEEP_LOCAL_AFTER_PROMOTE=true$/m);
  assert.match(env, /^MEDIA_R2_WRITE_PAUSED=false$/m);
  assert.match(env, /^MEDIA_CDN_BASE_URL=https:\/\/media\.ydp321\.asia$/m);
  assert.match(env, /^R2_BUCKET=coderx-media-public$/m);
  assert.match(env, /^R2_ACCESS_KEY_ID=$/m);
  assert.match(env, /^R2_SECRET_ACCESS_KEY=$/m);
  assert.match(env, /^R2_HARD_LIMIT_BYTES=7000000000$/m);
  assert.match(env, /^R2_RESUME_LIMIT_BYTES=6000000000$/m);
});
