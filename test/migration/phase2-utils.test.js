const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../scripts/migration/phase2/lib/migrationUtils.js');
const runtimePath = path.resolve(__dirname, '../../scripts/migration/phase2/lib/runtime.js');

const loadHelpers = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected phase2 migration helper module to exist');
  return require(helperPath);
};

const loadRuntime = () => {
  assert.equal(fs.existsSync(runtimePath), true, 'Expected phase2 migration runtime module to exist');
  return require(runtimePath);
};

const writeTempStage1Schema = (schemaSql) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-stage1-schema-'));
  const schemaPath = path.join(tempDir, '001_schema.sql');
  fs.writeFileSync(schemaPath, schemaSql, 'utf8');
  return schemaPath;
};

const createPoolsWithMissingStage1Tables = () => {
  const mysqlQueries = [];
  const pgQueries = [];
  let connectCalled = false;

  const mysqlPool = {
    async query(sql) {
      mysqlQueries.push(sql);

      if (sql.includes("constraint_type = 'PRIMARY KEY'")) {
        return [
          [
            {
              table_name: 'user',
              column_name: 'id',
              ordinal_position: 1,
            },
          ],
        ];
      }

      if (sql.includes('COUNT(*) AS rowCount')) {
        return [[{ rowCount: 0 }]];
      }

      if (sql.startsWith('SELECT * FROM `user`')) {
        return [[]];
      }

      throw new Error(`Unexpected MySQL query in test stub: ${sql}`);
    },
  };

  const pgPool = {
    async query(sql) {
      pgQueries.push(sql);

      if (sql.includes('FROM information_schema.tables')) {
        return {
          rows: [{ table_name: 'user' }],
        };
      }

      if (sql.includes('FROM information_schema.columns')) {
        return {
          rows: [
            {
              table_name: 'user',
              column_name: 'id',
              data_type: 'bigint',
              is_identity: 'YES',
            },
          ],
        };
      }

      if (sql.includes("constraint_type = 'PRIMARY KEY'")) {
        return {
          rows: [
            {
              table_name: 'user',
              column_name: 'id',
              ordinal_position: 1,
            },
          ],
        };
      }

      if (sql.includes("constraint_type = 'FOREIGN KEY'")) {
        return { rows: [] };
      }

      if (sql.includes('COUNT(*)::int AS "rowCount"')) {
        return {
          rows: [{ rowCount: 0 }],
        };
      }

      if (sql.startsWith('SELECT * FROM "user"')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected PostgreSQL query in test stub: ${sql}`);
    },
    async connect() {
      connectCalled = true;

      return {
        async query(sql) {
          pgQueries.push(`client:${sql}`);

          if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('TRUNCATE TABLE') || sql.startsWith('SELECT setval')) {
            return {
              rows: [],
              rowCount: 0,
            };
          }

          throw new Error(`Unexpected PostgreSQL client query in test stub: ${sql}`);
        },
        release() {},
      };
    },
  };

  return {
    mysqlPool,
    pgPool,
    mysqlQueries,
    pgQueries,
    wasConnectCalled: () => connectCalled,
  };
};

test('buildInsertSql quotes identifiers and uses PostgreSQL placeholders', () => {
  const { buildInsertSql } = loadHelpers();

  assert.equal(
    buildInsertSql('user', ['id', 'name', 'profile_id']),
    'INSERT INTO "user" ("id", "name", "profile_id") VALUES ($1, $2, $3)'
  );
});

test('normalizeRowValues converts booleans and JSON payloads for PostgreSQL', () => {
  const { normalizeRowValues } = loadHelpers();

  const normalized = normalizeRowValues(
    {
      is_admin: 1,
      is_muted: 0,
      metadata: '{"theme":"dark"}',
      name: 'alice',
      nullable_flag: null,
    },
    new Map([
      ['is_admin', 'boolean'],
      ['is_muted', 'boolean'],
      ['metadata', 'jsonb'],
      ['name', 'text'],
      ['nullable_flag', 'boolean'],
    ])
  );

  assert.deepEqual(normalized, {
    is_admin: true,
    is_muted: false,
    metadata: { theme: 'dark' },
    name: 'alice',
    nullable_flag: null,
  });
});

test('buildSetvalSql resets identity sequence from table max id', () => {
  const { buildSetvalSql } = loadHelpers();

  assert.equal(
    buildSetvalSql('user', 'id'),
    `SELECT setval(pg_get_serial_sequence('"user"', 'id'), COALESCE(MAX("id"), 1), COALESCE(MAX("id"), 0) > 0) FROM "user";`
  );
});

test('topologicallySortTables keeps referenced tables before dependents', () => {
  const { topologicallySortTables } = loadHelpers();

  const sorted = topologicallySortTables(
    ['comment', 'user', 'article', 'article_tag', 'tag'],
    [
      { table: 'article', dependsOn: 'user' },
      { table: 'comment', dependsOn: 'user' },
      { table: 'comment', dependsOn: 'article' },
      { table: 'article_tag', dependsOn: 'article' },
      { table: 'article_tag', dependsOn: 'tag' },
    ]
  );

  assert.ok(sorted.indexOf('user') < sorted.indexOf('article'));
  assert.ok(sorted.indexOf('user') < sorted.indexOf('comment'));
  assert.ok(sorted.indexOf('article') < sorted.indexOf('comment'));
  assert.ok(sorted.indexOf('article') < sorted.indexOf('article_tag'));
  assert.ok(sorted.indexOf('tag') < sorted.indexOf('article_tag'));
});

test('normalizeComparableRow makes MySQL and PostgreSQL row values comparable', () => {
  const { normalizeComparableRow } = loadHelpers();

  const normalized = normalizeComparableRow({
    id: '7',
    is_admin: true,
    metadata: { theme: 'dark', tags: ['pg', 'koa'] },
    create_at: new Date('2026-04-05T09:00:00.000Z'),
    empty_value: null,
  });

  assert.deepEqual(normalized, {
    id: '7',
    is_admin: 'true',
    metadata: '{"tags":["pg","koa"],"theme":"dark"}',
    create_at: '2026-04-05T09:00:00.000Z',
    empty_value: null,
  });
});

test('buildRowCountDiffReport marks mismatched tables and preserves matching ones', () => {
  const { buildRowCountDiffReport } = loadHelpers();

  const report = buildRowCountDiffReport(
    [
      { table: 'article', rowCount: 27 },
      { table: 'video_meta', rowCount: 1 },
    ],
    [
      { table: 'article', rowCount: 26 },
      { table: 'video_meta', rowCount: 0 },
    ]
  );

  assert.deepEqual(report, [
    { table: 'article', mysqlRowCount: 27, pgRowCount: 26, isMatched: false, delta: -1 },
    { table: 'video_meta', mysqlRowCount: 1, pgRowCount: 0, isMatched: false, delta: -1 },
  ]);
});

test('extractStage1TableNames reads quoted and unquoted tables from Stage 1 schema SQL', () => {
  const { extractStage1TableNames } = loadHelpers();

  const tables = extractStage1TableNames(`
    CREATE TABLE IF NOT EXISTS public."user" (
      id BIGINT PRIMARY KEY
    );

    CREATE TABLE public.article (
      id BIGINT PRIMARY KEY
    );
  `);

  assert.deepEqual(tables, ['user', 'article']);
});

test('verifyParity fails fast when required Stage 1 tables are missing in PostgreSQL', async () => {
  const { verifyParity } = loadRuntime();
  const schemaPath = writeTempStage1Schema(`
    CREATE TABLE IF NOT EXISTS public."user" (
      id BIGINT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS public.article (
      id BIGINT PRIMARY KEY
    );
  `);
  const { mysqlPool, pgPool, mysqlQueries, pgQueries } = createPoolsWithMissingStage1Tables();

  await assert.rejects(
    () =>
      verifyParity(mysqlPool, pgPool, 'coderx', {
        stage1SchemaPath: schemaPath,
      }),
    /Stage 1 schema.*missing.*article/i
  );

  assert.deepEqual(mysqlQueries, []);
  assert.equal(pgQueries.length, 1);
  assert.match(pgQueries[0], /FROM information_schema\.tables/i);
});

test('bootstrapPostgresFromMySql fails fast before connecting when required Stage 1 tables are missing in PostgreSQL', async () => {
  const { bootstrapPostgresFromMySql } = loadRuntime();
  const schemaPath = writeTempStage1Schema(`
    CREATE TABLE IF NOT EXISTS public."user" (
      id BIGINT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS public.article (
      id BIGINT PRIMARY KEY
    );
  `);
  const { mysqlPool, pgPool, mysqlQueries, wasConnectCalled } = createPoolsWithMissingStage1Tables();

  await assert.rejects(
    () =>
      bootstrapPostgresFromMySql(mysqlPool, pgPool, 'coderx', {
        stage1SchemaPath: schemaPath,
      }),
    /Stage 1 schema.*missing.*article/i
  );

  assert.deepEqual(mysqlQueries, []);
  assert.equal(wasConnectCalled(), false);
});
