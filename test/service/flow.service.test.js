const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const BusinessError = require('@/errors/BusinessError');
const { createFlowService } = require('@/service/flow.service');

const REQUEST_ID = '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf';
const DRAFT = { id: 71, version: 1 };
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
    await assert.rejects(service.createFlow(7, { draft: null, clientRequestId: REQUEST_ID, content, mediaIds: [1] }), BusinessError);
  }
});

test('createFlow derives normalized text and rejects over 2000 chars or empty text plus no media', async () => {
  const service = serviceWith();
  await assert.rejects(
    service.createFlow(7, {
      draft: null,
      clientRequestId: REQUEST_ID,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2001) }] }] },
      mediaIds: [],
    }),
    (error) => error instanceof BusinessError && /2000/.test(error.message),
  );
  await assert.rejects(
    service.createFlow(7, { draft: null, clientRequestId: REQUEST_ID, content: { type: 'doc', content: [] }, mediaIds: [] }),
    (error) => error instanceof BusinessError && /正文或图片/.test(error.message),
  );
});

test('createFlow rejects duplicate, excessive, unsafe, string, and non-positive media IDs', async () => {
  const service = serviceWith();
  const invalidLists = [[1, 1], Array.from({ length: 10 }, (_, index) => index + 1), [0], [-1], ['1'], [1.5], [Number.MAX_SAFE_INTEGER + 1]];
  for (const mediaIds of invalidLists) {
    await assert.rejects(service.createFlow(7, { draft: null, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds }), BusinessError);
  }
});

test('createFlow independently rejects missing and malformed draft identities before touching the database', async (t) => {
  const invalidDrafts = [
    ['missing', {}],
    ['undefined', { draft: undefined }],
    ['array', { draft: [] }],
    ['array with fields', { draft: Object.assign([], DRAFT) }],
    ['boolean', { draft: false }],
    ['string', { draft: '71' }],
    ['missing id', { draft: { version: 1 } }],
    ['missing version', { draft: { id: 71 } }],
    ['string id', { draft: { id: '71', version: 1 } }],
    ['string version', { draft: { id: 71, version: '1' } }],
    ['zero id', { draft: { id: 0, version: 1 } }],
    ['negative id', { draft: { id: -1, version: 1 } }],
    ['zero version', { draft: { id: 71, version: 0 } }],
    ['fractional version', { draft: { id: 71, version: 1.5 } }],
    ['unsafe id', { draft: { id: Number.MAX_SAFE_INTEGER + 1, version: 1 } }],
    ['unsafe version', { draft: { id: 71, version: Number.MAX_SAFE_INTEGER + 1 } }],
    ['NaN version', { draft: { id: 71, version: NaN } }],
  ];
  for (const [name, draftFields] of invalidDrafts) {
    await t.test(name, async () => {
      await assert.rejects(
        serviceWith().createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [], ...draftFields }),
        (error) => error instanceof BusinessError && error.httpStatus === 400 && /draft/.test(error.message),
      );
    });
  }
});

function createAtomicDatabase({
  lockedRows,
  validatedRows = lockedRows,
  activeDraftId = 71,
  activeDraftVersion = 1,
  insertId = 90,
  mediaInsertError = null,
  detailRow = null,
  existingImages = [],
}) {
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
      if (/FROM draft/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        events.push({ type: 'lock-draft', params });
        return [activeDraftId ? [{ id: activeDraftId, version: activeDraftVersion }] : []];
      }
      if (/FROM file f/i.test(sql) && /FOR UPDATE OF f/i.test(sql)) {
        events.push({ type: 'lock-media', params });
        return [lockedRows];
      }
      if (/INNER JOIN image_meta/i.test(sql)) {
        events.push({ type: 'validate-media', params });
        return [typeof validatedRows === 'function' ? validatedRows(params) : validatedRows];
      }
      if (/UPDATE file/i.test(sql) && /SET draft_id = NULL/i.test(sql)) {
        events.push({ type: 'clear-draft-binding', params });
        return [{ affectedRows: lockedRows.length }];
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

test('createFlow rejects a newer version of the same draft before locking images or consuming it', async () => {
  const { database, events } = createAtomicDatabase({ lockedRows: [{ id: 41 }], activeDraftVersion: 2 });
  await assert.rejects(
    serviceWith({ database }).createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41], draft: DRAFT }),
    (error) => error instanceof BusinessError && error.httpStatus === 409 && /草稿已发生变更.*重新打开编辑器/.test(error.message),
  );
  assert.deepEqual(events.find((event) => event.type === 'lock-draft').params, [71, 7]);
  assert.equal(
    events.some((event) => ['lock-media', 'insert-media', 'consume-draft'].includes(event.type)),
    false,
  );
  assert.equal(events.includes('commit'), false);
  assert.ok(events.includes('rollback'));
});

