const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

process.env.NODE_ENV = 'development';
const config = require('../../src/app/config');
const { buildPgPoolConfig } = require('../../src/app/database/pg.config');

const schema = `video_promotion_lock_test_${process.pid}`;
const quotedSchema = `"${schema}"`;

function assertLocalDevelopmentDatabase() {
  let host = config.PGHOST || '';
  if (config.DATABASE_URL) host = new URL(config.DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()), 'Concurrency test refuses a non-local database');
}

async function waitUntilBlocked(observer, backendPid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await observer.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [backendPid]);
    if (Number(result.rows[0].blockers) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('expected association UPDATE to wait for the promotion row lock');
}

test('video promotion row lock permits media FK reservation but blocks concurrent unpublish', async () => {
  assertLocalDevelopmentDatabase();
  const pool = new Pool(buildPgPoolConfig(config));
  const setup = await pool.connect();
  const promotion = await pool.connect();
  const unpublish = await pool.connect();
  const reservation = await pool.connect();
  const observer = await pool.connect();
  let unpublishPromise;

  try {
    await setup.query(`CREATE SCHEMA ${quotedSchema}`);
    await setup.query(`SET search_path TO ${quotedSchema}`);
    await setup.query('CREATE TABLE article (id BIGINT PRIMARY KEY)');
    await setup.query('CREATE TABLE file (id BIGINT PRIMARY KEY, article_id BIGINT REFERENCES article(id))');
    await setup.query('CREATE TABLE media_object (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, file_id BIGINT NOT NULL REFERENCES file(id))');
    await setup.query('INSERT INTO article (id) VALUES (201)');
    await setup.query('INSERT INTO file (id, article_id) VALUES (33, 201)');

    await promotion.query('BEGIN');
    await promotion.query(`SET LOCAL search_path TO ${quotedSchema}`);
    await promotion.query('SELECT id FROM file WHERE id = 33 FOR NO KEY UPDATE');

    // media_object reservation takes a FK KEY SHARE lock. It must remain compatible
    // with promotion's NO KEY UPDATE lock or the service would deadlock itself.
    await reservation.query('BEGIN');
    await reservation.query(`SET LOCAL search_path TO ${quotedSchema}`);
    await reservation.query("SET LOCAL statement_timeout = '1s'");
    await reservation.query('INSERT INTO media_object (file_id) VALUES (33)');
    await reservation.query('COMMIT');

    await unpublish.query('BEGIN');
    await unpublish.query(`SET LOCAL search_path TO ${quotedSchema}`);
    const unpublishPid = Number((await unpublish.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    unpublishPromise = unpublish.query('UPDATE file SET article_id = NULL WHERE id = 33');
    await waitUntilBlocked(observer, unpublishPid);

    await promotion.query('COMMIT');
    await unpublishPromise;
    await unpublish.query('COMMIT');

    assert.equal((await setup.query('SELECT article_id FROM file WHERE id = 33')).rows[0].article_id, null);
  } finally {
    await promotion.query('ROLLBACK').catch(() => {});
    await unpublish.query('ROLLBACK').catch(() => {});
    await reservation.query('ROLLBACK').catch(() => {});
    await setup.query('RESET search_path').catch(() => {});
    await setup.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => {});
    setup.release();
    promotion.release();
    unpublish.release();
    reservation.release();
    observer.release();
    await pool.end();
  }
});

test('article-first lock order lets delete finish before association update without a deadlock', async () => {
  assertLocalDevelopmentDatabase();
  const lockSchema = `${schema}_article_order`;
  const quotedLockSchema = `"${lockSchema}"`;
  const pool = new Pool(buildPgPoolConfig(config));
  const setup = await pool.connect();
  const articleDelete = await pool.connect();
  const associationUpdate = await pool.connect();
  const observer = await pool.connect();
  let associationArticleLock;

  try {
    await setup.query(`CREATE SCHEMA ${quotedLockSchema}`);
    await setup.query(`SET search_path TO ${quotedLockSchema}`);
    await setup.query('CREATE TABLE article (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL)');
    await setup.query('CREATE TABLE file (id BIGINT PRIMARY KEY, article_id BIGINT REFERENCES article(id))');
    await setup.query('INSERT INTO article (id, user_id) VALUES (201, 5)');
    await setup.query('INSERT INTO file (id, article_id) VALUES (33, 201)');

    await articleDelete.query('BEGIN');
    await articleDelete.query(`SET LOCAL search_path TO ${quotedLockSchema}`);
    await articleDelete.query("SET LOCAL statement_timeout = '1s'");
    await articleDelete.query('SELECT id FROM article WHERE id = 201 AND user_id = 5 FOR UPDATE');

    await associationUpdate.query('BEGIN');
    await associationUpdate.query(`SET LOCAL search_path TO ${quotedLockSchema}`);
    const updatePid = Number((await associationUpdate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    associationArticleLock = associationUpdate.query('SELECT id FROM article WHERE id = 201 AND user_id = 5 FOR NO KEY UPDATE');
    await waitUntilBlocked(observer, updatePid);

    // Because both operations lock article before file, delete can acquire file
    // while association waits; the previous file->article order deadlocked here.
    await articleDelete.query('SELECT id FROM file WHERE article_id = 201 FOR UPDATE');
    await articleDelete.query('COMMIT');

    await associationArticleLock;
    await associationUpdate.query('SELECT id FROM file WHERE id = 33 FOR NO KEY UPDATE');
    await associationUpdate.query('ROLLBACK');
  } finally {
    await articleDelete.query('ROLLBACK').catch(() => {});
    await associationUpdate.query('ROLLBACK').catch(() => {});
    await setup.query('RESET search_path').catch(() => {});
    await setup.query(`DROP SCHEMA IF EXISTS ${quotedLockSchema} CASCADE`).catch(() => {});
    setup.release();
    articleDelete.release();
    associationUpdate.release();
    observer.release();
    await pool.end();
  }
});
