const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dialectPath = path.resolve(__dirname, '../src/app/database/dialect.js');
const pgUtilsPath = path.resolve(__dirname, '../src/app/database/pg.utils.js');
const pgConfigPath = path.resolve(__dirname, '../src/app/database/pg.config.js');

const loadModule = (modulePath, label) => {
  assert.equal(fs.existsSync(modulePath), true, `Expected ${label} to exist`);
  return require(modulePath);
};

test('normalizeDialect defaults to mysql and accepts pg aliases', () => {
  const { normalizeDialect, getClientModuleName } = loadModule(dialectPath, 'database dialect helper');

  assert.equal(normalizeDialect(undefined), 'mysql');
  assert.equal(normalizeDialect('mysql'), 'mysql');
  assert.equal(normalizeDialect('pg'), 'pg');
  assert.equal(normalizeDialect('PostgreSQL'), 'pg');
  assert.equal(getClientModuleName('mysql'), 'mysql.client');
  assert.equal(getClientModuleName('pg'), 'pg.client');
});

test('normalizeDialect fails fast for unknown explicit dialect values', () => {
  const { normalizeDialect } = loadModule(dialectPath, 'database dialect helper');

  assert.throws(() => normalizeDialect('pgsql'), /Unsupported DB_DIALECT/);
});

test('convertQuestionPlaceholders only rewrites bind parameters', () => {
  const { convertQuestionPlaceholders } = loadModule(pgUtilsPath, 'pg compatibility helper');

  const sql = `
    SELECT CONCAT('/article/images/', filename, '?type=small') cover
    FROM file
    WHERE article_id = ? AND file_type = ?;
  `;

  assert.equal(
    convertQuestionPlaceholders(sql).trim(),
    `
    SELECT CONCAT('/article/images/', filename, '?type=small') cover
    FROM file
    WHERE article_id = $1 AND file_type = $2;
  `.trim()
  );
});

test('convertQuestionPlaceholders ignores question marks inside SQL comments', () => {
  const { convertQuestionPlaceholders } = loadModule(pgUtilsPath, 'pg compatibility helper');

  const sql = `
    SELECT *
    FROM article
    -- keep ? for docs
    WHERE id = ?
    /* block ? comment */
    AND user_id = ?;
  `;

  assert.equal(
    convertQuestionPlaceholders(sql).trim(),
    `
    SELECT *
    FROM article
    -- keep ? for docs
    WHERE id = $1
    /* block ? comment */
    AND user_id = $2;
  `.trim()
  );
});

test('adaptPgResult returns mysql-style rows tuple for SELECT queries', () => {
  const { adaptPgResult } = loadModule(pgUtilsPath, 'pg compatibility helper');
  const fields = [{ name: 'id' }];

  const [rows, returnedFields] = adaptPgResult({
    command: 'SELECT',
    rowCount: 1,
    rows: [{ id: 1 }],
    fields,
  });

  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(returnedFields, fields);
});

test('adaptPgResult exposes affectedRows and insertId for INSERT queries', () => {
  const { adaptPgResult } = loadModule(pgUtilsPath, 'pg compatibility helper');

  const [result] = adaptPgResult({
    command: 'INSERT',
    rowCount: 1,
    rows: [{ id: 42 }],
    fields: [],
  });

  assert.equal(result.affectedRows, 1);
  assert.equal(result.insertId, 42);
  assert.equal(result.rowCount, 1);
});

test('createPgConnectionAdapter exposes mysql-like transaction methods', async () => {
  const { createPgConnectionAdapter } = loadModule(pgUtilsPath, 'pg compatibility helper');
  const calls = [];
  let released = false;

  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { command: sql, rowCount: null, rows: [], fields: [] };
      }

      return {
        command: 'SELECT',
        rowCount: 1,
        rows: [{ id: 7 }],
        fields: [{ name: 'id' }],
      };
    },
    release() {
      released = true;
    },
  };

  const connection = createPgConnectionAdapter(fakeClient);

  await connection.begin();
  const [rows] = await connection.execute("SELECT '?type=small' literal, ? AS id", [7]);
  await connection.commit();
  connection.release();

  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls[1].sql, "SELECT '?type=small' literal, $1 AS id");
  assert.deepEqual(calls[1].params, [7]);
  assert.equal(calls[2].sql, 'COMMIT');
  assert.deepEqual(rows, [{ id: 7 }]);
  assert.equal(released, true);
  assert.equal(typeof connection.beginTransaction, 'function');
});

test('buildPgPoolConfig validates pg connection settings', () => {
  const { buildPgPoolConfig } = loadModule(pgConfigPath, 'pg pool config helper');

  assert.throws(() => buildPgPoolConfig({}), /Missing PostgreSQL config/);

  assert.deepEqual(buildPgPoolConfig({ DATABASE_URL: 'postgres://user:pass@localhost:5432/coderx' }), { // pragma: allowlist secret
    connectionString: 'postgres://user:pass@localhost:5432/coderx', // pragma: allowlist secret
    max: 10,
  });

  assert.deepEqual(
    buildPgPoolConfig({
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGDATABASE: 'coderx',
      PGUSER: 'postgres',
      PGPASSWORD: 'secret', // pragma: allowlist secret
    }),
    {
      host: 'localhost',
      port: '5432',
      database: 'coderx',
      user: 'postgres',
      password: 'secret', // pragma: allowlist secret
      max: 10,
    }
  );
});
