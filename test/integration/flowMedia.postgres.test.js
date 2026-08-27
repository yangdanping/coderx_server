const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

require('module-alias/register');
process.env.NODE_ENV = 'development';

const config = require('../../src/app/config');
const { buildPgPoolConfig } = require('../../src/app/database/pg.config');
const { createPgConnectionAdapter } = require('../../src/app/database/pg.utils');
const BusinessError = require('../../src/errors/BusinessError');
const { createFlowService } = require('../../src/service/flow.service');

const schema = `flow_media_test_${process.pid}`;
const quotedSchema = `"${schema}"`;
const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/012_create_flow_post.sql'), 'utf8');
const CONTENT = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };
const servicePaths = {
  database: path.resolve(__dirname, '../../src/app/database.js'),
  draft: path.resolve(__dirname, '../../src/service/draft.service.js'),
  image: path.resolve(__dirname, '../../src/service/image.service.js'),
  mediaRuntime: path.resolve(__dirname, '../../src/service/mediaRuntime.service.js'),
};

function assertLocalDevelopmentDatabase() {
  let host = config.PGHOST || '';
  if (config.DATABASE_URL) host = new URL(config.DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()), 'Integration migration test refuses a non-local database');
}

async function scopedConnection(pool) {
  const client = await pool.connect();
  await client.query(`SET search_path TO ${quotedSchema}`);
  const connection = createPgConnectionAdapter(client);
  connection.processId = client.processID;
  return connection;
}

function scopedDatabase(pool, onQueryStarted = null, onQueryCompleted = null) {
  return {
    async getConnection() {
      const connection = await scopedConnection(pool);
      if (!onQueryStarted) return connection;
      return {
        ...connection,
        async execute(sql, params = []) {
          const pending = connection.execute(sql, params);
          await onQueryStarted(sql, params, { processId: connection.processId });
          const result = await pending;
          if (onQueryCompleted) await onQueryCompleted(sql, params, { processId: connection.processId });
          return result;
        },
      };
    },
    async execute(sql, params = []) {
      const connection = await scopedConnection(pool);
      try {
        return await connection.execute(sql, params);
      } finally {
        connection.release();
      }
    },
  };
}

function injectCache(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

function loadBinderService(servicePath, database) {
  delete require.cache[servicePath];
  delete require.cache[servicePaths.database];
  delete require.cache[servicePaths.mediaRuntime];
  injectCache(servicePaths.database, database);
  injectCache(servicePaths.mediaRuntime, {
    async promotePublishedImages() {
      return { attempted: 0, ready: 0, failed: 0 };
    },
    async resolveImageUrl() {
      return null;
    },
  });
  return require(servicePath);
}

function flowService(database) {
  return createFlowService({
    database,
    publicApiOrigin: 'https://api.example.test',
    logger: { error() {} },
    mediaRuntime: {
      async promotePublishedImages() {},
      async resolveImageUrl(id, { variant }) {
        return `https://media.example/${id}-${variant}`;
      },
    },
  });
}

async function insertSafeImage(client, userId, suffix, { draftId = null, mimetype = 'image/webp', filename = null, width = 640, height = 480, withMeta = true } = {}) {
  const safeFilename = filename || `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}.webp`;
  const fileId = (
    await client.query(
      `INSERT INTO file (user_id, filename, mimetype, file_type, draft_id)
       VALUES ($1, $2, $3, 'image', $4)
       RETURNING id`,
      [userId, safeFilename, mimetype, draftId],
    )
  ).rows[0].id;
  if (withMeta) {
    await client.query(`INSERT INTO image_meta (file_id, width, height, is_cover) VALUES ($1, $2, $3, FALSE)`, [fileId, width, height]);
  }
  return fileId;
}

async function createActiveFlowDraft(client, userId, version = 1) {
  return (
    await client.query(`INSERT INTO draft (user_id, draft_type, content, version) VALUES ($1, 'flow', $2::jsonb, $3) RETURNING id`, [userId, JSON.stringify(CONTENT), version])
  ).rows[0].id;
}

function assertConflict(result) {
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof BusinessError, `expected BusinessError, received ${result.reason?.constructor?.name}: ${result.reason?.message}`);
  assert.equal(result.reason.httpStatus, 409);
}

