const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('module-alias/register');

const { parseMediaMigrationArgs, runMediaMigrationCli } = require('@/tasks/mediaMigration.cli');

test('application config supports quiet dotenv loading for machine-readable migration output', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/app/config.js'), 'utf8');
  assert.match(source, /dotenv\.config\(\{[\s\S]*quiet:\s*process\.env\.CONFIG_QUIET\s*===\s*'true'/);
  const loggerSource = fs.readFileSync(path.resolve(__dirname, '../../src/app/logger.js'), 'utf8');
  assert.match(loggerSource, /process\.env\.CONFIG_QUIET\s*===\s*'true'[\s\S]*sqlConsoleAppenders/);
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
  const calls = [];
  let output = '';
  const actions = {
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
  const calls = [];
  const actions = {
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
