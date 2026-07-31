const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

process.env.NODE_ENV = 'development';
const config = require('../../src/app/config');
const { buildPgPoolConfig } = require('../../src/app/database/pg.config');

const schema = `media_object_test_${process.pid}`;
const quotedSchema = `"${schema}"`;
const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/010_create_media_object.sql'), 'utf8');

function assertLocalDevelopmentDatabase() {
  let host = config.PGHOST || '';
  if (config.DATABASE_URL) {
    host = new URL(config.DATABASE_URL).hostname;
  }
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()), 'Integration migration test refuses a non-local database');
}

async function expectPgCode(client, sql, params, expectedCode) {
  await assert.rejects(client.query(sql, params), (error) => error.code === expectedCode);
}

test('media_object migration executes against PostgreSQL and enforces constraints, indexes and cascade', async (t) => {
  assertLocalDevelopmentDatabase();
  const pool = new Pool(buildPgPoolConfig(config));
  const client = await pool.connect();

  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}`);
    assert.equal((await client.query("SELECT to_regclass('media_object') AS table_name")).rows[0].table_name, null);
    await client.query('CREATE TABLE file (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)');
    await client.query(migration);

    const fileId = (await client.query('INSERT INTO file DEFAULT VALUES RETURNING id')).rows[0].id;
    await client.query(
      `INSERT INTO media_object (file_id, provider, variant, local_path, size_bytes, sha256, status)
       VALUES ($1, 'local', 'original', 'public/img/example.jpg', 123, repeat('a', 64), 'ready')`,
      [fileId],
    );
    const pending = await client.query(
      `INSERT INTO media_object (file_id, provider, variant, object_key, size_bytes, sha256)
       VALUES ($1, 'r2', 'original', 'articles/1/images/1/aaaaaaaaaaaa-original.jpg', 123, repeat('a', 64))
       RETURNING status`,
      [fileId],
    );
    assert.equal(pending.rows[0].status, 'pending');

    await expectPgCode(
      client,
      `INSERT INTO media_object (file_id, provider, variant, local_path, size_bytes, sha256)
       VALUES ($1, 'r2', 'small', 'wrong/location.jpg', 1, repeat('b', 64))`,
      [fileId],
      '23514',
    );
    await expectPgCode(
      client,
      `INSERT INTO media_object (file_id, provider, variant, object_key, size_bytes, sha256)
       VALUES ($1, 'r2', 'video', 'bad-size', -1, repeat('b', 64))`,
      [fileId],
      '23514',
    );
    await expectPgCode(
      client,
      `INSERT INTO media_object (file_id, provider, variant, object_key, size_bytes, sha256)
       VALUES ($1, 'r2', 'video', 'bad-sha', 1, repeat('G', 64))`,
      [fileId],
      '23514',
    );
    await expectPgCode(
      client,
      `INSERT INTO media_object (file_id, provider, variant, object_key, size_bytes, sha256)
       VALUES ($1, 'r2', 'original', 'duplicate-slot', 123, repeat('c', 64))`,
      [fileId],
      '23505',
    );

    const indexes = await client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1
         AND tablename = 'media_object'
         AND indexname = ANY($2::text[])`,
      [schema, ['media_object_r2_key_uidx', 'media_object_local_path_uidx', 'media_object_file_id_idx', 'media_object_provider_status_idx']],
    );
    assert.equal(indexes.rowCount, 4);

    await client.query('DELETE FROM file WHERE id = $1', [fileId]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM media_object')).rows[0].count, 0);
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