async function waitForBackendLock(admin, processId) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [processId]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`backend ${processId} did not enter a PostgreSQL lock wait`);
}

function twoFileLockGate(admin) {
  let notifyFirst;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    notifyFirst = resolve;
  });
  const firstCanContinue = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let startedLockQueries = 0;
  let completedLockQueries = 0;
  return {
    firstStarted,
    async onQueryStarted(sql, _params, context) {
      if (!/FROM file/i.test(sql) || !/FOR UPDATE/i.test(sql)) return;
      startedLockQueries += 1;
      if (startedLockQueries === 2) {
        await waitForBackendLock(admin, context.processId);
        releaseFirst();
      }
    },
    async onQueryCompleted(sql) {
      if (!/FROM file/i.test(sql) || !/FOR UPDATE/i.test(sql)) return;
      completedLockQueries += 1;
      if (completedLockQueries === 1) {
        notifyFirst();
        await firstCanContinue;
      }
    },
  };
}

test('Flow publishing enforces safe provenance, exact draft handoff, idempotency, and cross-binder ownership under PostgreSQL concurrency', async () => {
  assertLocalDevelopmentDatabase();
  const pool = new Pool(buildPgPoolConfig(config));
  const admin = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await admin.query(`SET search_path TO ${quotedSchema}`);
    await admin.query(`CREATE TABLE "user" (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL)`);
    await admin.query(`CREATE TABLE profile (user_id BIGINT PRIMARY KEY REFERENCES "user"(id), nickname TEXT, avatar_url TEXT)`);
    await admin.query(`CREATE TABLE article (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES "user"(id))`);
    await admin.query(`
      CREATE TABLE draft (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES "user"(id),
        draft_type TEXT NOT NULL,
        article_id BIGINT REFERENCES article(id),
        title TEXT,
        content JSONB,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        consumed_at TIMESTAMPTZ,
        discarded_at TIMESTAMPTZ,
        consumed_article_id BIGINT REFERENCES article(id),
        create_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        update_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await admin.query(`CREATE UNIQUE INDEX one_active_flow_draft ON draft(user_id) WHERE draft_type = 'flow' AND status = 'active'`);
    await admin.query(`CREATE UNIQUE INDEX one_active_article_draft ON draft(user_id) WHERE draft_type = 'article' AND article_id IS NULL AND status = 'active'`);
    await admin.query(`
      CREATE TABLE file (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES "user"(id),
        filename TEXT NOT NULL,
        mimetype TEXT,
        size BIGINT,
        file_type TEXT,
        article_id BIGINT REFERENCES article(id),
        draft_id BIGINT REFERENCES draft(id)
      )
    `);
    await admin.query(`CREATE TABLE image_meta (file_id BIGINT PRIMARY KEY REFERENCES file(id), width INTEGER, height INTEGER, is_cover BOOLEAN NOT NULL DEFAULT FALSE)`);
    await admin.query(migration);

    const userId = (await admin.query(`INSERT INTO "user" (name) VALUES ('account') RETURNING id`)).rows[0].id;
    const foreignUserId = (await admin.query(`INSERT INTO "user" (name) VALUES ('foreign') RETURNING id`)).rows[0].id;
    await admin.query(`INSERT INTO profile (user_id, nickname, avatar_url) VALUES ($1, 'Display', NULL)`, [userId]);
    const articleId = (await admin.query(`INSERT INTO article (user_id) VALUES ($1) RETURNING id`, [userId])).rows[0].id;

    const draft1 = await createActiveFlowDraft(admin, userId);
    const media1 = await insertSafeImage(admin, userId, 1, { draftId: draft1 });
    const service = flowService(scopedDatabase(pool));
    const requestId = '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf';
    const first = await service.createFlow(userId, { clientRequestId: requestId, content: CONTENT, mediaIds: [media1] });
    const consumed1 = (await admin.query(`SELECT status, consumed_at, discarded_at, consumed_article_id FROM draft WHERE id = $1`, [draft1])).rows[0];
    assert.equal(consumed1.status, 'consumed');
    assert.ok(consumed1.consumed_at instanceof Date);
    assert.equal(consumed1.discarded_at, null);
    assert.equal(consumed1.consumed_article_id, null);
    assert.equal((await admin.query(`SELECT draft_id FROM file WHERE id = $1`, [media1])).rows[0].draft_id, null);

    const draft2 = await createActiveFlowDraft(admin, userId);
    const retry = await service.createFlow(userId, { clientRequestId: requestId, content: CONTENT, mediaIds: [media1] });
    assert.equal(retry.id, first.id);
    assert.equal((await admin.query(`SELECT status FROM draft WHERE id = $1`, [draft2])).rows[0].status, 'active');
    await admin.query(`UPDATE draft SET status = 'discarded', discarded_at = NOW() WHERE id = $1`, [draft2]);

    const invalidCases = [
      await insertSafeImage(admin, userId, 2, { filename: '1723456789012.webp' }),
      await insertSafeImage(admin, userId, 3, { mimetype: 'image/jpeg' }),
      await insertSafeImage(admin, userId, 4, { withMeta: false }),
      await insertSafeImage(admin, userId, 5, { width: 0 }),
      await insertSafeImage(admin, userId, 6, { height: 2561 }),
      await insertSafeImage(admin, foreignUserId, 7),
    ];
    for (const [index, mediaId] of invalidCases.entries()) {
      await assert.rejects(
        service.createFlow(userId, { clientRequestId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, content: CONTENT, mediaIds: [mediaId] }),
        (error) => error instanceof BusinessError && error.httpStatus === 409,
      );
    }

    const flowRaceMedia = await insertSafeImage(admin, userId, 8);
    const fileBlocker = await pool.connect();
    await fileBlocker.query(`SET search_path TO ${quotedSchema}`);
    await fileBlocker.query('BEGIN');
    await fileBlocker.query('SELECT id FROM file WHERE id = $1 FOR UPDATE', [flowRaceMedia]);
    let flowFileWaiters = 0;
    const flowRaceDatabase = scopedDatabase(pool, async (sql) => {
      if (/FROM file f/i.test(sql) && /FOR UPDATE OF f/i.test(sql)) {
        flowFileWaiters += 1;
        if (flowFileWaiters === 2) await fileBlocker.query('COMMIT');
      }
    });
    const flowRaceService = flowService(flowRaceDatabase);
    const flowRace = await Promise.allSettled([
      flowRaceService.createFlow(userId, { clientRequestId: '21111111-1111-4111-8111-111111111111', content: CONTENT, mediaIds: [flowRaceMedia] }),
      flowRaceService.createFlow(userId, { clientRequestId: '22222222-2222-4222-8222-222222222222', content: CONTENT, mediaIds: [flowRaceMedia] }),
    ]);
    fileBlocker.release();
    assert.equal(flowRace.filter((result) => result.status === 'fulfilled').length, 1);
    assertConflict(flowRace.find((result) => result.status === 'rejected'));
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM flow_post_media WHERE file_id = $1`, [flowRaceMedia])).rows[0].count, 1);

    const crossArticleMedia = await insertSafeImage(admin, userId, 9);
    const articleBlocker = await pool.connect();
    await articleBlocker.query(`SET search_path TO ${quotedSchema}`);
    await articleBlocker.query('BEGIN');
    await articleBlocker.query('SELECT id FROM file WHERE id = $1 FOR UPDATE', [crossArticleMedia]);
    let articleFileWaiters = 0;
    const articleRaceDatabase = scopedDatabase(pool, async (sql) => {
      if (/FROM file f/i.test(sql) && /FOR UPDATE OF f/i.test(sql)) {
        articleFileWaiters += 1;
        if (articleFileWaiters === 2) await articleBlocker.query('COMMIT');
      }
    });
    const imageService = loadBinderService(servicePaths.image, articleRaceDatabase);
    const articleRace = await Promise.allSettled([
      flowService(articleRaceDatabase).createFlow(userId, { clientRequestId: '31111111-1111-4111-8111-111111111111', content: CONTENT, mediaIds: [crossArticleMedia] }),
      imageService.updateImageArticle(userId, articleId, [crossArticleMedia], null),
    ]);
    articleBlocker.release();
    assert.equal(articleRace.filter((result) => result.status === 'fulfilled').length, 1);
    assertConflict(articleRace.find((result) => result.status === 'rejected'));
    const crossArticleState = (
      await admin.query(`SELECT article_id, EXISTS (SELECT 1 FROM flow_post_media fm WHERE fm.file_id = f.id) AS in_flow FROM file f WHERE id = $1`, [crossArticleMedia])
    ).rows[0];
    assert.notEqual(Boolean(crossArticleState.article_id), crossArticleState.in_flow);

    const staleDraft = await createActiveFlowDraft(admin, userId, 3);
    const staleMedia = await insertSafeImage(admin, userId, 10, { draftId: staleDraft });
    let notifyFlowDraftLocked;
    let releaseFlowDraftLock;
    const flowDraftLocked = new Promise((resolve) => {
      notifyFlowDraftLocked = resolve;
    });
    const flowMayContinue = new Promise((resolve) => {
      releaseFlowDraftLock = resolve;
    });
    const staleFlowDatabase = scopedDatabase(
      pool,
      async () => {},
      async (sql) => {
        if (/FROM draft/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          notifyFlowDraftLocked();
          await flowMayContinue;
        }
      },
    );
    const staleFlowPromise = flowService(staleFlowDatabase).createFlow(userId, {
      clientRequestId: '41111111-1111-4111-8111-111111111111',
      content: CONTENT,
      mediaIds: [staleMedia],
    });
    await flowDraftLocked;

    let notifyStaleSaveStarted;
    const staleSaveStarted = new Promise((resolve) => {
      notifyStaleSaveStarted = resolve;
    });
    const staleDraftDatabase = scopedDatabase(pool, async (sql, _params, context) => {
      if (/INSERT INTO draft/i.test(sql)) {
        notifyStaleSaveStarted(context.processId);
      }
    });
    const draftService = loadBinderService(servicePaths.draft, staleDraftDatabase);
    const staleDraftPromise = draftService.upsertFlowDraft(userId, {
      content: CONTENT,
      meta: { imageIds: [staleMedia] },
      version: 3,
    });
    const staleSaveProcessId = await staleSaveStarted;
    await waitForBackendLock(admin, staleSaveProcessId);
    releaseFlowDraftLock();
    const staleRace = await Promise.allSettled([staleFlowPromise, staleDraftPromise]);
    assert.equal(staleRace[0].status, 'fulfilled');
    assertConflict(staleRace[1]);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM flow_post_media WHERE file_id = $1`, [staleMedia])).rows[0].count, 1);
    assert.equal((await admin.query(`SELECT draft_id FROM file WHERE id = $1`, [staleMedia])).rows[0].draft_id, null);

    const articleOldMedia = await insertSafeImage(admin, userId, 11);
    const articleNewMedia = await insertSafeImage(admin, userId, 12);
    await admin.query(`UPDATE file SET article_id = $1 WHERE id = $2`, [articleId, articleOldMedia]);
    const articleUnionGate = twoFileLockGate(admin);
    const articleUnionDatabase = scopedDatabase(pool, articleUnionGate.onQueryStarted, articleUnionGate.onQueryCompleted);
    const articleUnionPromise = loadBinderService(servicePaths.image, articleUnionDatabase).updateImageArticle(userId, articleId, [articleNewMedia], null);
    await articleUnionGate.firstStarted;
    const articleUnionFlowPromise = flowService(articleUnionDatabase).createFlow(userId, {
      clientRequestId: '51111111-1111-4111-8111-111111111111',
      content: CONTENT,
      mediaIds: [articleOldMedia, articleNewMedia],
    });
    const articleUnionRace = await Promise.allSettled([articleUnionPromise, articleUnionFlowPromise]);
    assert.equal(articleUnionRace.filter((result) => result.status === 'fulfilled').length, 1);
    const articleUnionLoser = articleUnionRace.find((result) => result.status === 'rejected');
    assert.notEqual(articleUnionLoser.reason?.code, '40P01');
    assertConflict(articleUnionLoser);
    const articleUnionState = (
      await admin.query(
        `SELECT f.id, f.article_id,
                EXISTS (SELECT 1 FROM flow_post_media fm WHERE fm.file_id = f.id) AS in_flow
         FROM file f WHERE f.id = ANY($1::bigint[]) ORDER BY f.id`,
        [[articleOldMedia, articleNewMedia]],
      )
    ).rows;
    assert.equal(
      articleUnionState.some((row) => row.article_id != null && row.in_flow),
      false,
    );
    assert.equal(
      articleUnionState.find((row) => Number(row.id) === Number(articleNewMedia)).article_id != null ||
        articleUnionState.find((row) => Number(row.id) === Number(articleNewMedia)).in_flow,
      true,
    );

    const articleDraftId = (
      await admin.query(
        `INSERT INTO draft (user_id, draft_type, content, meta, version)
         VALUES ($1, 'article', $2::jsonb, $3::jsonb, 3)
         RETURNING id`,
        [userId, JSON.stringify(CONTENT), JSON.stringify({ imageIds: [] })],
      )
    ).rows[0].id;
    const draftOldMedia = await insertSafeImage(admin, userId, 13, { draftId: articleDraftId });
    const draftNewMedia = await insertSafeImage(admin, userId, 14);
    const draftUnionGate = twoFileLockGate(admin);
    const draftUnionDatabase = scopedDatabase(pool, draftUnionGate.onQueryStarted, draftUnionGate.onQueryCompleted);
    const draftUnionPromise = loadBinderService(servicePaths.draft, draftUnionDatabase).upsertDraft(userId, {
      articleId: null,
      title: null,
      content: CONTENT,
      meta: { imageIds: [draftNewMedia] },
      version: 3,
    });
    await draftUnionGate.firstStarted;
    const draftUnionFlowPromise = flowService(draftUnionDatabase).createFlow(userId, {
      clientRequestId: '61111111-1111-4111-8111-111111111111',
      content: CONTENT,
      mediaIds: [draftOldMedia, draftNewMedia],
    });
    const draftUnionRace = await Promise.allSettled([draftUnionPromise, draftUnionFlowPromise]);
    assert.equal(draftUnionRace.filter((result) => result.status === 'fulfilled').length, 1);
    const draftUnionLoser = draftUnionRace.find((result) => result.status === 'rejected');
    assert.notEqual(draftUnionLoser.reason?.code, '40P01');
    assertConflict(draftUnionLoser);
    const draftUnionState = (
      await admin.query(
        `SELECT f.id, f.draft_id,
                EXISTS (SELECT 1 FROM flow_post_media fm WHERE fm.file_id = f.id) AS in_flow
         FROM file f WHERE f.id = ANY($1::bigint[]) ORDER BY f.id`,
        [[draftOldMedia, draftNewMedia]],
      )
    ).rows;
    assert.equal(
      draftUnionState.some((row) => row.draft_id != null && row.in_flow),
      false,
    );
    assert.equal(
      draftUnionState.find((row) => Number(row.id) === Number(draftNewMedia)).draft_id != null || draftUnionState.find((row) => Number(row.id) === Number(draftNewMedia)).in_flow,
      true,
    );
  } finally {
    await admin.query('RESET search_path').catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => {});
    admin.release();
    await pool.end();
  }
});
