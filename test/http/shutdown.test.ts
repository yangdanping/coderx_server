import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdown } from '../../src/app/shutdown.js';

test('shutdown stops tasks and closes resources even if one fails', async () => {
  const calls: string[] = [];
  await assert.rejects(shutdown([() => { calls.push('close'); throw Error('failure'); }, () => { calls.push('other'); }], [{ stop() { calls.push('stop'); } }], 1000), AggregateError);
  assert.deepEqual(calls.sort(), ['close', 'other', 'stop']);
});

test('shutdown times out when a resource never closes', async () => {
  await assert.rejects(shutdown([() => new Promise<void>(() => {})], [], 10), /timed out/);
});

test('resources wait for tasks to drain', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let closed = false;
  const result = shutdown([() => { closed = true; }], [{ stop: () => pending }], 1000);
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await result;
  assert.equal(closed, true);
});

test('a failed task stop does not close resources', async () => {
  let closed = false;
  await assert.rejects(shutdown([() => { closed = true; }], [{ stop() { throw Error('stop failed'); } }], 1000), AggregateError);
  assert.equal(closed, false);
});

test('shutdown factory shares a single operation', async () => {
  const { createShutdown } = await import('../../src/app/shutdown.js');
  let count = 0;
  const close = createShutdown([() => { count++; }], [], 1000);
  await Promise.all([close(), close()]);
  await close();
  assert.equal(count, 1);
});
