const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/draft.controller.js');
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

test('saveDraft: normalizes request payload and responds with Result.success', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async upsertDraft(userId, payload) {
      calls.push({ userId, payload });
      return { id: 41, version: 2 };
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: { imageIds: [11], videoIds: [], selectedTagIds: [3] },
        version: '1',
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.deepEqual(calls, [
    {
      userId: 9,
      payload: {
        articleId: null,
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: { imageIds: [11], videoIds: [], selectedTagIds: [3] },
        version: 1,
      },
    },
  ]);
  assert.deepEqual(ctx.body, Result.success({ id: 41, version: 2 }));
});

test('saveDraft: invalid content returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        title: 'Draft',
        content: 'not-an-object',
        meta: {},
        version: 0,
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: content 必须是对象'));
});

test('saveDraft: invalid meta returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: 'oops',
        version: 0,
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: meta 必须是对象'));
});

test('saveDraft: invalid articleId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        articleId: 'oops',
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: 0,
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: articleId 必须是正整数'));
});

test('saveDraft: empty-string articleId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        articleId: '',
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: 0,
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: articleId 必须是正整数'));
});

test('saveDraft: unsafe articleId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        articleId: '9007199254740993',
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: 0,
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: articleId 必须是正整数'));
});

test('saveDraft: exponential version string returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: '1e2',
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: version 必须是非负整数'));
});

test('saveDraft: unsafe version returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async upsertDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 9 },
    request: {
      body: {
        title: 'Draft',
        content: { type: 'doc', content: [] },
        meta: {},
        version: '9007199254740993',
      },
    },
  };

  await controller.saveDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: version 必须是非负整数'));
});

test('getDraft: loads new-article draft via service (active-only filtering lives in service/SQL)', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async getDraft(userId, articleId) {
      calls.push({ userId, articleId });
      return { id: 51, articleId: null, version: 3 };
    },
  });

  const ctx = {
    user: { id: 7 },
  };

  await controller.getDraft(ctx, noopNext);

  assert.deepEqual(calls, [{ userId: 7, articleId: null }]);
  assert.deepEqual(ctx.body, Result.success({ id: 51, articleId: null, version: 3 }));
});

test('getDraftByArticleId: loads edit draft for the given article id', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async getDraft(userId, articleId) {
      calls.push({ userId, articleId });
      return { id: 61, articleId: 12, version: 5 };
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { articleId: '12' },
  };

  await controller.getDraftByArticleId(ctx, noopNext);

  assert.deepEqual(calls, [{ userId: 7, articleId: 12 }]);
  assert.deepEqual(ctx.body, Result.success({ id: 61, articleId: 12, version: 5 }));
});

test('getDraftByArticleId: returns success(null) when no active draft exists', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async getDraft(userId, articleId) {
      calls.push({ userId, articleId });
      return null;
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { articleId: '12' },
  };

  await controller.getDraftByArticleId(ctx, noopNext);

  assert.deepEqual(calls, [{ userId: 7, articleId: 12 }]);
  assert.deepEqual(ctx.body, Result.success(null));
});

test('getDraftByArticleId: invalid articleId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async getDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { articleId: 'oops' },
  };

  await controller.getDraftByArticleId(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: articleId 必须是正整数'));
});

test('getDraftByArticleId: unsafe articleId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async getDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { articleId: '9007199254740993' },
  };

  await controller.getDraftByArticleId(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: articleId 必须是正整数'));
});

test('deleteDraft: DELETE maps to service discard and returns success id', async () => {
  const calls = [];
  const controller = loadControllerWithServiceMock({
    async deleteDraft(userId, draftId) {
      calls.push({ userId, draftId });
      return { id: 88 };
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { draftId: '88' },
  };

  await controller.deleteDraft(ctx, noopNext);

  assert.deepEqual(calls, [{ userId: 7, draftId: 88 }]);
  assert.deepEqual(ctx.body, Result.success({ id: 88 }));
});

test('deleteDraft: invalid draftId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async deleteDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { draftId: 'oops' },
  };

  await controller.deleteDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: draftId 必须是正整数'));
});

test('deleteDraft: unsafe draftId returns Result.fail without calling service', async () => {
  let called = false;
  const controller = loadControllerWithServiceMock({
    async deleteDraft() {
      called = true;
    },
  });

  const ctx = {
    user: { id: 7 },
    params: { draftId: '9007199254740993' },
  };

  await controller.deleteDraft(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: draftId 必须是正整数'));
});
