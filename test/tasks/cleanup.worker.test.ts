import assert from 'node:assert/strict';
import test from 'node:test';
import { startCleanupWorker } from '../../src/tasks/cleanup.worker.js';

test('cleanup worker does not load resources or schedule a task when disabled', async () => {
  let loads = 0;
  const worker = await startCleanupWorker({
    env: { CLEANUP_WORKER_ENABLED: 'false' },
    load() {
      loads++;
      throw new Error('unexpected resource load');
    },
  });
  assert.equal(worker, null);
  assert.equal(loads, 0);
});

test('cleanup worker drains pending work before closing resources', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const worker = await startCleanupWorker({
    env: { CLEANUP_WORKER_ENABLED: 'true' },
    load: () => ({
      dependencies: {
        cron: {
          createTask: () => ({
            start() {
              calls.push('start');
            },
            stop() {
              calls.push('stop');
            },
            destroy() {
              calls.push('destroy');
            },
          }),
        },
        connection: {
          async getConnection() {
            throw new Error('unexpected database query');
          },
        },
        mediaRuntime: {
          async deleteR2ObjectsForFiles() {
            throw new Error('unexpected R2 deletion');
          },
        },
        localMediaCleanup: {
          buildLocalCleanupEntries: () => [],
          enqueueInTransaction: async () => [],
          async processPending() {
            calls.push('retry pending');
            await pending;
            calls.push('drained');
            return { deleted: 0, missing: 0 };
          },
        },
      },
      close: () => {
        calls.push('close');
      },
    }),
  });

  assert.ok(worker);
  const stopping = worker.stop();
  assert.strictEqual(worker.stop(), stopping);
  assert.deepEqual(calls, ['start', 'retry pending', 'stop']);
  finish();
  await stopping;
  assert.deepEqual(calls, ['start', 'retry pending', 'stop', 'drained', 'destroy', 'close']);
});

test('cleanup worker disposes its task and resources if cron fails to start', async () => {
  const calls: string[] = [];
  await assert.rejects(
    startCleanupWorker({
      env: { CLEANUP_WORKER_ENABLED: 'true' },
      load: () => ({
        dependencies: {
          cron: {
            createTask: () => ({
              start() {
                throw new Error('cron startup failed');
              },
              stop() {
                calls.push('stop');
              },
              destroy() {
                calls.push('destroy');
              },
            }),
          },
          connection: {
            async getConnection() {
              throw new Error('unexpected database query');
            },
          },
          mediaRuntime: {
            async deleteR2ObjectsForFiles() {
              throw new Error('unexpected R2 deletion');
            },
          },
          localMediaCleanup: {
            buildLocalCleanupEntries: () => [],
            enqueueInTransaction: async () => [],
            processPending: async () => ({ deleted: 0, missing: 0 }),
          },
        },
        close: () => {
          calls.push('close');
        },
      }),
    }),
    /cron startup failed/,
  );
  assert.deepEqual(calls, ['stop', 'destroy', 'close']);
});
