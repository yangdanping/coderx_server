const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/collect.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/collect.service.js');
const routerPath = path.resolve(__dirname, '../../src/router/collect.router.js');
const authPath = path.resolve(__dirname, '../../src/middleware/auth.middleware.js');
const collectMiddlewarePath = path.resolve(__dirname, '../../src/middleware/collect.middleware.js');
const Result = require('@/app/Result');

function inject(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

function loadController(service) {
  delete require.cache[controllerPath];
  inject(servicePath, service);
  return require(controllerPath);
}

test('removeCollectArticle passes collection and selected article IDs and returns remaining IDs', async () => {
  const calls = [];
  const controller = loadController({
    async removeCollectArticle(...args) { calls.push(args); },
    async getCollectArticle(collectId) { calls.push(['get', collectId]); return { collectedArticle: [31] }; },
  });
  const ctx = { params: { collectId: '7' }, query: { idList: '[11,12]' } };
  await controller.removeCollectArticle(ctx);
  assert.deepEqual(calls, [[7, [11, 12]], ['get', 7]]);
  assert.deepEqual(ctx.body, Result.success({ collectedArticle: [31] }));
});

test('removeCollectArticle rejects malformed input before calling the service', async () => {
  const calls = [];
  const controller = loadController({
    async removeCollectArticle() { calls.push('remove'); },
    async getCollectArticle() { calls.push('get'); },
  });
  const invalid = [
    ['0', '[11]'], ['1.5', '[11]'], ['1e2', '[11]'], ['9007199254740993', '[11]'],
    ['7', 'oops'], ['7', '{}'], ['7', '[0]'], ['7', '[-1]'], ['7', '[1.5]'],
    ['7', '["11"]'], ['7', '[9007199254740993]'],
  ];
  for (const [collectId, idList] of invalid) {
    const ctx = { params: { collectId }, query: { idList } };
    await controller.removeCollectArticle(ctx);
    assert.equal(ctx.body.code, -1, `${collectId}: ${idList}`);
  }
  assert.deepEqual(calls, []);
});

test('collection batch removal route requires authentication and ownership', () => {
  delete require.cache[routerPath];
  const verifyAuth = async (_ctx, next) => next();
  const verifyPermission = async (_ctx, next) => next();
  inject(authPath, { verifyAuth, verifyPermission });
  inject(collectMiddlewarePath, { verifycollectExists: async (_ctx, next) => next() });
  inject(controllerPath, {
    addCollect() {}, getList() {}, collectArticle() {}, updateCollect() {}, removeCollect() {}, removeCollectArticle() {},
  });
  const router = require(routerPath);
  const route = router.stack.find((layer) => layer.path === '/collect/:collectId/articles' && layer.methods.includes('DELETE'));
  assert.deepEqual(route.stack.slice(0, 2), [verifyAuth, verifyPermission]);
});
