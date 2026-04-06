const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const taskPath = path.resolve(__dirname, '../../src/tasks/cleanOrphanFiles.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const cronPath = require.resolve('node-cron');

function loadTaskWithConnection(connectionMock) {
  delete require.cache[taskPath];
  delete require.cache[databasePath];
  delete require.cache[cronPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  require.cache[cronPath] = {
    id: cronPath,
    filename: cronPath,
    loaded: true,
    exports: {
      schedule() {
        return {
          start() {},
          stop() {},
        };
      },
    },
  };

  return require(taskPath);
}

test('cleanOrphanFiles: pg uses pg-safe orphan lookup SQL and commits when no orphan files exist', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const originalCronMode = process.env.CLEAN_CRON_MODE;

  process.env.CLEAN_CRON_MODE = 'prod';

  const task = loadTaskWithConnection({
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          return [[], []];
        },
        async commit() {
          calls.push({ type: 'commit' });
        },
        async rollback() {
          calls.push({ type: 'rollback' });
        },
        release() {
          calls.push({ type: 'release' });
        },
      };
    },
  });

  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    await task.cleanOrphanFiles('image', 'manual');
  } finally {
    if (originalCronMode === undefined) {
      delete process.env.CLEAN_CRON_MODE;
    } else {
      process.env.CLEAN_CRON_MODE = originalCronMode;
    }
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }

  const executeCall = calls.find((call) => call.type === 'execute');
  assert.ok(executeCall, 'Expected orphan lookup query to execute');
  assert.match(executeCall.statement, /EXTRACT\(EPOCH FROM \(NOW\(\) - f\.create_at\)\)/i);
  assert.match(executeCall.statement, /NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.doesNotMatch(executeCall.statement, /TIMESTAMPDIFF/i);
  assert.doesNotMatch(executeCall.statement, /DATE_SUB/i);
  assert.deepEqual(executeCall.params, ['image', 7]);

  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});
