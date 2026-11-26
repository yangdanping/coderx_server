import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundJobs, type CleanupDependencies } from '../../src/tasks/cleanOrphanFiles.js';

const unusedDependencies = {
  connection: {
    async getConnection() {
      throw new Error('unexpected database query');
    },
  },
  mediaRuntime: {
    async deleteR2ObjectsForFiles() {
      throw new Error('unexpected R2 delete');
    },
  },
};
function localMediaCleanup(processPending: CleanupDependencies['localMediaCleanup']['processPending']) {
  return { processPending, buildLocalCleanupEntries: () => [], enqueueInTransaction: async () => [] };
}
const emptyCleanup = { deleted: 0, missing: 0 };

test('disabled background jobs load no dependencies', () => {
  let loads = 0;
  assert.equal(
    createBackgroundJobs(false, () => {
      loads++;
      throw Error('unexpected');
    }),
    null,
  );
  assert.equal(loads, 0);
});

test('enabled jobs use a stopped task and start explicitly', () => {
  let starts = 0;
  let retries = 0;
  const jobs = createBackgroundJobs(true, () => ({
    cron: {
      createTask: () => ({
        start() {
          starts++;
        },
        stop() {},
      }),
    },
    ...unusedDependencies,
    localMediaCleanup: localMediaCleanup(async () => {
      retries++;
      return emptyCleanup;
    }),
  }));
  assert.equal(starts, 0);
  assert.equal(retries, 0);
  jobs.start();
  jobs.start();
  assert.equal(starts, 1);
  assert.equal(retries, 1);
});

test('truthy non-boolean values cannot load dependencies', () => {
  let loaded = false;
  assert.throws(
    () =>
      createBackgroundJobs('true' as unknown as boolean, () => {
        loaded = true;
        throw Error('unexpected');
      }),
    /boolean/,
  );
  assert.equal(loaded, false);
});

test('stop drains work and destroys cron once', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stops = 0,
    destroys = 0;
  const jobs = createBackgroundJobs(true, () => ({
    cron: {
      createTask: () => ({
        start() {},
        stop() {
          stops++;
        },
        destroy() {
          destroys++;
        },
      }),
    },
    ...unusedDependencies,
    localMediaCleanup: localMediaCleanup(async () => {
      await pending;
      return emptyCleanup;
    }),
  }));
  jobs.start();
  const stopping = jobs.stop();
  assert.equal(destroys, 0);
  release();
  await Promise.all([stopping, jobs.stop()]);
  jobs.start();
  assert.equal(stops, 1);
  assert.equal(destroys, 1);
});

test('a delayed cron callback after stop does no work', async () => {
  let callback!: () => Promise<void>;
  let retries = 0;
  const jobs = createBackgroundJobs(true, () => ({
    cron: {
      createTask: (_expression, cb) => {
        callback = cb;
        return { start() {}, stop() {} };
      },
    },
    ...unusedDependencies,
    localMediaCleanup: localMediaCleanup(async () => {
      retries++;
      return emptyCleanup;
    }),
  }));
  await jobs.stop();
  await callback();
  assert.equal(retries, 0);
});