test('createFlow rejects an unavailable requested draft and never substitutes a newer draft', async (t) => {
  for (const [name, activeDraftId] of [
    ['unavailable requested draft', null],
    ['newer draft instead of requested id', 72],
  ]) {
    await t.test(name, async () => {
      const { database, events } = createAtomicDatabase({ lockedRows: [], activeDraftId });
      await assert.rejects(
        serviceWith({ database }).createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [], draft: DRAFT }),
        (error) => error instanceof BusinessError && error.httpStatus === 409 && /草稿已发生变更/.test(error.message),
      );
      assert.deepEqual(events.find((event) => event.type === 'lock-draft').params, [71, 7]);
      assert.equal(
        events.some((event) => event.type === 'consume-draft'),
        false,
      );
      assert.equal(events.includes('commit'), false);
      assert.ok(events.includes('rollback'));
    });
  }
});

test('createFlow with draft null publishes unattached images while preserving every active draft', async () => {
  const { database, events } = createAtomicDatabase({ lockedRows: [{ id: 41 }], activeDraftId: 72, activeDraftVersion: 4 });
  await serviceWith({ database }).createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41], draft: null });
  assert.deepEqual(events.find((event) => event.type === 'validate-media').params, [7, null, 41]);
  assert.equal(
    events.some((event) => ['lock-draft', 'clear-draft-binding', 'consume-draft'].includes(event.type)),
    false,
  );
  assert.ok(events.includes('commit'));
});

test('createFlow with draft null rejects media still bound to an unreferenced draft', async () => {
  const { database, events } = createAtomicDatabase({
    lockedRows: [{ id: 41 }],
    activeDraftId: 72,
    validatedRows(params) {
      return params[1] === 72 ? [{ id: 41 }] : [];
    },
  });
  await assert.rejects(
    serviceWith({ database }).createFlow(7, { clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41], draft: null }),
    (error) => error instanceof BusinessError && error.httpStatus === 409,
  );
  assert.deepEqual(events.find((event) => event.type === 'validate-media').params, [7, null, 41]);
  assert.equal(
    events.some((event) => ['lock-draft', 'clear-draft-binding', 'insert-media', 'consume-draft'].includes(event.type)),
    false,
  );
  assert.ok(events.includes('rollback'));
});

test('createFlow accepts unsaved body edits over a matching saved draft version', async () => {
  const editedContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsaved editor changes' }] }] };
  const { database, events } = createAtomicDatabase({ lockedRows: [] });
  await serviceWith({ database }).createFlow(7, { clientRequestId: REQUEST_ID, content: editedContent, mediaIds: [], draft: DRAFT });
  assert.deepEqual(events.find((event) => event.type === 'insert-flow').params, [7, REQUEST_ID, JSON.stringify(editedContent), 'unsaved editor changes']);
  assert.deepEqual(events.find((event) => event.type === 'consume-draft').params, [71, 7, null]);
  assert.ok(events.includes('commit'));
});

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

  const result = await service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [42, 41], bodyHtml: '<script>x</script>' });

  const insertFlow = events.find((event) => event.type === 'insert-flow');
  assert.deepEqual(insertFlow.params, [7, REQUEST_ID, JSON.stringify(CONTENT), 'hello']);
  assert.deepEqual(events.find((event) => event.type === 'lock-media').params, [7, 42, 41]);
  assert.deepEqual(events.find((event) => event.type === 'insert-media').params, [90, 42, 0, 90, 41, 1]);
  const consume = events.find((event) => event.type === 'consume-draft');
  assert.deepEqual(consume.params, [71, 7, null]);
  assert.match(consume.sql, /draft_type = 'flow'/i);
  assert.match(consume.sql, /status = 'consumed'/i);
  assert.match(consume.sql, /consumed_at = NOW\(\)/i);
  assert.match(consume.sql, /discarded_at = NULL/i);
  assert.match(consume.sql, /consumed_article_id = \$3/i);
  assert.ok(events.indexOf('commit') < events.indexOf('promote'));
  assert.deepEqual(promotionCalls, [{ images: [lockedRows[1], lockedRows[0]] }]);
  assert.equal(result.body, 'hello');
  assert.equal(result.bodyHtml, '<p>hello</p>');
});

