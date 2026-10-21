const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');
require('module-alias/register');
const config = require('../../src/app/config');
const { buildPgPoolConfig } = require('../../src/app/database/pg.config');
const { adaptPgResult, convertQuestionPlaceholders } = require('../../src/app/database/pg.utils');

test('article association accepts its consumed draft image and preserves other draft and Flow reservations', async () => {
  const host = config.DATABASE_URL ? new URL(config.DATABASE_URL).hostname : config.PGHOST;
  const database = config.DATABASE_URL ? new URL(config.DATABASE_URL).pathname : config.PGDATABASE;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host));
  assert.match(database, /test/i, 'requires a dedicated test database');
  const client = new Client(buildPgPoolConfig(config));
  const cachePaths = ['app/database.js', 'service/mediaRuntime.service.js', 'service/image.service.js'].map((file) => path.resolve(__dirname, '../../src', file));
  const previous = cachePaths.map((file) => require.cache[file]);
  await client.connect();
  try {
    await client.query('BEGIN');
    const user = Number(
      (await client.query('INSERT INTO "user" (name, password) VALUES ($1, $2) RETURNING id', [`article_image_test_${process.pid}`, 'not-a-login-hash'])).rows[0].id,
    );
    const article = Number((await client.query('INSERT INTO article (user_id, title, content) VALUES ($1,$2,$3) RETURNING id', [user, 'fixture', '{}'])).rows[0].id);
    const otherArticle = Number((await client.query('INSERT INTO article (user_id, title, content) VALUES ($1,$2,$3) RETURNING id', [user, 'other fixture', '{}'])).rows[0].id);
    const execute = async (sql, params) => adaptPgResult(await client.query(convertQuestionPlaceholders(sql), params));
    const connection = {
      execute,
      beginTransaction: () => client.query('SAVEPOINT image_bind'),
      commit: () => client.query('RELEASE SAVEPOINT image_bind'),
      rollback: async () => {
        await client.query('ROLLBACK TO SAVEPOINT image_bind');
        await client.query('RELEASE SAVEPOINT image_bind');
      },
      release() {},
    };
    require.cache[cachePaths[0]] = { id: cachePaths[0], filename: cachePaths[0], loaded: true, exports: { getConnection: async () => connection } };
    require.cache[cachePaths[1]] = { id: cachePaths[1], filename: cachePaths[1], loaded: true, exports: { promotePublishedImages: async () => ({ skipped: true }) } };
    delete require.cache[cachePaths[2]];
    const service = require(cachePaths[2]);
    async function image({ status = 'consumed', target = article, type = 'article', attachedFlow = false } = {}) {
      const draft = (
        await client.query(
          `INSERT INTO draft (user_id, content, draft_type, status, consumed_at, consumed_article_id) VALUES ($1,'{}',$2,$3,CASE WHEN $3='consumed' THEN now() END,$4) RETURNING id`,
          [user, type, status, status === 'consumed' && type === 'article' ? target : null],
        )
      ).rows[0].id;
      const file = Number(
        (
          await client.query(`INSERT INTO file (user_id, filename, mimetype, size, file_type, draft_id) VALUES ($1,$2,'image/webp',12,'image',$3) RETURNING id`, [
            user,
            `fixture-${draft}.webp`,
            draft,
          ])
        ).rows[0].id,
      );
      await client.query('INSERT INTO image_meta (file_id,is_cover) VALUES ($1,false)', [file]);
      if (attachedFlow) {
        const flow = (
          await client.query(`INSERT INTO flow_post (user_id, client_request_id, content, body_text) VALUES ($1,gen_random_uuid(),'{}','fixture') RETURNING id`, [user])
        ).rows[0].id;
        await client.query('INSERT INTO flow_post_media (flow_id,file_id,position) VALUES ($1,$2,0)', [flow, file]);
      }
      return { file, draft };
    }
    const own = await image();
    await service.updateImageArticle(user, article, [own.file], own.file);
    assert.deepEqual((await client.query('SELECT article_id,draft_id FROM file WHERE id=$1', [own.file])).rows[0], { article_id: String(article), draft_id: null });
    for (const scenario of [{ target: otherArticle }, { status: 'active' }, { type: 'flow', status: 'consumed' }, { attachedFlow: true }]) {
      const reserved = await image(scenario);
      await assert.rejects(service.updateImageArticle(user, article, [own.file, reserved.file]), (error) => error.httpStatus === 409);
      const row = (await client.query('SELECT draft_id,article_id FROM file WHERE id=$1', [reserved.file])).rows[0];
      assert.equal(String(row.draft_id), String(reserved.draft));
      assert.equal(row.article_id, null);
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
    cachePaths.forEach((file, index) => {
      if (previous[index]) require.cache[file] = previous[index];
      else delete require.cache[file];
    });
  }
});
