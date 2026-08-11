const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/flowDraft.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/draft.service.js');
const Result = require('@/app/Result');

function loadControllerWithServiceMock(serviceMock) {
  delete require.cache[controllerPath];
  delete require.cache[servicePath];

  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: serviceMock,
  };

  return require(controllerPath);
}

const noopNext = async () => {};

test('saveFlowDraft: forwards only normalized Flow content, meta, and version', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async upsertFlowDraft(userId, payload) {
      calls.push({ userId, payload });
      return { id: 71, draftType: 'flow', version: 2 };
    },
  });
  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        draftType: 'article',
        articleId: 22,
        title: 'ignored',
        content: { type: 'doc', content: [] },
        meta: { imageIds: [11], videoIds: [] },
        version: '1',
      },
    },
  };

  await controller.saveFlowDraft(ctx, noopNext);

  assert.deepEqual(calls, [
    {
      userId: 9,
      payload: {
        content: { type: 'doc', content: [] },
        meta: { imageIds: [11], videoIds: [] },
        version: 1,
      },
    },
  ]);
  assert.deepEqual(ctx.body, Result.success({ id: 71, draftType: 'flow', version: 2 }));
});

test('saveFlowDraft: rejects non-object content without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertFlowDraft() {
      called = true;
    },
  });
  const ctx = { user: { id: 9 }, request: { body: { content: '<p>unsafe</p>', meta: {}, version: 0 } } };

  await controller.saveFlowDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: content 必须是对象'));
});

test('saveFlowDraft: rejects non-object meta without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertFlowDraft() {
      called = true;
    },
  });
  const ctx = { user: { id: 9 }, request: { body: { content: { type: 'doc' }, meta: [], version: 0 } } };

  await controller.saveFlowDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: meta 必须是对象'));
});

test('saveFlowDraft: rejects unsafe or exponential versions without calling service', async () => {
  for (const version of ['1e2', '9007199254740993']) {
    let called = false;
    const controller = loadControllerWithServiceMock({
      async upsertFlowDraft() {
        called = true;
      },
    });
    const ctx = { user: { id: 9 }, request: { body: { content: { type: 'doc' }, meta: {}, version } } };

    await controller.saveFlowDraft(ctx, noopNext);

    assert.equal(called, false);
    assert.deepEqual(ctx.body, Result.fail('参数错误: version 必须是非负整数'));
  }
});

test('getFlowDraft: returns the current user active Flow draft', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async getFlowDraft(userId) {
      calls.push(userId);
      return { id: 71, draftType: 'flow', version: 2 };
    },
  });
  const ctx = { user: { id: 9 } };

  await controller.getFlowDraft(ctx, noopNext);

  assert.deepEqual(calls, [9]);
  assert.deepEqual(ctx.body, Result.success({ id: 71, draftType: 'flow', version: 2 }));
});

test('deleteFlowDraft: normalizes a positive draft id and delegates to type-scoped service', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async deleteFlowDraft(userId, draftId) {
      calls.push({ userId, draftId });
      return { id: draftId };
    },
  });
  const ctx = { user: { id: 9 }, params: { draftId: '71' } };

  await controller.deleteFlowDraft(ctx, noopNext);

  assert.deepEqual(calls, [{ userId: 9, draftId: 71 }]);
  assert.deepEqual(ctx.body, Result.success({ id: 71 }));
});

test('deleteFlowDraft: rejects invalid draft ids without calling service', async () => {
  for (const draftId of ['0', 'oops', '9007199254740993']) {
    let called = false;
    const controller = loadControllerWithServiceMock({
      async deleteFlowDraft() {
        called = true;
      },
    });
    const ctx = { user: { id: 9 }, params: { draftId } };

    await controller.deleteFlowDraft(ctx, noopNext);

    assert.equal(called, false);
    assert.deepEqual(ctx.body, Result.fail('参数错误: draftId 必须是正整数'));
  }
});
