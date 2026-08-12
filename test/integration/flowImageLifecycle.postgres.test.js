const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
require('module-alias/register');

process.env.NODE_ENV = 'development';
const config = require('../../src/app/config');
const { buildPgPoolConfig } = require('../../src/app/database/pg.config');
const { adaptPgResult, convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');
const { createFlowService } = require('../../src/service/flow.service');
const { LocalMediaCleanupService, buildLocalCleanupEntries } = require('../../src/service/localMediaCleanup.service');
const { buildFindOrphanFilesSql } = require('../../src/tasks/cleanOrphanFiles.sql');

const PENDING_ORPHAN_TTL_DAYS = 7;

function assertLocalDevelopmentDatabase() {
  let host = config.PGHOST || '';
  if (config.DATABASE_URL) host = new URL(config.DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()), 'Flow lifecycle test refuses a non-local database');
}

function createTransactionDatabase(client) {
  const execute = async (sql, params = []) => adaptPgResult(await client.query(convertQuestionPlaceholders(sql), params));
  const connection = {
    execute,
    async beginTransaction() {
      await client.query('SAVEPOINT publish_flow');
    },
    async commit() {
      await client.query('RELEASE SAVEPOINT publish_flow');
    },
    async rollback() {
      await client.query('ROLLBACK TO SAVEPOINT publish_flow');
      await client.query('RELEASE SAVEPOINT publish_flow');
    },
    release() {},
  };

  return {
    execute,
    async getConnection() {
      return connection;
    },
  };
}

test('a pending image follows Flow publication, orphan exclusion, deletion, and cleanup staging in one rollback-only fixture', async () => {
  assertLocalDevelopmentDatabase();
  const pool = new Pool(buildPgPoolConfig(config));
  const client = await pool.connect();
  const fixtureBase = 8_000_000_000_000 + process.pid * 10;
  const userId = fixtureBase + 1;
  const draftId = fixtureBase + 2;
  const fileId = fixtureBase + 3;
  const imageMetaId = fixtureBase + 4;
  const username = `task9-flow-${process.pid}-${Date.now()}`;
  const filename = '11111111-1111-4111-8111-111111111111.webp';
  const clientRequestId = '22222222-2222-4222-8222-222222222222';
  const content = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task 9 lifecycle' }] }],
  };
  let transactionActive = false;

  try {
    await client.query('BEGIN');
    transactionActive = true;
    await client.query('INSERT INTO "user" (id, name) VALUES ($1, $2)', [userId, username]);
    await client.query(
      `INSERT INTO draft (id, user_id, draft_type, content, meta, status)
       VALUES ($1, $2, 'flow', $3::jsonb, $4::jsonb, 'active')`,
      [draftId, userId, JSON.stringify(content), JSON.stringify({ imageIds: [fileId] })],
    );
    await client.query(
      `INSERT INTO file (id, user_id, draft_id, filename, mimetype, size, file_type, create_at)
       VALUES ($1, $2, $3, $4, 'image/webp', 1024, 'image', NOW() - INTERVAL '8 days')`,
      [fileId, userId, draftId, filename],
    );
    await client.query('INSERT INTO image_meta (id, file_id, width, height) VALUES ($1, $2, 1200, 800)', [imageMetaId, fileId]);

    const transactionDatabase = createTransactionDatabase(client);
    const flowService = createFlowService({
      database: transactionDatabase,
      logger: { error() {} },
      publicApiOrigin: 'http://localhost:3000',
      mediaRuntime: {
        async promotePublishedImages({ images }) {
          assert.deepEqual(
            images.map((image) => Number(image.id)),
            [fileId],
          );
          return { failed: 0 };
        },
        async resolveImageUrl(id, { variant }) {
          return `http://localhost:3000/media/${id}/${variant}`;
        },
      },
    });

    const published = await flowService.createFlow(userId, { clientRequestId, content, mediaIds: [fileId] });
    assert.equal(published.body, 'Task 9 lifecycle');
    assert.deepEqual(
      published.media.map((image) => image.id),
      [fileId],
    );

    const association = await client.query('SELECT flow_id AS "flowId", file_id AS "fileId", position FROM flow_post_media WHERE flow_id = $1 ORDER BY position', [published.id]);
    assert.deepEqual(association.rows, [{ flowId: published.id, fileId, position: 0 }]);

    const [attachedOrphans] = await transactionDatabase.execute(buildFindOrphanFilesSql('image', 'DAY'), ['image', PENDING_ORPHAN_TTL_DAYS]);
    assert.equal(
      attachedOrphans.some((row) => Number(row.id) === fileId),
      false,
      'a published Flow image must not be selected as an expired pending orphan',
    );

    await client.query('DELETE FROM flow_post WHERE id = $1', [published.id]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM flow_post_media WHERE file_id = $1', [fileId])).rows[0].count, 0);

    const [detachedOrphans] = await transactionDatabase.execute(buildFindOrphanFilesSql('image', 'DAY'), ['image', PENDING_ORPHAN_TTL_DAYS]);
    const detachedImage = detachedOrphans.find((row) => Number(row.id) === fileId);
    assert.ok(detachedImage, 'deleting the Flow must make its old unattached image eligible for cleanup');

    const cleanupEntries = buildLocalCleanupEntries([detachedImage]);
    assert.deepEqual(cleanupEntries, [
      { storageArea: 'image', filename },
      { storageArea: 'image', filename: '11111111-1111-4111-8111-111111111111-small.webp' },
    ]);
    const cleanup = new LocalMediaCleanupService({
      database: transactionDatabase,
      roots: { image: '/tmp/task9-flow-image', video: '/tmp/task9-flow-video' },
      fsPromises: { async unlink() {} },
    });
    const cleanupIds = await cleanup.enqueueInTransaction(await transactionDatabase.getConnection(), cleanupEntries);
    assert.equal(cleanupIds.length, 2);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM media_local_cleanup WHERE id = ANY($1::bigint[])', [cleanupIds])).rows[0].count, 2);
  } finally {
    try {
      if (transactionActive) await client.query('ROLLBACK').catch(() => {});
      const rolledBack = await client.query('SELECT count(*)::int AS count FROM "user" WHERE id = $1', [userId]).catch(() => ({ rows: [{ count: -1 }] }));
      assert.equal(rolledBack.rows[0].count, 0, 'the lifecycle fixture must leave no committed rows');
    } finally {
      client.release();
      await pool.end();
    }
  }
});
