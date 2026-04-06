const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/comment.controller.js');
const commentServicePath = path.resolve(__dirname, '../../src/service/comment.service.js');
const userServicePath = path.resolve(__dirname, '../../src/service/user.service.js');

const Result = require('@/app/Result');
const Utils = require('@/utils');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithCommentServiceMock(commentService) {
  delete require.cache[controllerPath];
  delete require.cache[commentServicePath];
  delete require.cache[userServicePath];

  injectCache(commentServicePath, commentService);
  injectCache(userServicePath, {});

  return require(controllerPath);
}

test.afterEach(() => {
  delete require.cache[controllerPath];
  delete require.cache[commentServicePath];
  delete require.cache[userServicePath];
});

async function withSilentConsole(callback) {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = () => {};
  console.error = () => {};

  try {
    return await callback();
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
}

test('getCommentList: userId branch sanitizes regular comments and masks banned comments', async () => {
  const calls = [];
  const longHtml = '<b>ab</b>' + 'c'.repeat(60);
  const commentService = {
    async getUserCommentList(userId, offset, limit) {
      calls.push({ method: 'getUserCommentList', userId, offset, limit });
      return [
        { id: 1, content: longHtml, status: 0 },
        { id: 2, content: 'secret', status: 3 },
      ];
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    query: { userId: '7', offset: '20', limit: '10' },
  };

  await withSilentConsole(() => controller.getCommentList(ctx));

  let expectedPlain = Utils.removeHTMLTag(longHtml);
  if (expectedPlain.length > 50) {
    expectedPlain = expectedPlain.slice(0, 50);
  }

  assert.deepEqual(calls, [{ method: 'getUserCommentList', userId: '7', offset: '20', limit: '10' }]);
  assert.deepEqual(
    ctx.body,
    Result.success([
      { id: 1, content: expectedPlain, status: 0 },
      { id: 2, content: '评论已被封禁', status: 3 },
    ]),
  );
});

test('getCommentList: userId branch returns the explicit fail payload when service returns null', async () => {
  const calls = [];
  const commentService = {
    async getUserCommentList(userId, offset, limit) {
      calls.push({ method: 'getUserCommentList', userId, offset, limit });
      return null;
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    query: { userId: '7', offset: '20', limit: '10' },
  };

  await withSilentConsole(() => controller.getCommentList(ctx));

  assert.deepEqual(calls, [{ method: 'getUserCommentList', userId: '7', offset: '20', limit: '10' }]);
  assert.deepEqual(ctx.body, Result.fail('获取用户评论列表失败!'));
});

test('getCommentList: article branch falls back invalid sort to latest and appends totalCount', async () => {
  const calls = [];
  const serviceResult = {
    items: [{ id: 10, content: 'ok', status: 0 }],
    nextCursor: 'cursor-2',
    hasMore: true,
  };
  const commentService = {
    async getCommentList(articleId, cursor, limit, sort) {
      calls.push({ method: 'getCommentList', articleId, cursor, limit, sort });
      return serviceResult;
    },
    async getTotalCount(articleId) {
      calls.push({ method: 'getTotalCount', articleId });
      return 12;
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    query: { articleId: '9', cursor: 'cursor-1', limit: '3', sort: 'weird-order' },
  };

  await withSilentConsole(() => controller.getCommentList(ctx));

  assert.deepEqual(calls, [
    { method: 'getCommentList', articleId: '9', cursor: 'cursor-1', limit: 3, sort: 'latest' },
    { method: 'getTotalCount', articleId: '9' },
  ]);
  assert.deepEqual(
    ctx.body,
    Result.success({
      ...serviceResult,
      totalCount: 12,
    }),
  );
});

test('getCommentList: returns Result.fail when articleId is missing and userId branch is not used', async () => {
  const calls = [];
  const commentService = {
    async getUserCommentList() {
      calls.push({ method: 'getUserCommentList' });
      return [];
    },
    async getCommentList() {
      calls.push({ method: 'getCommentList' });
      return { items: [], nextCursor: null, hasMore: false };
    },
    async getTotalCount() {
      calls.push({ method: 'getTotalCount' });
      return 0;
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    query: {},
  };

  await withSilentConsole(() => controller.getCommentList(ctx));

  assert.deepEqual(calls, []);
  assert.deepEqual(ctx.body, Result.fail('articleId is required'));
});

test('getCommentList: article branch returns fail when commentService.getCommentList throws', async () => {
  const calls = [];
  const commentService = {
    async getCommentList(articleId, cursor, limit, sort) {
      calls.push({ method: 'getCommentList', articleId, cursor, limit, sort });
      throw new Error('boom');
    },
    async getTotalCount(articleId) {
      calls.push({ method: 'getTotalCount', articleId });
      return 99;
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    query: { articleId: '5', limit: '2', sort: 'hot' },
  };

  await withSilentConsole(() => controller.getCommentList(ctx));

  assert.deepEqual(calls, [{ method: 'getCommentList', articleId: '5', cursor: null, limit: 2, sort: 'hot' }]);
  assert.deepEqual(ctx.body, Result.fail('获取评论列表失败'));
});

test('getReplies: empty cursor becomes null and non-positive limit falls back to 10', async () => {
  const calls = [];
  const serviceResult = {
    items: [{ id: 21, content: 'reply' }],
    nextCursor: 'cursor-3',
    hasMore: true,
    replyCount: 8,
  };
  const commentService = {
    async getReplies(commentId, cursor, limit) {
      calls.push({ method: 'getReplies', commentId, cursor, limit });
      return serviceResult;
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    params: { commentId: '12' },
    query: { cursor: '', limit: '-5' },
  };

  await withSilentConsole(() => controller.getReplies(ctx));

  assert.deepEqual(calls, [{ method: 'getReplies', commentId: '12', cursor: null, limit: 10 }]);
  assert.deepEqual(ctx.body, Result.success(serviceResult));
});

test('getReplies: passes through explicit cursor and positive limit', async () => {
  const calls = [];
  const serviceResult = {
    items: [{ id: 31, content: 'reply 2' }],
    nextCursor: null,
    hasMore: false,
    replyCount: 1,
  };
  const commentService = {
    async getReplies(commentId, cursor, limit) {
      calls.push({ method: 'getReplies', commentId, cursor, limit });
      return serviceResult;
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    params: { commentId: '13' },
    query: { cursor: 'cursor-2', limit: '3' },
  };

  await withSilentConsole(() => controller.getReplies(ctx));

  assert.deepEqual(calls, [{ method: 'getReplies', commentId: '13', cursor: 'cursor-2', limit: 3 }]);
  assert.deepEqual(ctx.body, Result.success(serviceResult));
});

test('getReplies: returns fail payload when commentService.getReplies throws', async () => {
  const calls = [];
  const commentService = {
    async getReplies(commentId, cursor, limit) {
      calls.push({ method: 'getReplies', commentId, cursor, limit });
      throw new Error('boom');
    },
  };

  const controller = loadControllerWithCommentServiceMock(commentService);
  const ctx = {
    params: { commentId: '14' },
    query: {},
  };

  await withSilentConsole(() => controller.getReplies(ctx));

  assert.deepEqual(calls, [{ method: 'getReplies', commentId: '14', cursor: null, limit: 10 }]);
  assert.deepEqual(ctx.body, Result.fail('获取回复列表失败'));
});
