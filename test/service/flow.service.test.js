const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const BusinessError = require('@/errors/BusinessError');
const { createFlowService } = require('@/service/flow.service');

const REQUEST_ID = '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf';
const CONTENT = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

function noDatabase() {
  return {
    async getConnection() {
      throw new Error('database must not be used');
    },
    async execute() {
      throw new Error('database must not be used');
    },
  };
}

function serviceWith(options = {}) {
  return createFlowService({
    database: options.database || noDatabase(),
    mediaRuntime: options.mediaRuntime || {
      async promotePublishedImages() {},
      async resolveImageUrl() {
        return null;
      },
    },
    logger: options.logger || { error() {} },
    publicApiOrigin: options.publicApiOrigin || 'https://api.example.test',
  });
}

test('createFlow rejects malformed Tiptap roots and recursively embedded media nodes', async () => {
  const service = serviceWith();
  const invalidDocs = [
    null,
    [],
    { type: 'paragraph', content: [] },
    { type: 'doc', content: {} },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'x' } }] }] },
    { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'video', attrs: { src: 'x' } }] }] },
    { type: 'doc', content: [{ content: [] }] },
  ];
  for (const content of invalidDocs) {
    await assert.rejects(service.createFlow(7, { clientRequestId: REQUEST_ID, content, mediaIds: [1] }), BusinessError);
  }
});

test('createFlow derives normalized text and rejects over 2000 chars or empty text plus no media', async () => {
  const service = serviceWith();
  await assert.rejects(
    service.createFlow(7, {
      clientRequestId: REQUEST_ID,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2001) }] }] },
      mediaIds: [],
    }),
    (error) => error instanceof BusinessError && /2000/.test(error.message),
  );
  await assert.rejects(
    service.createFlow(7, { clientRequestId: REQUEST_ID, content: { type: 'doc', content: [] }, mediaIds: [] }),
    (error) => error instanceof BusinessError && /正文或图片/.test(error.message),
  );
});

test('createFlow rejects duplicate, excessive, unsafe, string, and non-positive media IDs', async () => {
  const service = serviceWith();
  const invalidLists = [[1, 1], Array.from({ length: 10 }, (_, index) => index + 1), [0], [-1], ['1'], [1.5], [Number.MAX_SAFE_INTEGER + 1]];
  for (const mediaIds of invalidLists) {
    await assert.rejects(service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds }), BusinessError);
  }
});

function createAtomicDatabase({ lockedRows, insertId = 90, mediaInsertError = null, detailRow = null, existingImages = [] }) {
  const events = [];
  const conn = {
    async beginTransaction() {
      events.push('begin');
    },
    async execute(sql, params) {
      if (/INSERT INTO flow_post \(/i.test(sql)) {
        events.push({ type: 'insert-flow', params });
        return [{ insertId, affectedRows: insertId ? 1 : 0 }];
      }
      if (/FROM file f/i.test(sql) && /FOR UPDATE OF f/i.test(sql)) {
        events.push({ type: 'lock-media', params });
        return [lockedRows];
      }
      if (/INSERT INTO flow_post_media/i.test(sql)) {
        events.push({ type: 'insert-media', params });
        if (mediaInsertError) throw mediaInsertError;
        return [{ affectedRows: lockedRows.length }];
      }
      if (/UPDATE draft/i.test(sql)) {
        events.push({ type: 'consume-draft', params, sql });
        return [{ affectedRows: 1, insertId: 0 }];
      }
      throw new Error(`unexpected transactional SQL: ${sql}`);
    },
    async commit() {
      events.push('commit');
    },
    async rollback() {
      events.push('rollback');
    },
    release() {
      events.push('release');
    },
  };
  const database = {
    async getConnection() {
      return conn;
    },
    async execute(sql, params) {
      if (/WHERE user_id = \? AND client_request_id = \?/i.test(sql)) {
        events.push({ type: 'find-existing', params });
        return [[{ id: 90 }]];
      }
      if (/FROM flow_post_media fm/i.test(sql) && /INNER JOIN file f/i.test(sql) && !/WHERE fp\.id/i.test(sql)) {
        events.push({ type: 'load-existing-media', params });
        return [existingImages];
      }
      if (/WHERE fp\.id = \?/i.test(sql)) {
        events.push({ type: 'detail', params });
        return [
          [
            detailRow || {
              id: 90,
              content: CONTENT,
              bodyText: 'hello',
              createAt: new Date('2026-08-11T00:00:00.000Z'),
              author: { id: 7, name: 'account', nickname: 'Display', avatarUrl: '/user/7/avatar' },
              media: lockedRows.map((row, position) => ({ id: row.id, position, altText: '' })),
            },
          ],
        ];
      }
      throw new Error(`unexpected root SQL: ${sql}`);
    },
  };
  return { database, events };
}

test('createFlow locks and binds only current-user unattached images in submitted order, consumes the Flow draft, commits, then promotes neutrally', async () => {
  const lockedRows = [
    { id: 41, filename: '41.webp', mimetype: 'image/webp' },
    { id: 42, filename: '42.webp', mimetype: 'image/webp' },
  ];
  const { database, events } = createAtomicDatabase({ lockedRows });
  const promotionCalls = [];
  const mediaRuntime = {
    async promotePublishedImages(payload) {
      events.push('promote');
      promotionCalls.push(payload);
    },
    async resolveImageUrl(id, { variant }) {
      return `https://media.example/${id}-${variant}.webp`;
    },
  };
  const service = serviceWith({ database, mediaRuntime });

  const result = await service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [42, 41], bodyHtml: '<script>x</script>' });

  const insertFlow = events.find((event) => event.type === 'insert-flow');
  assert.deepEqual(insertFlow.params, [7, REQUEST_ID, JSON.stringify(CONTENT), 'hello']);
  assert.deepEqual(events.find((event) => event.type === 'insert-media').params, [90, 42, 0, 90, 41, 1]);
  const consume = events.find((event) => event.type === 'consume-draft');
  assert.deepEqual(consume.params, [7]);
  assert.match(consume.sql, /draft_type = 'flow'/i);
  assert.match(consume.sql, /status = 'consumed'/i);
  assert.match(consume.sql, /consumed_at = NOW\(\)/i);
  assert.match(consume.sql, /discarded_at = NULL/i);
  assert.match(consume.sql, /consumed_article_id = NULL/i);
  assert.ok(events.indexOf('commit') < events.indexOf('promote'));
  assert.deepEqual(promotionCalls, [{ images: [lockedRows[1], lockedRows[0]] }]);
  assert.equal(result.body, 'hello');
  assert.equal(result.bodyHtml, '<p>hello</p>');
});

