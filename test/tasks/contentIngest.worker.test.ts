import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { startWorker } from '../../src/ingest/worker.js';

function createCronDouble() {
  const task = { stop() {} };
  const calls = [];
  return {
    calls,
    task,
    schedule(expression, callback, options) {
      calls.push({ expression, callback, options });
      return task;
    },
  };
}

function createLoggerDouble() {
  const calls = [];
  return {
    calls,
    info(message) {
      calls.push({ level: 'info', message });
    },
    error(message, error) {
      calls.push({ level: 'error', message, error });
    },
  };
}

test('startWorker schedules one non-overlapping task in the configured timezone', () => {
  const cron = createCronDouble();
  const logger = createLoggerDouble();

  const task = startWorker({
    cron,
    run: async () => ({}),
    config: {
      enabled: true,
      schedule: '15 7 * * *',
      timezone: 'Asia/Shanghai',
    },
    logger,
  });

  assert.equal(task, cron.task);
  assert.equal(cron.calls.length, 1);
  assert.equal(cron.calls[0].expression, '15 7 * * *');
  assert.deepEqual(cron.calls[0].options, {
    name: 'coderx_ingest_worker',
    noOverlap: true,
    timezone: 'Asia/Shanghai',
  });
});

test('disabled worker remains scheduled but skips database and network work', async () => {
  const cron = createCronDouble();
  const logger = createLoggerDouble();
  let runCount = 0;
  startWorker({
    cron,
    run: async () => {
      runCount += 1;
    },
    config: {
      enabled: false,
      schedule: '15 7 * * *',
      timezone: 'Asia/Shanghai',
    },
    logger,
  });

  const result = await cron.calls[0].callback();

  assert.equal(runCount, 0);
  assert.deepEqual(result, {
    skipped: true,
    reason: 'INGEST_ENABLED is disabled',
  });
  assert.match(logger.calls[0].message, /disabled/i);
});

test('worker catches rejected runs and logs the error without rejecting the scheduler callback', async () => {
  const cron = createCronDouble();
  const logger = createLoggerDouble();
  const failure = new Error('feed timeout');
  startWorker({
    cron,
    run: async () => {
      throw failure;
    },
    config: {
      enabled: true,
      schedule: '15 7 * * *',
      timezone: 'Asia/Shanghai',
    },
    logger,
  });

  const result = await cron.calls[0].callback();

  assert.deepEqual(result, {
    failed: true,
    message: 'feed timeout',
  });
  assert.equal(logger.calls[0].level, 'error');
  assert.equal(logger.calls[0].error, failure);
});

test('PM2 and environment templates keep the ingest worker single-instance and disabled by default', async () => {
  const { default: ecosystem }: { default: { apps: Array<{ name: string; instances?: number; exec_mode?: string; args?: string }> } } =
    await import(new URL('../../ecosystem.config.cjs', import.meta.url).href);
  const workerApp = ecosystem.apps.find((app) => app.name === 'coderx_ingest_worker');
  const envExample = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

  assert.ok(workerApp);
  assert.equal(workerApp.instances, 1);
  assert.equal(workerApp.exec_mode, 'fork');
  assert.ok(workerApp.args);
  assert.match(workerApp.args, /start:ingest/);
  assert.match(envExample, /^INGEST_ENABLED=false$/m);
  assert.match(envExample, /^INGEST_AUTO_PUBLISH=false$/m);
});
