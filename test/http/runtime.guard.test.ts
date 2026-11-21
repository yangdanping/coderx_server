import '../support/runtime-guard.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrationDatabaseConfig } from '../integration/databaseConfig.js';

test('runtime guard rejects out-of-fixture env/key reads while allowing explicit temporary resources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coderx-guard-'));
  const allowed = join(dir, 'allowed');
  mkdirSync(allowed);
  for (const parent of [dir, allowed]) {
    writeFileSync(join(parent, '.env'), 'FAKE=1');
    writeFileSync(join(parent, 'private.key'), 'fake key');
  }
  try {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      assert.equal(fs.readFileSync(${JSON.stringify(join(allowed, '.env'))}, 'utf8'), 'FAKE=1');
      assert.equal(fs.readFileSync(${JSON.stringify(join(allowed, 'private.key'))}, 'utf8'), 'fake key');
      assert.throws(() => fs.readFileSync(${JSON.stringify(join(dir, '.env'))}), /Test guard blocked/);
      assert.throws(() => fs.readFileSync(${JSON.stringify(join(dir, 'private.key'))}), /Test guard blocked/);
    `;
    const child = spawnSync(process.execPath, ['--require', resolve('test/support/runtime-guard.cjs'), '--input-type=module', '-e', script], {
      env: { ...process.env, CODERX_TEST_RESOURCE_ROOT: allowed }, timeout: 5000, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL integration rejects a non-test database before connecting', () => {
  const local = { PGHOST: '127.0.0.1', PGPORT: '65432', PGUSER: 'fixture', PGPASSWORD: 'fixture' };
  assert.throws(() => integrationDatabaseConfig({ ...local, PGDATABASE: 'coderx_latest' }), /dedicated test database/);
  assert.throws(() => integrationDatabaseConfig({ ...local, PGHOST: 'db.example.test', PGDATABASE: 'coderx_test' }), /local PostgreSQL host/);
  assert.equal(integrationDatabaseConfig({ ...local, PGDATABASE: 'coderx_test' }).database, 'coderx_test');
});
