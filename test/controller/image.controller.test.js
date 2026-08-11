const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/image.controller.js');
const imageServicePath = path.resolve(__dirname, '../../src/service/image.service.js');
const deleteFilePath = path.resolve(__dirname, '../../src/utils/deleteFile.js');
const mediaRuntimePath = path.resolve(__dirname, '../../src/service/mediaRuntime.service.js');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithMocks({ imageService, deleteFile = () => {}, mediaRuntime = {} }) {
  delete require.cache[controllerPath];
  delete require.cache[imageServicePath];
  delete require.cache[deleteFilePath];
  delete require.cache[mediaRuntimePath];

  injectCache(imageServicePath, imageService);
  injectCache(deleteFilePath, deleteFile);
  injectCache(mediaRuntimePath, mediaRuntime);

  return require(controllerPath);
}

test('updateFile: empty uploaded array clears article image links instead of failing validation', async () => {
  const calls = [];
  const imageService = {
    async updateImageArticle(userId, articleId, imageIds, coverImageId) {
      calls.push({ userId, articleId, imageIds, coverImageId });
      return { success: true, affectedRows: 0, deletedCount: 2, coverSet: false };
    },
  };

  const controller = loadControllerWithMocks({ imageService });
  const ctx = {
    user: { id: 7 },
    params: { articleId: '15' },
    request: {
      body: {
        uploaded: [],
      },
    },
  };

  await controller.updateFile(ctx, async () => {});

  assert.deepEqual(calls, [{ userId: 7, articleId: '15', imageIds: [], coverImageId: null }]);
  assert.equal(ctx.body.code, 0);
  assert.deepEqual(ctx.body.data, {
    success: true,
    affectedRows: 0,
    deletedCount: 2,
    coverSet: false,
  });
});

test('updateFile forwards the authenticated user to the ownership-checked service', async () => {
  const calls = [];
  const imageService = {
    async updateImageArticle(userId, articleId, imageIds, coverImageId) {
      calls.push({ userId, articleId, imageIds, coverImageId });
      return { success: true };
    },
  };
  const controller = loadControllerWithMocks({ imageService });
  const ctx = {
    user: { id: 7 },
    params: { articleId: '15' },
    request: {
      body: {
        uploaded: [{ id: 41, isCover: false }],
      },
    },
  };

  await controller.updateFile(ctx);

  assert.deepEqual(calls, [{ userId: 7, articleId: '15', imageIds: [41], coverImageId: null }]);
});

test('updateFile rejects uploaded entries without safe positive integer IDs', async () => {
  const calls = [];
  const controller = loadControllerWithMocks({
    imageService: {
      async updateImageArticle(...args) {
        calls.push(args);
      },
    },
  });
  const ctx = {
    user: { id: 7 },
    params: { articleId: '15' },
    request: { body: { uploaded: [{ id: Number.MAX_SAFE_INTEGER + 1 }] } },
  };

  await controller.updateFile(ctx);

  assert.deepEqual(calls, []);
  assert.equal(ctx.body.code, -1);
});

test('deleteFile refuses images that are owned by another user or already attached', async () => {
  const imageService = {
    async deleteOwnedUnattachedImages() {
      const BusinessError = require('../../src/errors/BusinessError');
      throw new BusinessError('图片不可删除', 403);
    },
  };
  const controller = loadControllerWithMocks({ imageService, mediaRuntime: {} });
  const ctx = { user: { id: 7 }, request: { body: { uploaded: [{ id: 41 }] } } };

  await assert.rejects(() => controller.deleteFile(ctx), /图片不可删除/);
});

test('deleteFile delegates owner-scoped durable deletion to the service', async () => {
  const calls = [];
  const imageService = {
    async deleteOwnedUnattachedImages(userId, imageIds) {
      calls.push({ userId, imageIds });
      return {
        result: { affectedRows: 1 },
        imagesToDelete: [{ id: 41, filename: 'cover.jpg', file_type: 'image' }],
        localCleanup: { examined: 2, deleted: 2, missing: 0, failed: 0, pendingIds: [] },
      };
    },
  };
  const controller = loadControllerWithMocks({ imageService });
  const ctx = {
    user: { id: 7 },
    request: { body: { uploaded: [{ id: 41 }] } },
  };

  await controller.deleteFile(ctx);

  assert.deepEqual(calls, [{ userId: 7, imageIds: [41] }]);
  assert.equal(ctx.body.code, 0);
  assert.equal(ctx.body.data, '已删除1张图片成功');
});

test('deleteFile rejects non-array and unsafe uploaded IDs before calling the service', async () => {
  const calls = [];
  const controller = loadControllerWithMocks({
    imageService: {
      async deleteOwnedUnattachedImages(...args) {
        calls.push(args);
      },
    },
  });

  for (const uploaded of [null, [{ id: 0 }], [{ id: 1.5 }], [{ id: '41' }]]) {
    const ctx = { user: { id: 7 }, request: { body: { uploaded } } };
    await controller.deleteFile(ctx);
    assert.equal(ctx.body.code, -1);
  }
  assert.deepEqual(calls, []);
});
