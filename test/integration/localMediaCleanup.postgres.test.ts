import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

import { integrationDatabaseConfig } from './databaseConfig.js';
import { createPgConnectionAdapter } from '../../src/app/database/pg.utils.js';
import { LocalMediaCleanupService } from '../../src/service/localMediaCleanup.service.js';

const schema = `media_local_cleanup_test_${process.pid}`;
const quotedSchema = `"${schema}"`;
const migration = fs.readFileSync(new URL('../../migrations/011_create_media_local_cleanup.sql', import.meta.url), 'utf8');

test('media_local_cleanup migration provides a constrained, retryable filename tombstone', async (t) => {
  const pool = new pg.Pool(integrationDatabaseConfig());
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
