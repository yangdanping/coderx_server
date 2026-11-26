import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpApp } from '../../src/http/app.js';
import { registerDraftRoutes } from '../../src/router/draft.router.js';
import type { DraftService } from '../../src/service/article/article.types.js';

const content = { type: 'doc', content: [] };
const meta = { imageIds: [11], videoIds: [], selectedTagIds: [3] };

function fixture(overrides: Partial<DraftService> = {}) {
  return createHttpApp({
    buildId: 'draft-controller', checkReady: async () => true,
    registerRoutes(app) {
      registerDraftRoutes(app, {
        verifyAuth: async (c, next) => { c.set('user', { id: 9 }); await next(); },
        service: {
          async upsertDraft() { return assert.fail('Unexpected draft save'); },
          async getDraft() { return assert.fail('Unexpected draft read'); },
          async deleteDraft() { return assert.fail('Unexpected draft deletion'); },
          ...overrides,
        },
      });
    },
  });
}

async function save(app: ReturnType<typeof fixture>, body: unknown) {
  const response = await app.request('/draft', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('draft save forwards normalized fields and returns the service result', async () => {
  const calls: unknown[][] = [];
  const app = fixture({
    async upsertDraft(...args) { calls.push(args); return { id: 41, version: 2 }; },
  });
  assert.deepEqual(await save(app, { title: 'Draft', content, meta, version: '1' }), { code: 0, data: { id: 41, version: 2 } });
  assert.deepEqual(calls, [[9, { articleId: null, title: 'Draft', content, meta, version: 1 }]]);
});

test('draft save rejects invalid content, metadata and unsafe integers before reaching storage', async () => {
  const app = fixture();
  const payload = { title: 'Draft', content, meta, version: 0 };
  for (const [patch, msg] of [
    [{ content: 'not-an-object' }, '参数错误: content 必须是对象'],
    [{ meta: [] }, '参数错误: meta 必须是对象'],
    [{ articleId: -1 }, '参数错误: articleId 必须是正整数'],
    [{ articleId: '' }, '参数错误: articleId 必须是正整数'],
    [{ articleId: Number.MAX_SAFE_INTEGER + 1 }, '参数错误: articleId 必须是正整数'],
    [{ version: '1e1' }, '参数错误: version 必须是非负整数'],
    [{ version: Number.MAX_SAFE_INTEGER + 1 }, '参数错误: version 必须是非负整数'],
  ] as const) {
    assert.deepEqual(await save(app, { ...payload, ...patch }), { code: -1, msg });
  }
});

test('draft reads distinguish new, edit, missing and invalid drafts', async () => {
  const calls: unknown[][] = [];
  const app = fixture({
    async getDraft(...args) { calls.push(args); return args[1] === 11 ? null : { id: 7 }; },
  });
  for (const [path, expected] of [
    ['/draft', { code: 0, data: { id: 7 } }],
    ['/draft/10', { code: 0, data: { id: 7 } }],
    ['/draft/11', { code: 0, data: null }],
    ['/draft/invalid', { code: -1, msg: '参数错误: articleId 必须是正整数' }],
    ['/draft/9007199254740992', { code: -1, msg: '参数错误: articleId 必须是正整数' }],
  ] as const) {
    assert.deepEqual(await (await app.request(path)).json(), expected);
  }
  assert.deepEqual(calls, [[9, null], [9, 10], [9, 11]]);
});

test('draft deletion is owner scoped and rejects invalid and unsafe draft IDs', async () => {
  const calls: unknown[][] = [];
  const app = fixture({
    async deleteDraft(...args) { calls.push(args); return { id: args[1] }; },
  });
  assert.deepEqual(await (await app.request('/draft/8', { method: 'DELETE' })).json(), { code: 0, data: { id: 8 } });
  for (const id of ['invalid', '9007199254740992']) {
    assert.deepEqual(await (await app.request(`/draft/${id}`, { method: 'DELETE' })).json(), { code: -1, msg: '参数错误: draftId 必须是正整数' });
  }
  assert.deepEqual(calls, [[9, 8]]);
});
