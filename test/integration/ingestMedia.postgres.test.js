const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
require('module-alias/register');
require('@/ingest/database'); // Match the runtime's safe bigint parser.
const { createPgConnectionAdapter } = require('@/app/database/pg.utils');
const { buildPgPoolConfig } = require('@/app/database/pg.config');
const { createRichArticleRepository } = require('@/ingest/repositories/richArticleRepository');
const { createIngestMediaService } = require('@/ingest/media/ingestMediaService');
const { LocalMediaCleanupService } = require('@/service/localMediaCleanup.service');
const { backfillRawArticles } = require('@/ingest/pipeline/backfillRawArticles');
const { backfillRichArticles } = require('@/ingest/pipeline/backfillRichArticles');

// Require an explicit local test database: never inherit a production env file.
const dbConfig = Object.fromEntries(['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].map((key) => [key, process.env[key]]));
const host = dbConfig.DATABASE_URL ? new URL(dbConfig.DATABASE_URL).hostname : dbConfig.PGHOST;
const name = dbConfig.DATABASE_URL ? new URL(dbConfig.DATABASE_URL).pathname.slice(1) : dbConfig.PGDATABASE;

test('ingest lifecycle preserves identities and recovers partial promotion, retirement and filename restoration', async (t) => {
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'Ingest integration refuses a non-local host');
  assert.match(name || '', /test/i, 'Ingest integration requires an explicitly named test database');
  const pool = new Pool(buildPgPoolConfig(dbConfig));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coderx-ingest-pg-'));
  const schema = `ingest_media_test_${process.pid}`;
  const scoped = async () => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  };
  const database = {
    async execute(sql, params) {
      const client = await scoped();
      try {
        return await createPgConnectionAdapter(client).execute(sql, params);
      } finally {
        client.release();
      }
    },
    async getConnection() {
      return createPgConnectionAdapter(await scoped());
    },
  };
  const admin = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`
      CREATE TABLE "user" (id bigint PRIMARY KEY, status int);
      CREATE TABLE profile (user_id bigint REFERENCES "user"(id), avatar_url text);
      CREATE TABLE tag (id bigint PRIMARY KEY, name text);
      CREATE TABLE article (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint REFERENCES "user"(id), title text, content jsonb, excerpt text, create_at timestamptz, update_at timestamptz);
      CREATE TABLE ingest_source (id bigint PRIMARY KEY, name text);
      CREATE TABLE ingest_candidate (id bigint PRIMARY KEY, source_id bigint REFERENCES ingest_source(id), status text, article_id bigint REFERENCES article(id), canonical_url text, title_original text, source_published_at timestamptz, content_mode text, license_code text, failure_reason text, updated_at timestamptz);
      CREATE TABLE article_source (article_id bigint REFERENCES article(id), candidate_id bigint UNIQUE REFERENCES ingest_candidate(id), source_id bigint, canonical_url text UNIQUE, source_title text, source_published_at timestamptz, content_mode text, license_code text);
      CREATE TABLE article_tag (article_id bigint REFERENCES article(id), tag_id bigint REFERENCES tag(id));
      CREATE TABLE file (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint REFERENCES "user"(id), article_id bigint REFERENCES article(id), draft_id bigint, filename text NOT NULL, mimetype text, size bigint, file_type text);
      CREATE TABLE image_meta (file_id bigint PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE, width int, height int, is_cover boolean);
      CREATE TABLE flow_post_media (file_id bigint REFERENCES file(id), flow_id bigint);
      INSERT INTO "user" VALUES (1, 0), (2, 0);
      INSERT INTO profile VALUES (1, 'avatar'), (2, 'avatar');
      INSERT INTO tag VALUES (1, 'AI');
      INSERT INTO ingest_source VALUES (1, 'Example');
      INSERT INTO ingest_candidate (id, source_id, status, canonical_url, title_original, source_published_at, content_mode, license_code)
      VALUES (3, 1, 'pending', 'https://example.com/a', 'Source', now(), 'summary', 'link-only');
    `);
    for (const migration of ['010_create_media_object.sql', '011_create_media_local_cleanup.sql']) {
      await admin.query(await fs.readFile(path.resolve(__dirname, '../../migrations', migration), 'utf8'));
    }
    const objects = new Map();
    let failSmall = true;
    let failDelete = false;
    let puts = 0;
    let deletes = 0;
    const r2Store = {
      async put(payload) {
        if (failSmall && payload.key.includes('-small.')) {
          failSmall = false;
          throw new Error('simulated upload failure');
        }
        puts += 1;
        const data = [];
        for await (const chunk of payload.bodyFactory()) data.push(chunk);
        const bytes = Buffer.concat(data);
        assert.equal(bytes.length, payload.sizeBytes);
        objects.set(payload.key, { key: payload.key, sizeBytes: payload.sizeBytes, sha256: payload.sha256 });
        return { skipped: false };
      },
      async head(key) {
        return objects.get(key) || null;
      },
      async delete(key) {
        if (failDelete) throw new Error('simulated deletion failure');
        deletes += 1;
        objects.delete(key);
      },
    };
    let failUnlinkName = null;
    const localCleanup = new LocalMediaCleanupService({
      database,
      roots: { image: root, video: root },
      fsPromises: {
        async unlink(filePath) {
          if (failUnlinkName && filePath.includes(failUnlinkName)) throw new Error('simulated unlink failure');
          return fs.unlink(filePath);
        },
      },
    });
    const service = createIngestMediaService({ database, imageRoot: root, videoRoot: root, writeMode: 'r2_on_publish', r2Store, localCleanup });
    const repository = createRichArticleRepository(database);
    let stem = 'aaa';
    const args = {
      repository,
      ids: [3],
      authorIds: [1, 2],
      tagName: 'AI',
      outputDir: root,
      publicBaseURL: 'http://localhost:8000',
      extractor: async () => ({ title: 'Source', sections: [{ heading: 'Body', paragraphs: ['Useful excerpt.'] }], images: [{}] }),
      enricher: {
        async enrich() {
          return {
            titleZh: 'Article',
            lead: 'Useful excerpt.',
            conclusion: 'Conclusion.',
            sections: Array.from({ length: 3 }, () => ({ heading: 'Section', paragraphs: ['Paragraph.'] })),
          };
        },
      },
      async localizeImages({ outputDir }) {
        const filename = `ingest-3-1-${stem}.jpg`;
        const smallFilename = `ingest-3-1-${stem}-small.jpg`;
        const temporaryPath = path.join(outputDir, filename),
          smallTemporaryPath = path.join(outputDir, smallFilename);
        await fs.writeFile(temporaryPath, `original-${stem}`);
        await fs.writeFile(smallTemporaryPath, `small-${stem}`);
        return {
          assets: [
            {
              filename,
              smallFilename,
              temporaryPath,
              smallTemporaryPath,
              mimetype: 'image/jpeg',
              size: Buffer.byteLength(`original-${stem}`),
              width: 1200,
              height: 675,
              isCover: true,
            },
          ],
          async cleanup() {},
        };
      },
      synchronizeMedia: (payload) => service.synchronizeArticle(payload),
    };
    const count = async (table) => Number((await admin.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    const first = await backfillRawArticles(args);
    assert.equal(first.created, 1);
    assert.equal(first.articles[0].media.status, 'retry_required');
    const articleId = first.articles[0].articleId;
    const originalId = first.articles[0].media.fileIds[0];
    assert.equal(objects.size, 1);
    assert.equal(await count('media_object'), 4);
    const retry = await service.synchronizeArticle({ articleId });
    assert.equal(retry.status, 'ready');
    assert.equal(objects.size, 2);
    assert.equal(puts, 2);
    assert.equal((await service.synchronizeArticle({ articleId })).status, 'ready');
    assert.equal(puts, 2, 'ready retry must HEAD existing immutable objects without PUT');
    const identities = (await admin.query('SELECT id FROM media_object ORDER BY id')).rows;
    const same = await backfillRichArticles(args);
    assert.equal(same.updated, 1, JSON.stringify(same));
    assert.equal(same.articles[0].media.status, 'ready');
    assert.deepEqual(same.articles[0].media.fileIds, [originalId]);
    assert.deepEqual((await admin.query('SELECT id FROM media_object ORDER BY id')).rows, identities);
    assert.equal(puts, 2);
    stem = 'bbb';
    failDelete = true;
    const changed = await backfillRawArticles(args);
    assert.equal(changed.updated, 1);
    assert.equal(changed.articles[0].media.status, 'retry_required');
    const retired = (await admin.query('SELECT article_id FROM file WHERE id = $1', [originalId])).rows[0];
    assert.equal(retired.article_id, null);
    assert.equal(await count('media_object'), 8);
    assert.equal(await fs.readFile(path.join(root, 'ingest-3-1-aaa.jpg'), 'utf8'), 'original-aaa');
    const paused = createIngestMediaService({ database, imageRoot: root, writeMode: 'r2_on_publish', writePaused: true, r2Store });
    const deleteCount = deletes;
    assert.equal((await paused.synchronizeArticle({ articleId })).status, 'retry_required');
    assert.equal(deletes, deleteCount, 'paused retry must not call external deletion');
    failDelete = false;
    assert.equal((await service.synchronizeArticle({ articleId })).status, 'ready');
    assert.equal((await admin.query('SELECT id FROM file WHERE id = $1', [originalId])).rowCount, 0);
    assert.equal(await count('media_object'), 4);
    assert.equal(objects.size, 2);
    await assert.rejects(fs.access(path.join(root, 'ingest-3-1-aaa.jpg')), { code: 'ENOENT' });

    // A cleanup tombstone must not survive restoration of its immutable filename.
    stem = 'ccc';
    failUnlinkName = 'bbb';
    const cleanupFailed = await backfillRawArticles(args);
    assert.equal(cleanupFailed.updated, 1);
    assert.equal(cleanupFailed.articles[0].media.status, 'retry_required');
    assert.equal(await count('media_local_cleanup'), 2);
    stem = 'bbb';
    const restored = await backfillRawArticles(args);
    assert.equal(restored.updated, 1);
    assert.equal(restored.articles[0].media.status, 'ready');
    assert.equal(await count('media_local_cleanup'), 0, 'restoration must cancel tombstones for its current original and small bytes');
    assert.equal(await fs.readFile(path.join(root, 'ingest-3-1-bbb.jpg'), 'utf8'), 'original-bbb');
    failUnlinkName = null;
    assert.equal((await service.synchronizeArticle({ articleId })).status, 'ready');
    assert.equal(await count('article'), 1);
    assert.equal(await count('file'), 1);
    assert.equal(await count('media_object'), 4);
    assert.equal(objects.size, 2);
    // A failed replacement transaction must retain current files and registrations.
    const [currentImages] = await database.execute('SELECT id, filename, size, mimetype FROM file');
    await assert.rejects(
      repository.replacePublishedArticle({
        articleId,
        candidateId: 3,
        authorId: 1,
        createAt: new Date(),
        title: 'Bad',
        excerpt: 'Bad',
        assets: [{ ...currentImages[0], width: 1200, height: 675 }],
        buildContent() {
          throw new Error('render failure');
        },
      }),
      /render failure/,
    );
    assert.equal((await admin.query('SELECT article_id FROM file')).rows[0].article_id, articleId);
    assert.equal(await count('media_object'), 4);
  } finally {
    await admin.query('RESET search_path').catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    admin.release();
    await pool.end();
    await fs.rm(root, { recursive: true, force: true });
  }
});
