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
const { createFlowService } = require('../../src/service/flow.service');

const schema = `flow_media_test_${process.pid}`;
const quotedSchema = `"${schema}"`;
const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/012_create_flow_post.sql'), 'utf8');
const CONTENT = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

function assertLocalDevelopmentDatabase() {
  let host = config.PGHOST || '';
  if (config.DATABASE_URL) host = new URL(config.DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()), 'Integration migration test refuses a non-local database');
}

async function scopedConnection(pool) {
  const client = await pool.connect();
  await client.query(`SET search_path TO ${quotedSchema}`);
  return createPgConnectionAdapter(client);
}

function scopedDatabase(pool) {
  return {
    async getConnection() {
      return scopedConnection(pool);
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

test('Flow publish is idempotent, consumes only the inserted publish draft, and concurrent requests cannot bind one file twice', async () => {
  assertLocalDevelopmentDatabase();
  const pool = new Pool(buildPgPoolConfig(config));
  const admin = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await admin.query(`SET search_path TO ${quotedSchema}`);
    await admin.query(`CREATE TABLE "user" (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL)`);
    await admin.query(`CREATE TABLE profile (user_id BIGINT PRIMARY KEY REFERENCES "user"(id), nickname TEXT, avatar_url TEXT)`);
    await admin.query(`
      CREATE TABLE draft (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES "user"(id),
        draft_type TEXT NOT NULL,
        article_id BIGINT,
        title TEXT,
        content JSONB,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        consumed_at TIMESTAMPTZ,
        discarded_at TIMESTAMPTZ,
        consumed_article_id BIGINT,
        create_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        update_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await admin.query(`CREATE UNIQUE INDEX one_active_flow_draft ON draft(user_id) WHERE draft_type = 'flow' AND status = 'active'`);
    await admin.query(`
      CREATE TABLE file (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES "user"(id),
        filename TEXT NOT NULL,
        mimetype TEXT,
        size BIGINT,
        file_type TEXT,
        article_id BIGINT,
        draft_id BIGINT REFERENCES draft(id)
      )
    `);
    await admin.query(migration);
    const userId = (await admin.query(`INSERT INTO "user" (name) VALUES ('account') RETURNING id`)).rows[0].id;
    await admin.query(`INSERT INTO profile (user_id, nickname, avatar_url) VALUES ($1, 'Display', '/user/1/avatar')`, [userId]);
    const draft1 = (await admin.query(`INSERT INTO draft (user_id, draft_type, content) VALUES ($1, 'flow', $2::jsonb) RETURNING id`, [userId, JSON.stringify(CONTENT)])).rows[0]
      .id;
    const media1 = (await admin.query(`INSERT INTO file (user_id, filename, mimetype, file_type) VALUES ($1, 'one.webp', 'image/webp', 'image') RETURNING id`, [userId])).rows[0]
      .id;

    const service = createFlowService({
      database: scopedDatabase(pool),
      publicApiOrigin: 'https://api.example.test',
      logger: { error() {} },
      mediaRuntime: {
        async promotePublishedImages() {},
        async resolveImageUrl(id, { variant }) {
          return `https://media.example/${id}-${variant}`;
        },
      },
    });
    const requestId = '4f95672f-4f8e-4cc1-9953-7ba4c2d5f4cf';
    const first = await service.createFlow(userId, { clientRequestId: requestId, content: CONTENT, mediaIds: [media1] });
    const consumed1 = (await admin.query(`SELECT status, consumed_at, discarded_at, consumed_article_id FROM draft WHERE id = $1`, [draft1])).rows[0];
    assert.equal(consumed1.status, 'consumed');
    assert.ok(consumed1.consumed_at instanceof Date);
    assert.equal(consumed1.discarded_at, null);
    assert.equal(consumed1.consumed_article_id, null);

    const draft2 = (await admin.query(`INSERT INTO draft (user_id, draft_type, content) VALUES ($1, 'flow', $2::jsonb) RETURNING id`, [userId, JSON.stringify(CONTENT)])).rows[0]
      .id;
    const retry = await service.createFlow(userId, { clientRequestId: requestId, content: CONTENT, mediaIds: [media1] });
    assert.equal(retry.id, first.id);
    assert.equal((await admin.query(`SELECT status FROM draft WHERE id = $1`, [draft2])).rows[0].status, 'active');
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM flow_post WHERE user_id = $1 AND client_request_id = $2`, [userId, requestId])).rows[0].count, 1);

    await admin.query(`UPDATE draft SET status = 'discarded', discarded_at = NOW() WHERE id = $1`, [draft2]);
    const contestedMedia = (
      await admin.query(`INSERT INTO file (user_id, filename, mimetype, file_type) VALUES ($1, 'contested.webp', 'image/webp', 'image') RETURNING id`, [userId])
    ).rows[0].id;
    const concurrent = await Promise.allSettled([
      service.createFlow(userId, { clientRequestId: '11111111-1111-4111-8111-111111111111', content: CONTENT, mediaIds: [contestedMedia] }),
      service.createFlow(userId, { clientRequestId: '22222222-2222-4222-8222-222222222222', content: CONTENT, mediaIds: [contestedMedia] }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM flow_post_media WHERE file_id = $1`, [contestedMedia])).rows[0].count, 1);
    assert.equal(
      (
        await admin.query(`SELECT count(*)::int AS count FROM flow_post WHERE client_request_id IN ($1, $2)`, [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ])
      ).rows[0].count,
      1,
    );
  } finally {
    await admin.query('RESET search_path').catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => {});
    admin.release();
    await pool.end();
  }
});