test('createFlow rolls back atomically when any media association fails', async () => {
  const { database, events } = createAtomicDatabase({
    lockedRows: [{ id: 41, filename: '41.webp', mimetype: 'image/webp' }],
    mediaInsertError: new Error('association failed'),
  });
  let promoted = false;
  const service = serviceWith({
    database,
    mediaRuntime: {
      async promotePublishedImages() {
        promoted = true;
      },
      async resolveImageUrl() {
        return null;
      },
    },
  });

  await assert.rejects(service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] }), /association failed/);

  assert.ok(events.includes('rollback'));
  assert.equal(events.includes('commit'), false);
  assert.equal(
    events.some((event) => event.type === 'consume-draft'),
    false,
  );
  assert.equal(promoted, false);
});

test('createFlow rejects missing, foreign, attached, and non-image IDs when the ownership lock cannot return every row', async (t) => {
  for (const reason of ['missing', 'foreign', 'article-attached', 'draft-attached', 'flow-attached', 'non-image']) {
    await t.test(reason, async () => {
      const { database, events } = createAtomicDatabase({ lockedRows: [] });
      const service = serviceWith({ database });
      await assert.rejects(
        service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] }),
        (error) => error instanceof BusinessError && error.httpStatus === 409,
      );
      assert.ok(events.includes('rollback'));
      assert.equal(
        events.some((event) => event.type === 'insert-media'),
        false,
      );
    });
  }
});

test('idempotent retry rolls back before selecting outside the transaction, re-promotes existing media, and never consumes a newer draft', async () => {
  const existingImages = [{ id: 41, filename: '41.webp', mimetype: 'image/webp' }];
  const { database, events } = createAtomicDatabase({ lockedRows: [], insertId: 0, existingImages });
  const promotionCalls = [];
  const service = serviceWith({
    database,
    mediaRuntime: {
      async promotePublishedImages(payload) {
        promotionCalls.push(payload);
      },
      async resolveImageUrl() {
        return null;
      },
    },
  });

  const result = await service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

  assert.equal(result.id, 90);
  assert.deepEqual(
    events.slice(0, 5).map((event) => (typeof event === 'string' ? event : event.type)),
    ['begin', 'insert-flow', 'rollback', 'release', 'find-existing'],
  );
  assert.equal(
    events.some((event) => event.type === 'lock-media'),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'consume-draft'),
    false,
  );
  assert.deepEqual(promotionCalls, [{ images: existingImages }]);
});

