import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { integrationDatabaseConfig } from './databaseConfig.js';
import { parseSafeInt8 } from '../../src/app/database/pg.factory.js';
import { adaptPgResult, convertQuestionPlaceholders, createPgConnectionAdapter } from '../../src/app/database/pg.utils.js';
import { createDraftService } from '../../src/service/draft.factory.js';
import { createFlowService } from '../../src/service/flow.factory.js';
import { createMediaImageDeletionService } from '../../src/service/mediaImage/mediaImageDeletion.service.js';
import { LocalMediaCleanupService, buildLocalCleanupEntries } from '../../src/service/localMediaCleanup.service.js';
import { buildFindOrphanFilesSql } from '../../src/tasks/cleanOrphanFiles.sql.js';

const PENDING_ORPHAN_TTL_DAYS = 7;
const fixtureTypes = {
  getTypeParser: (oid, format) => oid === pg.types.builtins.INT8 && format !== 'binary' ? parseSafeInt8 : pg.types.getTypeParser(oid, format),
};

function createTransactionDatabase(client, { beforeCommitFailure = null, failCommit = false, onRollback = null } = {}) {
  const execute = async (sql, params = []) => adaptPgResult(await client.query(convertQuestionPlaceholders(sql), params));
  const connection = {
    execute,
    async beginTransaction() {
      await client.query('SAVEPOINT publish_flow');
    },
    async commit() {
      if (failCommit) {
        if (beforeCommitFailure) await beforeCommitFailure();
        throw new Error('injected commit failure');
      }
      await client.query('RELEASE SAVEPOINT publish_flow');
    },
    async rollback() {
      await client.query('ROLLBACK TO SAVEPOINT publish_flow');
      await client.query('RELEASE SAVEPOINT publish_flow');
      if (onRollback) onRollback();
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

function createHookedDatabase(pool, { onQueryStarted = null, onQueryCompleted = null } = {}) {
  return {
    async getConnection() {
      const client = await pool.connect();
      const connection = createPgConnectionAdapter(client);
      const processId = client.processID;
      return {
        ...connection,
        async execute(sql, params = []) {
          const pending = connection.execute(sql, params);
          if (onQueryStarted) await onQueryStarted(sql, params, { processId });
          const result = await pending;
          if (onQueryCompleted) await onQueryCompleted(sql, params, { processId });
          return result;
        },
      };
    },
  };
}

function createAutosaveService(connection) {
  return createDraftService({
    connection,
    baseURL: 'https://api.example.test',
    mediaRuntime: {
      async resolveImageUrl(id, { variant }) {
        return `https://media.test/${id}/${variant}`;
      },
    },
  });
}

async function waitForBackendLock(client, processId) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await client.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [processId]);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`backend ${processId} did not enter a PostgreSQL lock wait`);
}

