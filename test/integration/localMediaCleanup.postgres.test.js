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
const { LocalMediaCleanupService } = require('../../src/service/localMediaCleanup.service');

const schema = `media_local_cleanup_test_${process.pid}`;
const quotedSchema = `"${schema}"`;
const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/011_create_media_local_cleanup.sql'), 'utf8');

function assertLocalDevelopmentDatabase() {
  let host = config.PGHOST || '';
  if (config.DATABASE_URL) host = new URL(config.DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase()), 'Integration migration test refuses a non-local database');
}

test('media_local_cleanup migration provides a constrained, retryable filename tombstone', async (t) => {
  assertLocalDevelopmentDatabase();
  const pool = new Pool(buildPgPoolConfig(config));
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}`);
    await client.query(migration);
    const inserted = await client.query(
      `INSERT INTO media_local_cleanup (storage_area, filename)
       VALUES ('video', 'clip.mp4')
       RETURNING id, attempt_count`,
    );
    assert.equal(inserted.rows[0].attempt_count, 0);
    await assert.rejects(client.query(`INSERT INTO media_local_cleanup (storage_area, filename) VALUES ('video', '../secret')`), (error) => error.code === '23514');
    await assert.rejects(client.query(`INSERT INTO media_local_cleanup (storage_area, filename) VALUES ('other', 'clip.mp4')`), (error) => error.code === '23514');
    await assert.rejects(client.query(`INSERT INTO media_local_cleanup (storage_area, filename) VALUES ('video', 'clip.mp4')`), (error) => error.code === '23505');

    for (let index = 1; index <= 99; index += 1) {
      await client.query(`INSERT INTO media_local_cleanup (storage_area, filename) VALUES ('video', $1)`, [`blocked-${index}.mp4`]);
    }
    await client.query(`INSERT INTO media_local_cleanup (storage_area, filename) VALUES ('video', 'tail.mp4')`);

    const scopedDatabase = {
      async getConnection() {
        const scopedClient = await pool.connect();
        await scopedClient.query(`SET search_path TO ${quotedSchema}`);
        return createPgConnectionAdapter(scopedClient);
      },
    };
    const cleanup = new LocalMediaCleanupService({
      database: scopedDatabase,
      roots: { image: '/tmp/phase4-img', video: '/tmp/phase4-video' },
      fsPromises: {
        async unlink(filePath) {
          if (filePath.endsWith('/tail.mp4')) return;
          const error = new Error('permanent permission failure');
          error.code = 'EACCES';
          throw error;
        },
      },
    });

    const firstBatch = await cleanup.processPending({ limit: 100 });
    assert.equal(firstBatch.failed, 100);
    const secondBatch = await cleanup.processPending({ limit: 1 });
    assert.equal(secondBatch.deleted, 1, 'updated_at ordering must let a newer tail row pass permanently failing rows');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM media_local_cleanup')).rows[0].count, 100);
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
});
