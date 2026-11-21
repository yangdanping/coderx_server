import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const configPath = '../../deploy/ecosystem.hono.config.cjs';

test('candidate PM2 config requires explicit paths and a nonzero TCP port', () => {
  const root = mkdtempSync(join(tmpdir(), 'coderx-pm2-config-'));
  const envFile = join(root, '.env.fixture');
  const entry = join(root, 'dist/main.js');
  const inputs = {
    CODERX_HONO_RELEASE_DIR: root,
    APP_ENV_FILE: envFile,
    APP_PORT: '18543',
    APP_HOST: '0.0.0.0',
    BACKGROUND_JOBS_ENABLED: 'true',
    LOG_ROOT: '/shared/logs',
    SHUTDOWN_TIMEOUT_MS: '12000',
  };
  const original = { ...process.env };
  const load = (overrides: Record<string, string | undefined> = {}) => {
    const settings = { ...inputs, ...overrides };
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  };

  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(entry, 'throw new Error("Config load must never execute the entry");');
    writeFileSync(envFile, 'APP_PORT=1\nSHUTDOWN_TIMEOUT_MS=1\n');
    for (const key of ['CODERX_HONO_RELEASE_DIR', 'APP_ENV_FILE', 'APP_PORT']) {
      assert.throws(() => load({ [key]: undefined }), new RegExp(key));
    }
    assert.throws(() => load({ CODERX_HONO_RELEASE_DIR: 'release' }), /CODERX_HONO_RELEASE_DIR/);
    assert.throws(() => load({ APP_ENV_FILE: join(root, 'absent') }), /APP_ENV_FILE/);
    assert.throws(() => load({ APP_ENV_FILE: root }), /APP_ENV_FILE/);
    for (const port of ['0', '1e3', '65536']) {
      assert.throws(() => load({ APP_PORT: port }), /APP_PORT/);
    }
    assert.throws(() => load({ SHUTDOWN_TIMEOUT_MS: '0' }), /SHUTDOWN_TIMEOUT_MS/);

    const { apps } = load();
    assert.equal(apps.length, 1);
    const [app] = apps;
    assert.equal(app.name, 'coderx_hono_candidate');
    assert.equal(app.cwd, root);
    assert.equal(app.script, process.execPath);
    assert.equal(app.interpreter, 'none');
    assert.deepEqual(app.args, ['--enable-source-maps', entry]);
    assert.equal(app.exec_mode, 'fork');
    assert.equal(app.instances, 1);
    assert.equal(app.env.APP_ENV_FILE, envFile);
    assert.equal(app.env.APP_PORT, inputs.APP_PORT);
    assert.equal(app.env.APP_HOST, '127.0.0.1');
    assert.equal(app.env.BACKGROUND_JOBS_ENABLED, 'false');
    assert.equal(app.env.SHUTDOWN_TIMEOUT_MS, inputs.SHUTDOWN_TIMEOUT_MS);
    assert.equal(app.env.LOG_ROOT, join(root, 'logs'));
    assert.equal(app.out_file, join(root, 'logs', 'pm2-out.log'));
    assert.equal(app.error_file, join(root, 'logs', 'pm2-error.log'));
    assert.ok(app.kill_timeout > Number(app.env.SHUTDOWN_TIMEOUT_MS));

    rmSync(entry);
    assert.throws(() => load(), /dist\/main\.js/);
  } finally {
    for (const key of Object.keys(inputs)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
