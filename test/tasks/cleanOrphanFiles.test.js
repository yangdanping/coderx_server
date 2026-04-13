const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const taskPath = path.resolve(__dirname, '../../src/tasks/cleanOrphanFiles.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');
const cronPath = require.resolve('node-cron');

function loadTaskWithConnection(connectionMock, cronMock = null) {
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
    exports: cronMock || {
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
  const logs = [];
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const originalCronMode = process.env.CLEAN_CRON_MODE;
  let executeIndex = 0;

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
          executeIndex += 1;
          if (executeIndex === 1) return [{ affectedRows: 2, rowCount: 2 }, []];
          if (executeIndex === 2) return [{ affectedRows: 1, rowCount: 1 }, []];
          if (executeIndex === 3) return [{ affectedRows: 0, rowCount: 0 }, []];
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

  console.log = (...args) => {
    logs.push(args.join(' '));
  };
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

  const executeCalls = calls.filter((call) => call.type === 'execute');
  assert.equal(executeCalls.length >= 4, true, 'Expected lifecycle-draft cleanup and orphan lookup to execute');

  const deleteConsumedCall = executeCalls[0];
  assert.match(deleteConsumedCall.statement, /DELETE FROM draft/i);
  assert.match(deleteConsumedCall.statement, /status\s*=\s*'consumed'/i);
  assert.deepEqual(deleteConsumedCall.params, [1]);

  const deleteDiscardedCall = executeCalls[1];
  assert.match(deleteDiscardedCall.statement, /DELETE FROM draft/i);
  assert.match(deleteDiscardedCall.statement, /status\s*=\s*'discarded'/i);
  assert.deepEqual(deleteDiscardedCall.params, [1]);

  const deleteActiveCall = executeCalls[2];
  assert.match(deleteActiveCall.statement, /DELETE FROM draft/i);
  assert.match(deleteActiveCall.statement, /status\s*=\s*'active'/i);
  assert.deepEqual(deleteActiveCall.params, [7]);

  const orphanLookupCall = executeCalls[3];
  assert.match(orphanLookupCall.statement, /EXTRACT\(EPOCH FROM \(NOW\(\) - f\.create_at\)\)/i);
  assert.match(orphanLookupCall.statement, /NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.doesNotMatch(orphanLookupCall.statement, /TIMESTAMPDIFF/i);
  assert.doesNotMatch(orphanLookupCall.statement, /DATE_SUB/i);
  assert.match(orphanLookupCall.statement, /f\.draft_id IS NULL/i);
  assert.deepEqual(orphanLookupCall.params, ['image', 7]);

  assert.equal(logs.some((line) => line.includes('已清理 consumed 草稿: 2 条')), true);
  assert.equal(logs.some((line) => line.includes('已清理 discarded 草稿: 1 条')), true);
  assert.equal(logs.some((line) => line.includes('已清理 active 草稿: 0 条')), true);

  assert.equal(calls.some((call) => call.type === 'commit'), true);
  assert.equal(calls.some((call) => call.type === 'rollback'), false);
});

test('task schedule: runs lifecycle draft cleanup once before image and video orphan lookups', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const originalCronMode = process.env.CLEAN_CRON_MODE;
  let scheduledHandler = null;

  process.env.CLEAN_CRON_MODE = 'prod';

  loadTaskWithConnection(
    {
      dialect: 'pg',
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'beginTransaction' });
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            if (/DELETE FROM draft/i.test(statement)) {
              return [{ affectedRows: 0, rowCount: 0 }, []];
            }
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
    },
    {
      schedule(_expression, handler) {
        scheduledHandler = handler;
        return {
          start() {},
          stop() {},
        };
      },
    },
  );

  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    assert.equal(typeof scheduledHandler, 'function');
    await scheduledHandler();
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

  const executeCalls = calls.filter((call) => call.type === 'execute');
  const draftCleanupCalls = executeCalls.filter((call) => /DELETE FROM draft/i.test(call.statement));
  const orphanLookupCalls = executeCalls.filter((call) => /FROM file f/i.test(call.statement));

  assert.equal(draftCleanupCalls.length, 3);
  assert.match(draftCleanupCalls[0].statement, /status\s*=\s*'consumed'/i);
  assert.match(draftCleanupCalls[1].statement, /status\s*=\s*'discarded'/i);
  assert.match(draftCleanupCalls[2].statement, /status\s*=\s*'active'/i);

  assert.equal(orphanLookupCalls.length, 2);
  assert.deepEqual(orphanLookupCalls[0].params, ['image', 7]);
  assert.deepEqual(orphanLookupCalls[1].params, ['video', 7]);
  assert.equal(executeCalls.findIndex((call) => /FROM file f/i.test(call.statement)), 3);
});

test('task schedule: stops the current cron cycle when lifecycle draft cleanup fails', async () => {
  const calls = [];
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const originalCronMode = process.env.CLEAN_CRON_MODE;
  let scheduledHandler = null;

  process.env.CLEAN_CRON_MODE = 'prod';

  loadTaskWithConnection(
    {
      dialect: 'pg',
      async getConnection() {
        return {
          async beginTransaction() {
            calls.push({ type: 'beginTransaction' });
          },
          async execute(statement, params) {
            calls.push({ type: 'execute', statement, params });
            if (/DELETE FROM draft/i.test(statement)) {
              throw new Error('draft lifecycle cleanup failed');
            }
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
    },
    {
      schedule(_expression, handler) {
        scheduledHandler = handler;
        return {
          start() {},
          stop() {},
        };
      },
    },
  );

  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    assert.equal(typeof scheduledHandler, 'function');
    await assert.rejects(() => scheduledHandler(), /draft lifecycle cleanup failed/);
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

  const executeCalls = calls.filter((call) => call.type === 'execute');
  const orphanLookupCalls = executeCalls.filter((call) => /FROM file f/i.test(call.statement));

  assert.equal(orphanLookupCalls.length, 0);
  assert.equal(calls.some((call) => call.type === 'rollback'), true);
  assert.equal(calls.some((call) => call.type === 'commit'), false);
});