test('promotion failure is contained after commit and cannot roll back the published Flow', async () => {
  const lockedRows = [{ id: 41, filename: '41.webp', mimetype: 'image/webp' }];
  const { database, events } = createAtomicDatabase({ lockedRows });
  const errors = [];
  const service = serviceWith({
    database,
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
    mediaRuntime: {
      async promotePublishedImages() {
        events.push('promote');
        throw new Error('R2 unavailable');
      },
      async resolveImageUrl() {
        return null;
      },
    },
  });

  const result = await service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

  assert.equal(result.id, 90);
  assert.ok(events.indexOf('commit') < events.indexOf('promote'));
  assert.equal(events.filter((event) => event === 'rollback').length, 0);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /promotion/i);
});

test('promotion state-machine failure summaries are logged without rolling back the published Flow', async () => {
  const lockedRows = [{ id: 41, filename: '41.webp', mimetype: 'image/webp' }];
  const { database, events } = createAtomicDatabase({ lockedRows });
  const errors = [];
  const service = serviceWith({
    database,
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
    mediaRuntime: {
      async promotePublishedImages() {
        return { attempted: 2, ready: 1, failed: 1, failures: [{ fileId: 41, variant: 'small', code: 'R2_UNAVAILABLE' }] };
      },
      async resolveImageUrl() {
        return null;
      },
    },
  });

  const result = await service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

  assert.equal(result.id, 90);
  assert.equal(events.includes('rollback'), false);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /promotion/i);
  assert.equal(errors[0][1].failed, 1);
});

test('zero-media text-only Flow is committed without a lock, media insert, or promotion work', async () => {
  const { database, events } = createAtomicDatabase({ lockedRows: [] });
  const promotionCalls = [];
  const service = serviceWith({
    database,
    mediaRuntime: {
      async promotePublishedImages(payload) {
        promotionCalls.push(payload);
      },
      async resolveImageUrl() {
        return null;
      },
    },
  });
  const result = await service.createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [] });
  assert.equal(result.id, 90);
  assert.equal(
    events.some((event) => event.type === 'lock-media'),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'insert-media'),
    false,
  );
  assert.ok(events.includes('commit'));
  assert.deepEqual(promotionCalls, [{ images: [] }]);
});

test('feed and detail hydrate server-derived HTML, display author, avatar, counters, and ordered original/small media URLs', async () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<safe>' }] }] };
  const row = {
    id: 12,
    content,
    bodyText: '<safe>',
    createAt: new Date('2026-08-11T00:00:00.000Z'),
    author: { id: 5, name: 'account-name', nickname: 'Display Name', avatarUrl: '/user/5/avatar' },
    media: [
      { id: 9, position: 1, altText: 'second' },
      { id: 8, position: 0, altText: 'first' },
    ],
  };
  const resolveCalls = [];
  const database = {
    async execute(sql, params) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 1 }]];
      if (/LIMIT \? OFFSET \?/i.test(sql)) {
        assert.deepEqual(params, [10, 10]);
        return [[row]];
      }
      if (/WHERE fp\.id = \?/i.test(sql)) return [[row]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const service = serviceWith({
    database,
    mediaRuntime: {
      async promotePublishedImages() {},
      async resolveImageUrl(id, { variant }) {
        resolveCalls.push({ id, variant });
        return variant === 'small' && id === 9 ? null : `https://media.example/${id}-${variant}`;
      },
    },
  });

  const page = await service.getFlowFeed(2, 10);
  const detail = await service.getFlowDetail(12);

  assert.deepEqual(page, { items: [detail], total: 1, page: 2, pageSize: 10 });
  assert.deepEqual(detail.author, {
    id: 5,
    name: 'Display Name',
    username: 'account-name',
    avatarUrl: 'https://api.example.test/user/5/avatar',
  });
  assert.equal(detail.body, '<safe>');
  assert.equal(detail.bodyHtml, '<p>&lt;safe&gt;</p>');
  assert.deepEqual(detail.media, [
    { id: 8, url: 'https://media.example/8-original', thumbnailUrl: 'https://media.example/8-small', title: 'first' },
    { id: 9, url: 'https://media.example/9-original', thumbnailUrl: 'https://media.example/9-original', title: 'second' },
  ]);
  assert.equal(detail.likes, 0);
  assert.equal(detail.comments, 0);
  assert.equal(detail.liked, false);
  assert.deepEqual(
    resolveCalls.map(({ variant }) => variant),
    ['original', 'small', 'original', 'small', 'original', 'small', 'original', 'small'],
  );
});

test('getFlowDetail rejects an absent Flow', async () => {
  const service = serviceWith({
    database: {
      async execute() {
        return [[]];
      },
    },
  });
  await assert.rejects(service.getFlowDetail(404), (error) => error instanceof BusinessError && error.httpStatus === 404);
});
