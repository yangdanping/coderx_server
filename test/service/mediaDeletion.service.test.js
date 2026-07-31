const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

let createMediaDeletionService;
try {
  ({ createMediaDeletionService } = require('@/service/mediaDeletion.service'));
} catch {
  createMediaDeletionService = undefined;
}

test('media deletion: staged R2 keys are deleted idempotently before the caller removes file rows', async () => {
  assert.equal(typeof createMediaDeletionService, 'function');
  const calls = [];
  const service = createMediaDeletionService({
    mediaObjectService: {
      async prepareR2Deletion(fileIds) {
        calls.push({ type: 'stage', fileIds });
        return [
          { id: 1, fileId: 41, objectKey: 'articles/9/images/41/hash-original.jpg' },
          { id: 2, fileId: 41, objectKey: 'articles/9/images/41/hash-small.jpg' },
        ];
      },
    },
    r2Store: {
      async delete(key) {
        calls.push({ type: 'delete', key });
      },
    },
  });

  const result = await service.deleteR2ObjectsForFiles([41]);

  assert.deepEqual(result, { staged: 2, deleted: 2 });
  assert.deepEqual(calls, [
    { type: 'stage', fileIds: [41] },
    { type: 'delete', key: 'articles/9/images/41/hash-original.jpg' },
    { type: 'delete', key: 'articles/9/images/41/hash-small.jpg' },
  ]);
});

test('media deletion: an R2 failure stops database deletion so a later retry can finish cleanup', async () => {
  assert.equal(typeof createMediaDeletionService, 'function');
  const service = createMediaDeletionService({
    mediaObjectService: {
      async prepareR2Deletion() {
        return [{ id: 1, fileId: 41, objectKey: 'articles/9/images/41/hash-original.jpg' }];
      },
    },
    r2Store: {
      async delete() {
        throw new Error('R2 unavailable');
      },
    },
  });

  await assert.rejects(service.deleteR2ObjectsForFiles([41]), /R2 unavailable/);
});
