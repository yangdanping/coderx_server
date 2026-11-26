import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { parseMediaMigrationArgs, runMediaMigrationCli, type MediaMigrationActions } from '../../src/tasks/mediaMigration.cli.js';

test('environment loading and SQL logging leave the migration CLI output machine-readable', (t) => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const root = fs.mkdtempSync(path.join(tmpdir(), 'coderx-media-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://test@postgres.example.invalid/test\n');
  const fixture = path.join(root, 'pg.mjs');
  fs.writeFileSync(fixture, `
    import pg from ${JSON.stringify(import.meta.resolve('pg'))};
    pg.Pool.prototype.query = async () => ({ command: 'SELECT', rows: [], fields: [] });
    pg.Pool.prototype.end = async () => {};
  `);
  const result = spawnSync(process.execPath, ['--require', './test/support/runtime-guard.cjs', '--import=tsx', '--import', fixture, './src/tasks/mediaMigration.cli.ts', 'inventory'], {
    cwd,
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      APP_ENV_FILE: envFile,
      CODERX_TEST_RESOURCE_ROOT: root,
      MEDIA_ROOT: root,
      LOG_ROOT: path.join(root, 'logs'),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).published, { logicalFiles: 0, physicalObjects: 0, bytes: 0 });
});

test('media migration CLI parses safe commands and typed batch controls', () => {
  assert.deepEqual(parseMediaMigrationArgs(['migrate-r2', '--apply', '--article-id', '7', '--after-file-id', '10', '--limit', '5', '--concurrency', '2']), {
    command: 'migrate-r2',
    options: { apply: true, articleId: 7, afterFileId: 10, limit: 5, concurrency: 2 },
  });
  assert.deepEqual(parseMediaMigrationArgs(['backfill-local', '--dry-run']), {
    command: 'backfill-local',
    options: { dryRun: true },
  });
  assert.deepEqual(parseMediaMigrationArgs(['reconcile', '--repair', '--pending-older-than-minutes', '60']), {
    command: 'reconcile',
    options: { repair: true, pendingOlderThanMinutes: 60 },
  });
  assert.deepEqual(parseMediaMigrationArgs(['inventory']), { command: 'inventory', options: {} });
  assert.deepEqual(parseMediaMigrationArgs(['--', 'inventory']), { command: 'inventory', options: {} });
  assert.deepEqual(parseMediaMigrationArgs(['migrate-r2', '--after-file-id', '0']), {
    command: 'migrate-r2',
    options: { afterFileId: 0 },
  });
});

test('media migration CLI rejects unknown, destructive or command-incompatible options', () => {
  assert.throws(() => parseMediaMigrationArgs(['delete']), /Unknown command/i);
  assert.throws(() => parseMediaMigrationArgs(['migrate-r2', '--delete-local']), /Unknown option/i);
  assert.throws(() => parseMediaMigrationArgs(['migrate-r2', '--apply', '--dry-run']), /mutually exclusive/i);
  assert.throws(() => parseMediaMigrationArgs(['inventory', '--apply']), /only valid/i);
  assert.throws(() => parseMediaMigrationArgs(['backfill-local', '--repair']), /only valid/i);
  assert.throws(() => parseMediaMigrationArgs(['reconcile', '--concurrency', '3']), /only valid/i);
  assert.throws(() => parseMediaMigrationArgs(['migrate-r2', '--concurrency', '11']), /between 1 and 10/i);
  assert.throws(() => parseMediaMigrationArgs(['migrate-r2', '--limit', '0']), /positive/i);
});

test('media migration CLI defaults mutating actions to dry-run and always closes resources', async () => {
  const calls: unknown[][] = [];
  let output = '';
  const actions: MediaMigrationActions = {
    async inventory(options) {
      calls.push(['inventory', options]);
      return { ok: true };
    },
    async backfillLocal(options) {
      calls.push(['backfillLocal', options]);
      return { dryRun: options.dryRun };
    },
    async migrateR2(options) {
      calls.push(['migrateR2', options]);
      return { dryRun: options.dryRun };
    },
    async reconcile(options) {
      calls.push(['reconcile', options]);
      return { repair: options.repair };
    },
    async close() {
      calls.push(['close']);
    },
  };

  await runMediaMigrationCli(['backfill-local'], {
    actions,
    write(value) {
      output += value;
    },
  });
  assert.deepEqual(calls, [['backfillLocal', { dryRun: true }], ['close']]);
  assert.deepEqual(JSON.parse(output), { dryRun: true });
});

test('media migration CLI forwards explicit apply/repair and closes after action failure', async () => {
  const calls: unknown[][] = [];
  const actions: MediaMigrationActions = {
    async inventory() {
      throw new Error('unexpected inventory');
    },
    async backfillLocal() {
      throw new Error('unexpected backfill');
    },
    async migrateR2(options) {
      calls.push(['migrateR2', options]);
      return { dryRun: options.dryRun };
    },
    async reconcile() {
      throw new Error('R2 credentials unavailable');
    },
    async close() {
      calls.push(['close']);
    },
  };

  await runMediaMigrationCli(['migrate-r2', '--apply'], { actions, write() {} });
  assert.deepEqual(calls, [['migrateR2', { apply: true, dryRun: false }], ['close']]);

  await assert.rejects(runMediaMigrationCli(['reconcile'], { actions, write() {} }), /credentials unavailable/i);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('CLI rejects invalid arguments before loading configured resources', () => {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const result = spawnSync(process.execPath, ['--require', './test/support/runtime-guard.cjs', '--import=tsx', './src/tasks/mediaMigration.cli.ts', 'invalid'], {
    cwd,
    env: { PATH: process.env.PATH, APP_ENV_FILE: path.join(cwd, '.disabled-test-env') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'Unknown command: invalid' });
});
