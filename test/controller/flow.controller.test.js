const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Koa = require('koa');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/flow.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/flow.service.js');
const routerPath = path.resolve(__dirname, '../../src/router/flow.router.js');
const flowDraftRouterPath = path.resolve(__dirname, '../../src/router/flowDraft.router.js');
const flowDraftControllerPath = path.resolve(__dirname, '../../src/controller/flowDraft.controller.js');
const authPath = path.resolve(__dirname, '../../src/middleware/auth.middleware.js');
const maintenancePath = path.resolve(__dirname, '../../src/middleware/mediaMaintenance.middleware.js');
const Result = require('@/app/Result');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

function loadController(service) {
  delete require.cache[controllerPath];
  delete require.cache[servicePath];
  injectCache(servicePath, service);
  return require(controllerPath);
}

test('createFlow validates and forwards only the authenticated structured payload', async () => {
  const calls = [];
  const controller = loadController({
    async createFlow(userId, input) {
      calls.push({ userId, input });
      return { id: 90 };
    },
  });
  const ctx = {
    user: { id: 7 },
    request: {
      body: {
        clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf',
        content: { type: 'doc', content: [] },
        mediaIds: [42, 41],
        bodyHtml: '<img src=x onerror=alert(1)>',
      },
    },
  };

  await controller.createFlow(ctx);

  assert.deepEqual(calls, [
    {
      userId: 7,
      input: {
        clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf',
        content: { type: 'doc', content: [] },
        mediaIds: [42, 41],
      },
    },
  ]);
  assert.deepEqual(ctx.body, Result.success({ id: 90 }));
});

test('createFlow rejects malformed boundary inputs without calling the service', async (t) => {
  const invalidInputs = [
    ['invalid UUID', { clientRequestId: 'not-a-uuid', content: { type: 'doc' }, mediaIds: [] }],
    ['non-doc content', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'paragraph' }, mediaIds: [] }],
    ['non-array media', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'doc' }, mediaIds: '42' }],
    ['too many media', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'doc' }, mediaIds: Array.from({ length: 10 }, (_, index) => index + 1) }],
    ['duplicate media', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'doc' }, mediaIds: [4, 4] }],
    ['unsafe media id', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'doc' }, mediaIds: [Number.MAX_SAFE_INTEGER + 1] }],
    ['string media id', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'doc' }, mediaIds: ['4'] }],
    ['non-positive media id', { clientRequestId: '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf', content: { type: 'doc' }, mediaIds: [0] }],
  ];

  for (const [name, body] of invalidInputs) {
    await t.test(name, async () => {
      let called = false;
      const controller = loadController({
        async createFlow() {
          called = true;
        },
      });
      const ctx = { user: { id: 7 }, request: { body } };
      await controller.createFlow(ctx);
      assert.equal(called, false);
      assert.equal(ctx.body.code, -1);
      assert.match(ctx.body.msg, /参数错误/);
    });
  }
});

test('getFlowFeed validates page params and returns a stable page', async () => {
  const calls = [];
  const controller = loadController({
    async getFlowFeed(page, pageSize) {
      calls.push({ page, pageSize });
      return { items: [], total: 0, page, pageSize };
    },
  });
  const ctx = { query: { pageNum: '2', pageSize: '20' } };

  await controller.getFlowFeed(ctx);

  assert.deepEqual(calls, [{ page: 2, pageSize: 20 }]);
  assert.deepEqual(ctx.body, Result.success({ items: [], total: 0, page: 2, pageSize: 20 }));
});

test('getFlowFeed rejects invalid explicit page params', async () => {
  for (const query of [{ pageNum: '0' }, { pageNum: '1e2' }, { pageSize: '0' }, { pageSize: '101' }, { pageSize: '1.5' }]) {
    let called = false;
    const controller = loadController({
      async getFlowFeed() {
        called = true;
      },
    });
    const ctx = { query };
    await controller.getFlowFeed(ctx);
    assert.equal(called, false);
    assert.equal(ctx.body.code, -1);
    assert.match(ctx.body.msg, /分页参数/);
  }
});

test('getFlowDetail validates a positive flowId at the controller boundary', async () => {
  const calls = [];
  const controller = loadController({
    async getFlowDetail(flowId) {
      calls.push(flowId);
      return { id: flowId };
    },
  });
  const validCtx = { params: { flowId: '42' } };
  await controller.getFlowDetail(validCtx);
  assert.deepEqual(calls, [42]);
  assert.deepEqual(validCtx.body, Result.success({ id: 42 }));

  for (const flowId of ['draft', '0', '-1', '1e2', '9007199254740993']) {
    const ctx = { params: { flowId } };
    await controller.getFlowDetail(ctx);
    assert.deepEqual(calls, [42]);
    assert.equal(ctx.body.code, -1);
    assert.match(ctx.body.msg, /flowId/);
  }
});

test('flow router keeps reads public, gates publish before auth, and does not shadow GET /flow/draft', async (t) => {
  for (const modulePath of [routerPath, flowDraftRouterPath, controllerPath, flowDraftControllerPath, authPath, maintenancePath]) {
    delete require.cache[modulePath];
  }
  injectCache(controllerPath, {
    async createFlow(ctx) {
      ctx.body = { source: 'flow-create' };
    },
    async getFlowFeed(ctx) {
      ctx.body = { source: 'flow-feed' };
    },
    async getFlowDetail(ctx) {
      ctx.body = { source: 'flow-detail', flowId: ctx.params.flowId };
    },
  });
  injectCache(flowDraftControllerPath, {
    async saveFlowDraft(ctx) {
      ctx.body = { source: 'draft-save' };
    },
    async getFlowDraft(ctx) {
      ctx.body = { source: 'flow-draft' };
    },
    async deleteFlowDraft(ctx) {
      ctx.body = { source: 'draft-delete' };
    },
  });
  const verifyAuth = async (ctx, next) => next();
  const mediaMutationMaintenance = async (ctx, next) => next();
  injectCache(authPath, { verifyAuth });
  injectCache(maintenancePath, mediaMutationMaintenance);

  const app = new Koa();
  const flowRouter = require(routerPath);
  const flowDraftRouter = require(flowDraftRouterPath);
  const postLayer = flowRouter.stack.find((layer) => layer.methods.includes('POST'));
  const feedLayer = flowRouter.stack.find((layer) => layer.methods.includes('GET') && layer.path === '/flow');
  const detailLayer = flowRouter.stack.find((layer) => layer.methods.includes('GET') && layer.path instanceof RegExp);
  assert.deepEqual(postLayer.stack.slice(0, 2), [mediaMutationMaintenance, verifyAuth]);
  assert.equal(feedLayer.stack.includes(verifyAuth), false);
  assert.equal(detailLayer.stack.includes(verifyAuth), false);
  app.use(flowRouter.routes()).use(flowDraftRouter.routes());
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/flow/draft`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { source: 'flow-draft' });

  const detailResponse = await fetch(`http://127.0.0.1:${server.address().port}/flow/42`);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(await detailResponse.json(), { source: 'flow-detail', flowId: '42' });
});
