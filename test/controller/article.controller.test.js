const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const controllerPath = path.resolve(__dirname, '../../src/controller/article.controller.js');
const articleServicePath = path.resolve(__dirname, '../../src/service/article.service.js');
const historyServicePath = path.resolve(__dirname, '../../src/service/history.service.js');
const userServicePath = path.resolve(__dirname, '../../src/service/user.service.js');
const fileServicePath = path.resolve(__dirname, '../../src/service/file.service.js');

const Result = require('@/app/Result');
const MdUtils = require('@/utils/MdUtils');
const Utils = require('@/utils');

function injectCache(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadControllerWithServiceMocks({ articleService, historyService }) {
  delete require.cache[controllerPath];
  delete require.cache[articleServicePath];
  delete require.cache[historyServicePath];
  delete require.cache[userServicePath];
  delete require.cache[fileServicePath];

  injectCache(articleServicePath, articleService);
  injectCache(historyServicePath, historyService);
  injectCache(userServicePath, {});
  injectCache(fileServicePath, {});

  return require(controllerPath);
}

async function withSilentConsoleLog(callback) {
  const originalConsoleLog = console.log;
  console.log = () => {};

  try {
    return await callback();
  } finally {
    console.log = originalConsoleLog;
  }
}

function renderHtmlWithoutLogs(content) {
  const originalConsoleLog = console.log;
  console.log = () => {};

  try {
    return MdUtils.renderHtml(content);
  } finally {
    console.log = originalConsoleLog;
  }
}

const noopNext = async () => {};

test('getDetail: logged-in user gets rendered article detail and history is written', async () => {
  const calls = [];
  const serviceArticle = {
    id: 99,
    title: 'Hello',
    content: '# Title',
    status: 0,
  };
  const articleService = {
    async getArticleById(articleId) {
      calls.push({ method: 'getArticleById', articleId });
      return { ...serviceArticle };
    },
  };
  const historyService = {
    async addHistory(userId, articleId) {
      calls.push({ method: 'addHistory', userId, articleId });
      return { affectedRows: 1 };
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService });
  const ctx = {
    params: { articleId: '99' },
    user: { id: 7 },
  };

  await withSilentConsoleLog(() => controller.getDetail(ctx, noopNext));

  assert.deepEqual(calls, [
    { method: 'getArticleById', articleId: '99' },
    { method: 'addHistory', userId: 7, articleId: '99' },
  ]);
  assert.deepEqual(
    ctx.body,
    Result.success({
      ...serviceArticle,
      content: renderHtmlWithoutLogs(serviceArticle.content),
    }),
  );
});

test('getDetail: anonymous user gets rendered detail without writing history', async () => {
  const calls = [];
  const serviceArticle = {
    id: 51,
    title: 'Anon',
    content: 'Plain **markdown**',
    status: 0,
  };
  const articleService = {
    async getArticleById(articleId) {
      calls.push({ method: 'getArticleById', articleId });
      return { ...serviceArticle };
    },
  };
  const historyService = {
    async addHistory(userId, articleId) {
      calls.push({ method: 'addHistory', userId, articleId });
      return { affectedRows: 1 };
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService });
  const ctx = {
    params: { articleId: '51' },
  };

  await withSilentConsoleLog(() => controller.getDetail(ctx, noopNext));

  assert.deepEqual(calls, [{ method: 'getArticleById', articleId: '51' }]);
  assert.deepEqual(
    ctx.body,
    Result.success({
      ...serviceArticle,
      content: renderHtmlWithoutLogs(serviceArticle.content),
    }),
  );
});

test('getDetail: history write failure does not block a successful detail response', async () => {
  const calls = [];
  const serviceArticle = {
    id: 88,
    title: 'Still works',
    content: 'Body',
    status: 0,
  };
  const articleService = {
    async getArticleById(articleId) {
      calls.push({ method: 'getArticleById', articleId });
      return { ...serviceArticle };
    },
  };
  const historyError = new Error('history write failed');
  const historyService = {
    async addHistory(userId, articleId) {
      calls.push({ method: 'addHistory', userId, articleId });
      throw historyError;
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService });
  const ctx = {
    params: { articleId: '88' },
    user: { id: 12 },
  };

  await withSilentConsoleLog(() => controller.getDetail(ctx, noopNext));

  assert.deepEqual(calls, [
    { method: 'getArticleById', articleId: '88' },
    { method: 'addHistory', userId: 12, articleId: '88' },
  ]);
  assert.deepEqual(
    ctx.body,
    Result.success({
      ...serviceArticle,
      content: renderHtmlWithoutLogs(serviceArticle.content),
    }),
  );
});

test('getDetail: masks title and content when article status is truthy', async () => {
  const calls = [];
  const articleService = {
    async getArticleById(articleId) {
      calls.push({ method: 'getArticleById', articleId });
      return {
        id: 101,
        title: 'Should hide',
        content: 'Top secret',
        status: 2,
      };
    },
  };
  const historyService = {
    async addHistory(userId, articleId) {
      calls.push({ method: 'addHistory', userId, articleId });
      return { affectedRows: 1 };
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService });
  const ctx = {
    params: { articleId: '101' },
  };

  await withSilentConsoleLog(() => controller.getDetail(ctx, noopNext));

  assert.deepEqual(calls, [{ method: 'getArticleById', articleId: '101' }]);
  assert.deepEqual(
    ctx.body,
    Result.success({
      id: 101,
      title: '文章已被封禁',
      content: '文章已被封禁',
      status: 2,
    }),
  );
});

test('getList: sanitizes list items, masks banned items, parses idList, and falls back invalid pageOrder to date', async () => {
  const calls = [];
  const longMarkdown = '# Hello\n\n' + 'a'.repeat(80);
  const serviceList = [
    { id: 1, title: 'Keep', content: longMarkdown, status: 0 },
    { id: 2, title: 'Hide me', content: 'secret', status: 5 },
  ];
  const articleService = {
    async getArticleList(offset, limit, tagId, userId, pageOrder, idList, keywords) {
      calls.push({ method: 'getArticleList', offset, limit, tagId, userId, pageOrder, idList, keywords });
      return serviceList;
    },
    async getTotal(tagId, userId, idList, keywords) {
      calls.push({ method: 'getTotal', tagId, userId, idList, keywords });
      return 23;
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    query: {
      offset: '20',
      limit: '10',
      tagId: '3',
      userId: '7',
      pageOrder: 'weird-order',
      idList: '[11,12]',
      keywords: 'hello',
    },
  };

  await withSilentConsoleLog(() => controller.getList(ctx, noopNext));

  let expectedPreview = Utils.removeHTMLTag(renderHtmlWithoutLogs(longMarkdown));
  if (expectedPreview.length > 50) {
    expectedPreview = expectedPreview.slice(0, 50);
  }

  assert.deepEqual(calls, [
    {
      method: 'getArticleList',
      offset: '20',
      limit: '10',
      tagId: '3',
      userId: '7',
      pageOrder: 'date',
      idList: [11, 12],
      keywords: 'hello',
    },
    {
      method: 'getTotal',
      tagId: '3',
      userId: '7',
      idList: [11, 12],
      keywords: 'hello',
    },
  ]);
  assert.deepEqual(
    ctx.body,
    Result.success({
      result: [
        { id: 1, title: 'Keep', content: expectedPreview, status: 0 },
        { id: 2, title: '文章已被封禁', content: '文章已被封禁', status: 5 },
      ],
      total: 23,
    }),
  );
});
