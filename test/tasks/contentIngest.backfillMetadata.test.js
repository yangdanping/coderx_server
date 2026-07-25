const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { assignAuthors, assignBackfillDates } = require('@/ingest/domain/assignBackfillMetadata');

const DAY_MS = 86_400_000;
const candidates = [
  { id: 70, canonicalUrl: 'https://aws.example/article' },
  { id: 21, canonicalUrl: 'https://nvidia.example/article' },
  { id: 54, canonicalUrl: 'https://github.example/article' },
  { id: 149, canonicalUrl: 'https://microsoft.example/article' },
  { id: 60, canonicalUrl: 'https://google.example/article' },
];

test('assignAuthors uses only configured IDs, assigns five distinct users and is stable', () => {
  const first = assignAuthors(candidates, [1, 2, 3, 4, 5]);
  const second = assignAuthors([...candidates].reverse(), [1, 2, 3, 4, 5]);

  assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
  assert.deepEqual(new Set(first.values()), new Set([1, 2, 3, 4, 5]));

  const canonicalOrder = [...candidates].sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
  for (let index = 1; index < canonicalOrder.length; index += 1) {
    assert.notEqual(first.get(canonicalOrder[index - 1].id), first.get(canonicalOrder[index].id));
  }
});

test('assignAuthors rejects missing candidates and author pools smaller than two users', () => {
  assert.throws(() => assignAuthors([], [1, 2]), /candidate/i);
  assert.throws(() => assignAuthors(candidates, [1]), /at least two/i);
});

test('assignBackfillDates fills five stable buckets in the previous 30 days', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  const first = assignBackfillDates(candidates, { now, days: 30 });
  const second = assignBackfillDates([...candidates].reverse(), { now, days: 30 });
  const bucketMs = 6 * DAY_MS;
  const bucketIndexes = [];

  assert.deepEqual([...first.entries()].map(([id, date]) => [id, date.toISOString()]).sort(), [...second.entries()].map(([id, date]) => [id, date.toISOString()]).sort());

  for (const date of first.values()) {
    assert.ok(date < now);
    assert.ok(date >= new Date(now.getTime() - 30 * DAY_MS));
    bucketIndexes.push(Math.floor((now.getTime() - date.getTime()) / bucketMs));
  }
  assert.equal(new Set(bucketIndexes).size, 5);
});
