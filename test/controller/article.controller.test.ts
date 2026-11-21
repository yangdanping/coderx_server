import assert from 'node:assert/strict';
import test from 'node:test';
import type { MiddlewareHandler } from 'hono';
import { createHttpApp } from '../../src/http/app.js';
import type { AppEnv } from '../../src/http/types.js';
import { registerArticleRoutes } from '../../src/router/article.router.js';
import type { ArticleService } from '../../src/service/article/article.types.js';

const contentJson = { type: 'doc', content: [] };
const unused = () => assert.fail('Unexpected dependency call');
const continueRequest: MiddlewareHandler<AppEnv> = async (_c, next) => { await next(); };

function fixture(
  overrides: Partial<ArticleService>,
  userId?: number,
  addHistory: (userId: unknown, articleId: string) => Promise<unknown> = unused,
) {
  return createHttpApp({
    buildId: 'article-controller', checkReady: async () => false,
    registerRoutes(app) {
      if (userId !== undefined) app.use('*', async (c, next) => { c.set('user', { id: userId }); await next(); });
      registerArticleRoutes(app, {
        service: {
          addArticle: unused, addView: unused, getArticleById: unused, getArticleList: unused,
          getTotal: unused, getRecommendArticleList: unused, getRandomTocArticle: unused,
          getArticlesByKeyWords: unused, getArticleLikedById: unused, update: unused, delete: unused,
          clearTag: unused, batchAddTags: unused, ...overrides,
        },
        likeService: { toggleArticleLike: unused },
        fileService: { getFileByFilename: unused },
        historyService: { addHistory },
        tagService: { getTagByName: unused, addTag: unused },
        imageRoot: '', videoRoot: '',
        maintenance: continueRequest, verifyAuth: continueRequest, verifyStatus: continueRequest, verifyPermission: continueRequest,
      });
    },
  });
}

test('article detail preserves rendered content and tolerates a failed history write', async t => {
  const article = { id: 99, title: 'Hello', content: '# Title', contentHtml: '<h1>Title</h1>\n', status: 0 };
  t.mock.method(console, 'log', () => {});
  for (const [userId, fail] of [[undefined, false], [7, false], [12, true]] as const) {
    const calls: unknown[][] = [];
    const app = fixture({
      async getArticleById(id) { calls.push(['detail', id]); return { ...article }; },
    }, userId, async (id, articleId) => {
      calls.push(['history', id, articleId]);
      if (fail) throw new Error('history unavailable');
    });
    const response = await app.request('/article/99');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: article, code: 0 });
    assert.deepEqual(calls, userId === undefined ? [['detail', '99']] : [['detail', '99'], ['history', userId, '99']]);
  }
});

test('article detail masks structured content and media for banned articles', async () => {
  const message = '文章已被封禁';
  const app = fixture({
    async getArticleById() {
      return {
        id: 102, title: 'private title', content: 'private content', status: 2,
        contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'private content' }] }] },
        contentHtml: '<p>private content</p>', excerpt: 'private excerpt',
        images: [{ id: 1, url: '/hidden.png' }], videos: [{ id: 2, url: '/hidden.mp4' }],
      };
    },
  });
  const response = await app.request('/article/102');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 0, data: {
    id: 102, status: 2, title: message, content: message, contentHtml: message, excerpt: message,
    contentJson: null, images: [], videos: [],
  } });
});

test('article creates and updates with a normalized optional draft ID', async () => {
  const calls: unknown[][] = [];
  const result = { affectedRows: 1 };
  const app = fixture({
    async addArticle(...args) { calls.push(args); return result; },
    async update(...args) { calls.push(args); return result; },
  }, 7);
  for (const [method, path] of [['POST', '/article'], ['PUT', '/article/22']] as const) {
    const request = async (body: unknown) => {
      const response = await app.request(path, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    for (const [body, msg] of [
      [{ title: 'Test' }, '参数错误: contentJson 不能为空'],
      [{ title: 'Test', contentJson: [] }, '参数错误: contentJson 必须是对象'],
      [{ title: 'Test', contentJson, draftId: '1e2' }, '参数错误: draftId 必须是正整数'],
    ] as const) {
      assert.deepEqual(await request(body), { code: -1, msg });
    }
    assert.deepEqual(await request({ title: 'Test', contentJson, draftId: '14' }), { code: 0, data: result });
  }
  assert.deepEqual(calls, [[7, 'Test', 14, contentJson], [7, 'Test', '22', 14, contentJson]]);
});