test('createFlow locks the active Flow draft before files, accepts its safe-upload image, clears the binding, and consumes that exact draft', async () => {
  const events = [];
  const safeImage = {
    id: 41,
    filename: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    mimetype: 'image/webp',
    width: 640,
    height: 480,
  };
  const conn = {
    async beginTransaction() {
      events.push('begin');
    },
    async execute(sql, params) {
      if (/INSERT INTO flow_post \(/i.test(sql)) return [{ insertId: 90, affectedRows: 1 }];
      if (/FROM draft/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        events.push({ type: 'lock-draft', params });
        return [[{ id: 71, version: 1 }]];
      }
      if (/FROM file f/i.test(sql) && /FOR UPDATE OF f/i.test(sql)) {
        events.push({ type: 'lock-files', params, sql });
        return [[{ id: 41 }]];
      }
      if (/INNER JOIN image_meta/i.test(sql)) {
        events.push({ type: 'validate-files', params, sql });
        return [[safeImage]];
      }
      if (/UPDATE file/i.test(sql) && /SET draft_id = NULL/i.test(sql)) {
        events.push({ type: 'clear-draft-binding', params });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO flow_post_media/i.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE draft/i.test(sql)) {
        events.push({ type: 'consume-draft', params });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
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
    async execute(sql) {
      if (/WHERE fp\.id = \?/i.test(sql)) {
        return [[{ id: 90, content: CONTENT, bodyText: 'hello', author: { id: 7, name: 'account' }, media: [] }]];
      }
      throw new Error(`unexpected root SQL: ${sql}`);
    },
  };
  const service = serviceWith({ database });

  await service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

  const orderedEvents = events.filter((event) => typeof event === 'object').map((event) => event.type);
  assert.deepEqual(orderedEvents, ['lock-draft', 'lock-files', 'validate-files', 'clear-draft-binding', 'consume-draft']);
  assert.deepEqual(events.find((event) => event.type === 'lock-draft').params, [71, 7]);
  assert.deepEqual(events.find((event) => event.type === 'lock-files').params, [7, 41]);
  assert.deepEqual(events.find((event) => event.type === 'validate-files').params, [7, 71, 41]);
  assert.deepEqual(events.find((event) => event.type === 'clear-draft-binding').params, [71, 41]);
  assert.deepEqual(events.find((event) => event.type === 'consume-draft').params, [71, 7, null]);
});

test('createFlow rejects a locked row that fails safe-upload provenance validation with an exposed 409', async () => {
  const { database, events } = createAtomicDatabase({ lockedRows: [{ id: 41 }], validatedRows: [] });
  const service = serviceWith({ database });

  await assert.rejects(
    service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] }),
    (error) => error instanceof BusinessError && error.httpStatus === 409,
  );
  assert.ok(events.includes('rollback'));
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

  await assert.rejects(service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] }), /association failed/);

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
        service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] }),
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
  const { database, events } = createAtomicDatabase({ lockedRows: [], activeDraftId: 72, activeDraftVersion: 2, insertId: 0, existingImages });
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

  const result = await service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

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

test('idempotent Flow retry re-enters neutral promotion so a repaired failed reservation can become ready', async () => {
  const existingImages = [{ id: 41, filename: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', mimetype: 'image/webp' }];
  const { database, events } = createAtomicDatabase({ lockedRows: [], activeDraftId: 72, activeDraftVersion: 2, insertId: 0, existingImages });
  let reservationStatus = 'failed';
  const service = serviceWith({
    database,
    mediaRuntime: {
      async promotePublishedImages(payload) {
        assert.deepEqual(payload, { images: existingImages });
        assert.equal(reservationStatus, 'failed');
        reservationStatus = 'ready';
        return { attempted: 2, ready: 2, failed: 0 };
      },
      async resolveImageUrl() {
        return null;
      },
    },
  });

  const result = await service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

  assert.equal(result.id, 90);
  assert.equal(reservationStatus, 'ready');
  assert.equal(
    events.some((event) => event.type === 'lock-draft'),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'consume-draft'),
    false,
  );
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

  const result = await service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

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

  const result = await service.createFlow(7, { draft: DRAFT, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [41] });

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
  const result = await service.createFlow(7, { draft: null, clientRequestId: REQUEST_ID, content: CONTENT, mediaIds: [] });
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

test('getFlowDetail emits stable empty-string URL fallbacks when avatar and media resolvers are absent', async () => {
  const service = serviceWith({
    database: {
      async execute() {
        return [[{ id: 51, content: CONTENT, bodyText: 'hello', author: { id: 7, name: 'account', avatarUrl: null }, media: [{ id: 41, position: 0 }] }]];
      },
    },
    mediaRuntime: {
      async promotePublishedImages() {},
      async resolveImageUrl() {
        return null;
      },
    },
  });

  const result = await service.getFlowDetail(51);

  assert.equal(result.author.avatarUrl, '');
  assert.equal(result.media[0].url, '');
  assert.equal(result.media[0].thumbnailUrl, '');
});
