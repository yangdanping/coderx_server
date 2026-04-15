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
    contentHtml: '<h1>Title</h1>\n',
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
    Result.success(serviceArticle),
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
  assert.deepEqual(ctx.body, Result.success(serviceArticle));
});

test('getDetail: history write failure does not block a successful detail response', async () => {
  const calls = [];
  const serviceArticle = {
    id: 88,
    title: 'Still works',
    content: 'Body',
    contentHtml: '<p>Body</p>\n',
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
    Result.success(serviceArticle),
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
      contentHtml: '文章已被封禁',
      contentJson: null,
      images: [],
      videos: [],
      excerpt: '文章已被封禁',
      status: 2,
    }),
  );
});

test('getDetail: masks structured content and media payload when article status is truthy', async () => {
  const articleService = {
    async getArticleById() {
      return {
        id: 102,
        title: 'Should hide',
        content: 'Top secret',
        contentHtml: '<p>Top secret</p>',
        contentJson: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Top secret' }] }],
        },
        images: [{ id: 1, url: 'http://example.com/article/images/secret.jpg' }],
        videos: [{ id: 2, url: 'http://example.com/article/video/secret.mp4' }],
        excerpt: 'Top secret',
        status: 1,
      };
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    params: { articleId: '102' },
  };

  await withSilentConsoleLog(() => controller.getDetail(ctx, noopNext));

  assert.deepEqual(
    ctx.body,
    Result.success({
      id: 102,
      title: '文章已被封禁',
      content: '文章已被封禁',
      contentHtml: '文章已被封禁',
      contentJson: null,
      images: [],
      videos: [],
      excerpt: '文章已被封禁',
      status: 1,
    }),
  );
});

test('getList: sanitizes list items, masks banned items, parses idList, and falls back invalid pageOrder to date', async () => {
  const calls = [];
  const longExcerpt = 'a'.repeat(80);
  const serviceList = [
    { id: 1, title: 'Keep', excerpt: longExcerpt, status: 0 },
    { id: 2, title: 'Hide me', excerpt: 'secret', status: 5 },
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

  const expectedPreview = longExcerpt.slice(0, 50);

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
        { id: 1, title: 'Keep', excerpt: expectedPreview, status: 0 },
        { id: 2, title: '文章已被封禁', excerpt: '文章已被封禁', status: 5 },
      ],
      total: 23,
    }),
  );
});

test('getList: prefers excerpt for preview output when structured preview is available', async () => {
  const articleService = {
    async getArticleList() {
      return [
        {
          id: 1,
          title: 'Keep',
          content: '<p>legacy body</p>',
          excerpt: '结构化摘要',
          status: 0,
        },
      ];
    },
    async getTotal() {
      return 1;
    },
  };

  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    query: {},
  };

  await withSilentConsoleLog(() => controller.getList(ctx, noopNext));

  assert.deepEqual(
    ctx.body,
    Result.success({
      result: [
        {
          id: 1,
          title: 'Keep',
          excerpt: '结构化摘要',
          status: 0,
        },
      ],
      total: 1,
    }),
  );
});

test('addArticle: forwards optional draftId to service (strict positive int)', async () => {
  const calls = [];
  const contentJson = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '结构化正文' }] }],
  };
  const articleService = {
    async addArticle(userId, title, draftId, incomingContentJson) {
      calls.push({ method: 'addArticle', userId, title, draftId, contentJson: incomingContentJson });
      return { insertId: 1, affectedRows: 1 };
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 42 },
    request: { body: { title: 'T', contentJson, draftId: 15 } },
  };

  await controller.addArticle(ctx, noopNext);

  assert.deepEqual(calls, [
    {
      method: 'addArticle',
      userId: 42,
      title: 'T',
      draftId: 15,
      contentJson,
    },
  ]);
  assert.deepEqual(ctx.body, Result.success({ insertId: 1, affectedRows: 1 }));
});

test('addArticle: missing structured content returns Result.fail without calling service', async () => {
  const calls = [];
  const articleService = {
    async addArticle() {
      calls.push({ method: 'addArticle' });
      return { insertId: 2, affectedRows: 1 };
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 1 },
    request: { body: { title: 'T' } },
  };

  await controller.addArticle(ctx, noopNext);

  assert.deepEqual(calls, []);
  assert.deepEqual(ctx.body, Result.fail('参数错误: contentJson 不能为空'));
});

test('addArticle: invalid contentJson returns Result.fail without calling service', async () => {
  let called = false;
  const articleService = {
    async addArticle() {
      called = true;
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 1 },
    request: { body: { title: 'T', contentJson: 'oops' } },
  };

  await controller.addArticle(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: contentJson 必须是对象'));
});

test('addArticle: invalid draftId returns Result.fail without calling service', async () => {
  let called = false;
  const articleService = {
    async addArticle() {
      called = true;
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 1 },
    request: { body: { title: 'T', draftId: 'oops' } },
  };

  await controller.addArticle(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: draftId 必须是正整数'));
});

test('update: forwards userId, articleId, optional draftId to service', async () => {
  const calls = [];
  const contentJson = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '结构化更新' }] }],
  };
  const articleService = {
    async update(userId, title, articleId, draftId, incomingContentJson) {
      calls.push({ method: 'update', userId, title, articleId, draftId, contentJson: incomingContentJson });
      return { affectedRows: 1 };
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 99 },
    params: { articleId: '200' },
    request: { body: { title: 'T2', contentJson, draftId: 3 } },
  };

  await controller.update(ctx, noopNext);

  assert.deepEqual(calls, [
    {
      method: 'update',
      userId: 99,
      title: 'T2',
      articleId: '200',
      draftId: 3,
      contentJson,
    },
  ]);
  assert.deepEqual(ctx.body, Result.success({ affectedRows: 1 }));
});

test('update: invalid contentJson returns Result.fail without calling service', async () => {
  let called = false;
  const articleService = {
    async update() {
      called = true;
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 99 },
    params: { articleId: '200' },
    request: { body: { title: 'T2', contentJson: 'oops' } },
  };

  await controller.update(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: contentJson 必须是对象'));
});

test('update: missing structured content returns Result.fail without calling service', async () => {
  let called = false;
  const articleService = {
    async update() {
      called = true;
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 99 },
    params: { articleId: '200' },
    request: { body: { title: 'T2' } },
  };

  await controller.update(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: contentJson 不能为空'));
});

test('update: invalid draftId returns Result.fail without calling service', async () => {
  let called = false;
  const articleService = {
    async update() {
      called = true;
    },
  };
  const controller = loadControllerWithServiceMocks({ articleService, historyService: {} });
  const ctx = {
    user: { id: 99 },
    params: { articleId: '200' },
    request: { body: { title: 'T2', draftId: 'oops' } },
  };

  await controller.update(ctx, noopNext);

  assert.equal(called, false);
  assert.deepEqual(ctx.body, Result.fail('参数错误: draftId 必须是正整数'));
});