test('a pending image follows Flow publication, orphan exclusion, deletion, and cleanup staging in one rollback-only fixture', async () => {
  const pool = new pg.Pool({ ...integrationDatabaseConfig(), types: fixtureTypes });
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

    const published = await flowService.createFlow(userId, { draft: { id: draftId, version: 1 }, clientRequestId, content, mediaIds: [fileId] });
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

test('an active Flow draft image deletion mutates jsonb without changing version in one rollback-only fixture', async () => {
  const pool = new pg.Pool({ ...integrationDatabaseConfig(), types: fixtureTypes });
  const client = await pool.connect();
  const fixtureBase = 8_100_000_000_000 + process.pid * 10;
  const userId = fixtureBase + 1;
  const draftId = fixtureBase + 2;
  const fileId = fixtureBase + 3;
  const imageMetaId = fixtureBase + 4;
  const username = `t7-${process.pid}-${Date.now()}`;
  const filename = '33333333-3333-4333-8333-333333333333.webp';
  const originalMeta = {
    imageIds: [fileId + 20, fileId, fileId + 10],
    videoIds: [fileId + 30],
    coverImageId: fileId + 20,
    preferences: { alignment: 'center' },
  };
  const cleanupCalls = [];
  let transactionActive = false;

  try {
    await client.query('BEGIN');
    transactionActive = true;
    await client.query('INSERT INTO "user" (id, name) VALUES ($1, $2)', [userId, username]);
    await client.query(
      `INSERT INTO draft (id, user_id, draft_type, content, meta, version, status)
       VALUES ($1, $2, 'flow', '{}'::jsonb, $3::jsonb, 7, 'active')`,
      [draftId, userId, JSON.stringify(originalMeta)],
    );
    await client.query(
      `INSERT INTO file (id, user_id, draft_id, filename, mimetype, size, file_type)
       VALUES ($1, $2, $3, $4, 'image/webp', 1024, 'image')`,
      [fileId, userId, draftId, filename],
    );
    await client.query('INSERT INTO image_meta (id, file_id, width, height) VALUES ($1, $2, 1200, 800)', [imageMetaId, fileId]);

    const deletePendingImage = createMediaImageDeletionService({
      database: createTransactionDatabase(client),
      mediaRuntime: {
        async deleteR2ObjectsForFiles(ids) {
          cleanupCalls.push({ type: 'r2', ids });
        },
      },
      localMediaCleanup: {
        buildLocalCleanupEntries,
        async enqueueInTransaction(_connection, entries) {
          cleanupCalls.push({ type: 'enqueue', entries });
          return [];
        },
        async processPending() {
          cleanupCalls.push({ type: 'process' });
        },
      },
    });

    assert.deepEqual(await deletePendingImage(userId, fileId), { deleted: true });

    const draft = (await client.query('SELECT meta, version FROM draft WHERE id = $1', [draftId])).rows[0];
    assert.deepEqual(draft.meta, {
      imageIds: [fileId + 20, fileId + 10],
      videoIds: [fileId + 30],
      coverImageId: fileId + 20,
      preferences: { alignment: 'center' },
    });
    assert.equal(draft.version, 7);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM file WHERE id = $1', [fileId])).rows[0].count, 0);
    assert.deepEqual(cleanupCalls.map((call) => call.type), ['r2', 'enqueue']);
    assert.deepEqual(cleanupCalls[1].entries, [
      { storageArea: 'image', filename },
      { storageArea: 'image', filename: '33333333-3333-4333-8333-333333333333-small.webp' },
    ]);
  } finally {
    try {
      if (transactionActive) await client.query('ROLLBACK').catch(() => {});
      const residue = await client.query(
        `SELECT
           (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
           (SELECT count(*)::int FROM draft WHERE id = $2) AS drafts,
           (SELECT count(*)::int FROM file WHERE id = $3) AS files`,
        [userId, draftId, fileId],
      ).catch(() => ({ rows: [{ users: -1, drafts: -1, files: -1 }] }));
      assert.deepEqual(residue.rows[0], { users: 0, drafts: 0, files: 0 }, 'the draft image deletion fixture must leave no committed rows');
    } finally {
      client.release();
      await pool.end();
    }
  }
});

test('deletePendingImage PostgreSQL rolls back metadata and file deletion before the outer fixture rollback', async () => {
  const pool = new pg.Pool({ ...integrationDatabaseConfig(), types: fixtureTypes });
  const client = await pool.connect();
  const fixtureBase = 8_200_000_000_000 + process.pid * 10;
  const userId = fixtureBase + 1;
  const draftId = fixtureBase + 2;
  const fileId = fixtureBase + 3;
  const imageMetaId = fixtureBase + 4;
  const username = `t7r-${process.pid}-${Date.now()}`;
  const filename = '44444444-4444-4444-8444-444444444444.webp';
  const originalMeta = {
    imageIds: [fileId + 10, fileId, fileId + 20],
    videoIds: [fileId + 30],
    recovery: { keep: true },
  };
  const cleanupCalls = [];
  let mutationsObservedBeforeFailure = false;
  let serviceRollbacks = 0;
  let transactionActive = false;

  try {
    await client.query('BEGIN');
    transactionActive = true;
    await client.query('INSERT INTO "user" (id, name) VALUES ($1, $2)', [userId, username]);
    await client.query(
      `INSERT INTO draft (id, user_id, draft_type, content, meta, version, status)
       VALUES ($1, $2, 'flow', '{}'::jsonb, $3::jsonb, 11, 'active')`,
      [draftId, userId, JSON.stringify(originalMeta)],
    );
    await client.query(
      `INSERT INTO file (id, user_id, draft_id, filename, mimetype, size, file_type)
       VALUES ($1, $2, $3, $4, 'image/webp', 1024, 'image')`,
      [fileId, userId, draftId, filename],
    );
    await client.query('INSERT INTO image_meta (id, file_id, width, height) VALUES ($1, $2, 1200, 800)', [imageMetaId, fileId]);

    const deletePendingImage = createMediaImageDeletionService({
      database: createTransactionDatabase(client, {
        async beforeCommitFailure() {
          const mutatedDraft = (await client.query('SELECT meta, version FROM draft WHERE id = $1', [draftId])).rows[0];
          assert.deepEqual(mutatedDraft, {
            meta: { imageIds: [fileId + 10, fileId + 20], videoIds: [fileId + 30], recovery: { keep: true } },
            version: 11,
          });
          assert.equal((await client.query('SELECT count(*)::int AS count FROM file WHERE id = $1', [fileId])).rows[0].count, 0);
          mutationsObservedBeforeFailure = true;
        },
        failCommit: true,
        onRollback() {
          serviceRollbacks += 1;
        },
      }),
      mediaRuntime: {
        async deleteR2ObjectsForFiles(ids) {
          cleanupCalls.push({ type: 'r2', ids });
        },
      },
      localMediaCleanup: {
        buildLocalCleanupEntries,
        async enqueueInTransaction(_connection, entries) {
          cleanupCalls.push({ type: 'enqueue', entries });
          return [901];
        },
        async processPending(payload) {
          cleanupCalls.push({ type: 'process', payload });
        },
      },
    });

    await assert.rejects(() => deletePendingImage(userId, fileId), /injected commit failure/);

    assert.equal(mutationsObservedBeforeFailure, true);
    assert.equal(serviceRollbacks, 1, 'the service must roll back its savepoint before the outer fixture rollback');
    const restoredDraft = (await client.query('SELECT meta, version FROM draft WHERE id = $1', [draftId])).rows[0];
    assert.deepEqual(restoredDraft, { meta: originalMeta, version: 11 });
    assert.deepEqual(
      (await client.query('SELECT id, draft_id FROM file WHERE id = $1', [fileId])).rows,
      [{ id: fileId, draft_id: draftId }],
    );
    assert.equal((await client.query('SELECT count(*)::int AS count FROM image_meta WHERE file_id = $1', [fileId])).rows[0].count, 1);
    assert.deepEqual(cleanupCalls.map((call) => call.type), ['r2', 'enqueue']);
  } finally {
    try {
      if (transactionActive) await client.query('ROLLBACK').catch(() => {});
      const residue = await client.query(
        `SELECT
           (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
           (SELECT count(*)::int FROM draft WHERE id = $2) AS drafts,
           (SELECT count(*)::int FROM file WHERE id = $3) AS files`,
        [userId, draftId, fileId],
      ).catch(() => ({ rows: [{ users: -1, drafts: -1, files: -1 }] }));
      assert.deepEqual(residue.rows[0], { users: 0, drafts: 0, files: 0 }, 'the rollback fixture must leave no committed rows');
    } finally {
      client.release();
      await pool.end();
    }
  }
});

test('deletePendingImage PostgreSQL waits behind autosave, revalidates, and preserves the next autosave version', async () => {
  const pool = new pg.Pool({ ...integrationDatabaseConfig(), types: fixtureTypes });
  const client = await pool.connect();
  const fixtureBase = 8_300_000_000_000 + process.pid * 10;
  const userId = fixtureBase + 1;
  const draftId = fixtureBase + 2;
  const fileId = fixtureBase + 3;
  const imageMetaId = fixtureBase + 4;
  const username = `t7c-${process.pid}-${Date.now()}`;
  const filename = '55555555-5555-4555-8555-555555555555.webp';
  const content = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'concurrent autosave' }] }],
  };
  let releaseAutosave;
  let autosaveReleased = false;
  let notifyAutosaveDraftUpdated;
  const autosaveDraftUpdated = new Promise((resolve) => {
    notifyAutosaveDraftUpdated = resolve;
  });
  const autosaveMayContinue = new Promise((resolve) => {
    releaseAutosave = () => {
      if (autosaveReleased) return;
      autosaveReleased = true;
      resolve();
    };
  });
  let notifyDeleteWaiting;
  const deleteWaiting = new Promise((resolve) => {
    notifyDeleteWaiting = resolve;
  });
  const deletionEvents = [];
  let autosaveUpserts = 0;
  let fixtureCommitted = false;
  let firstAutosavePromise;
  let deletionPromise;

  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO "user" (id, name) VALUES ($1, $2)', [userId, username]);
    await client.query(
      `INSERT INTO draft (id, user_id, draft_type, content, meta, version, status)
       VALUES ($1, $2, 'flow', $3::jsonb, $4::jsonb, 3, 'active')`,
      [draftId, userId, JSON.stringify(content), JSON.stringify({ imageIds: [fileId], marker: 'initial' })],
    );
    await client.query(
      `INSERT INTO file (id, user_id, draft_id, filename, mimetype, size, file_type)
       VALUES ($1, $2, $3, $4, 'image/webp', 1024, 'image')`,
      [fileId, userId, draftId, filename],
    );
    await client.query('INSERT INTO image_meta (id, file_id, width, height) VALUES ($1, $2, 1200, 800)', [imageMetaId, fileId]);
    await client.query('COMMIT');
    fixtureCommitted = true;

    const autosaveDatabase = createHookedDatabase(pool, {
      async onQueryCompleted(sql) {
        if (!/INSERT INTO draft/i.test(sql)) return;
        autosaveUpserts += 1;
        if (autosaveUpserts !== 1) return;
        notifyAutosaveDraftUpdated();
        await autosaveMayContinue;
      },
    });
    const draftService = createAutosaveService(autosaveDatabase);
    firstAutosavePromise = draftService.upsertFlowDraft(userId, {
      content,
      meta: { imageIds: [fileId], marker: 'autosave' },
      version: 3,
    });
    await autosaveDraftUpdated;

    const deletionDatabase = createHookedDatabase(pool, {
      async onQueryStarted(sql, _params, { processId }) {
        if (/FROM file f/i.test(sql) && !/FOR UPDATE/i.test(sql)) {
          deletionEvents.push('probe');
          return;
        }
        if (/FROM draft/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          deletionEvents.push('draft-lock');
          await waitForBackendLock(client, processId);
          notifyDeleteWaiting();
          return;
        }
        if (/FROM file f/i.test(sql) && /FOR UPDATE OF f/i.test(sql)) {
          deletionEvents.push('file-lock');
        }
      },
    });
    const deletePendingImage = createMediaImageDeletionService({
      database: deletionDatabase,
      mediaRuntime: { async deleteR2ObjectsForFiles() {} },
      localMediaCleanup: {
        buildLocalCleanupEntries,
        async enqueueInTransaction() {
          return [];
        },
        async processPending() {},
      },
    });
    deletionPromise = deletePendingImage(userId, fileId);
    await deleteWaiting;

    assert.deepEqual(deletionEvents, ['probe', 'draft-lock']);
    releaseAutosave();

    const firstAutosave = await firstAutosavePromise;
    assert.equal(firstAutosave.version, 4);
    assert.deepEqual(await deletionPromise, { deleted: true });
    assert.deepEqual(deletionEvents, ['probe', 'draft-lock', 'file-lock']);

    const afterDeletion = (await client.query('SELECT meta, version FROM draft WHERE id = $1', [draftId])).rows[0];
    assert.deepEqual(afterDeletion, { meta: { imageIds: [], marker: 'autosave' }, version: 4 });
    assert.equal((await client.query('SELECT count(*)::int AS count FROM file WHERE id = $1', [fileId])).rows[0].count, 0);

    const followingAutosave = await draftService.upsertFlowDraft(userId, {
      content,
      meta: { imageIds: [], marker: 'following-autosave' },
      version: afterDeletion.version,
    });
    assert.equal(followingAutosave.version, 5);
    assert.deepEqual(followingAutosave.meta, { imageIds: [], marker: 'following-autosave' });
  } finally {
    releaseAutosave();
    await Promise.allSettled([firstAutosavePromise, deletionPromise].filter(Boolean));
    try {
      if (!fixtureCommitted) await client.query('ROLLBACK').catch(() => {});
      await client.query('DELETE FROM file WHERE id = $1', [fileId]).catch(() => {});
      await client.query('DELETE FROM draft WHERE id = $1', [draftId]).catch(() => {});
      await client.query('DELETE FROM "user" WHERE id = $1', [userId]).catch(() => {});
      const residue = await client.query(
        `SELECT
           (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
           (SELECT count(*)::int FROM draft WHERE id = $2) AS drafts,
           (SELECT count(*)::int FROM file WHERE id = $3) AS files`,
        [userId, draftId, fileId],
      ).catch(() => ({ rows: [{ users: -1, drafts: -1, files: -1 }] }));
      assert.deepEqual(residue.rows[0], { users: 0, drafts: 0, files: 0 }, 'the concurrency fixture must leave no committed rows');
    } finally {
      client.release();
      await pool.end();
    }
  }
});
