const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/history.controller.js');
const servicePath = path.resolve(__dirname, '../../src/service/history.service.js');
const Result = require('@/app/Result');
const Utils = require('@/utils');

function loadControllerWithHistoryServiceMock(serviceMock) {
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

test('addHistory: calls historyService.addHistory(userId, articleId) and sets Result.success', async () => {
  const calls = [];
  const serviceReturn = { affectedRows: 1 };
  const historyService = {
    async addHistory(userId, articleId) {
      calls.push({ userId, articleId });
      return serviceReturn;
    },
  };

  const controller = loadControllerWithHistoryServiceMock(historyService);
  const ctx = {
    user: { id: 42 },
    request: { body: { articleId: 99 } },
  };

  await controller.addHistory(ctx, noopNext);

  assert.deepEqual(calls, [{ userId: 42, articleId: 99 }]);
  assert.deepEqual(ctx.body, Result.success(serviceReturn));
});

test('getUserHistory: loads list and count, sanitizes non-banned content, masks banned, sets Result.success payload', async () => {
  const originalConsoleLog = console.log;
  const calls = [];
  const longExcerpt = 'ab' + 'c'.repeat(60);
  const historyList = [
    { id: 1, title: 'Keep', excerpt: longExcerpt, status: 0 },
    { id: 2, title: 'Will mask', excerpt: 'x', status: 1 },
  ];

  const historyService = {
    async getUserHistory(userId, offset, limit) {
      calls.push({ method: 'getUserHistory', userId, offset, limit });
      return historyList;
    },
    async getUserHistoryCount(userId) {
      calls.push({ method: 'getUserHistoryCount', userId });
      return 77;
    },
  };

  const controller = loadControllerWithHistoryServiceMock(historyService);
  const ctx = {
    user: { id: 7 },
    query: { offset: '20', limit: '10' },
  };

  console.log = () => {};

  try {
    await controller.getUserHistory(ctx, noopNext);
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(calls, [
    { method: 'getUserHistory', userId: 7, offset: '20', limit: '10' },
    { method: 'getUserHistoryCount', userId: 7 },
  ]);

  const expectedExcerpt = longExcerpt.slice(0, 50);

  assert.deepEqual(ctx.body, {
    code: 0,
    data: {
      result: [
        { id: 1, title: 'Keep', excerpt: expectedExcerpt, status: 0 },
        { id: 2, title: '文章已被封禁', excerpt: '文章已被封禁', status: 1 },
      ],
      total: 77,
      pageNum: 3,
      pageSize: 10,
    },
  });
});
