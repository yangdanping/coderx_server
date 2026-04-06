const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');

const {
  buildInsertSql,
  buildRowCountDiffReport,
  buildSetvalSql,
  extractStage1TableNames,
  findMissingTables,
  normalizeComparableRow,
  normalizeRowValues,
  quoteIdentifier,
  topologicallySortTables,
} = require('./migrationUtils');

const DEFAULT_SAMPLE_LIMIT = 5;

const quoteMySqlIdentifier = (identifier) => {
  return `\`${String(identifier).replace(/`/g, '``')}\``;
};

const parseArgs = (argv) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const trimmedToken = token.slice(2);

    if (trimmedToken.includes('=')) {
      const [key, value] = trimmedToken.split(/=(.*)/s, 2);
      parsed[key] = value;
      continue;
    }

    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith('--')) {
      parsed[trimmedToken] = true;
      continue;
    }

    parsed[trimmedToken] = nextToken;
    index += 1;
  }

  return parsed;
};

const resolveAbsolutePath = (inputPath) => {
  if (!inputPath) {
    return null;
  }

  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(process.cwd(), inputPath);
};

const loadEnvFile = (inputPath) => {
  const resolvedPath = resolveAbsolutePath(inputPath);

  if (!resolvedPath) {
    return null;
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Env file not found: ${resolvedPath}`);
  }

  dotenv.config({ path: resolvedPath, override: true });
  return resolvedPath;
};

const ensureRequired = (value, fieldName) => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required configuration: ${fieldName}`);
  }

  return value;
};

const buildRuntimeConfig = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  const loadedEnvFiles = [];

  ['env-file', 'mysql-env-file', 'pg-env-file']
    .map((key) => args[key])
    .filter(Boolean)
    .forEach((filePath) => {
      const loadedPath = loadEnvFile(filePath);
      if (loadedPath) {
        loadedEnvFiles.push(loadedPath);
      }
    });

  const mysqlConfig = {
    host: ensureRequired(args['mysql-host'] || process.env.MYSQL_HOST, 'MYSQL_HOST / --mysql-host'),
    port: Number(args['mysql-port'] || process.env.MYSQL_PORT || 3306),
    database: ensureRequired(args['mysql-database'] || process.env.MYSQL_DATABASE, 'MYSQL_DATABASE / --mysql-database'),
    user: ensureRequired(args['mysql-user'] || process.env.MYSQL_USER, 'MYSQL_USER / --mysql-user'),
    password: ensureRequired(args['mysql-password'] || process.env.MYSQL_PASSWORD, 'MYSQL_PASSWORD / --mysql-password'),
  };

  const pgConfig = {
    host: args['pg-host'] || process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: Number(args['pg-port'] || process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    database: ensureRequired(args['pg-database'] || process.env.PGDATABASE || process.env.POSTGRES_DB || process.env.MYSQL_DATABASE, 'PGDATABASE / --pg-database'),
    user: ensureRequired(args['pg-user'] || process.env.PGUSER || process.env.POSTGRES_USER || 'postgres', 'PGUSER / --pg-user'),
    password: ensureRequired(
      args['pg-password'] || process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || process.env.POSTGRESQL_PASSWORD,
      'PGPASSWORD / --pg-password'
    ),
  };

  return {
    args,
    loadedEnvFiles,
    mysqlConfig,
    pgConfig,
    sampleLimit: Number(args['sample-limit'] || DEFAULT_SAMPLE_LIMIT),
  };
};

const createMySqlPool = (config) => {
  return mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 5,
  });
};

const createPgPool = (config) => {
  return new Pool({
    ...config,
    max: 5,
  });
};

const resolveStage1SchemaPath = (schemaPath) => {
  if (schemaPath) {
    return resolveAbsolutePath(schemaPath);
  }

  return path.resolve(__dirname, '../../../../database/postgresql/001_schema.sql');
};

const loadRequiredStage1Tables = (schemaPath) => {
  const resolvedSchemaPath = resolveStage1SchemaPath(schemaPath);

  if (!resolvedSchemaPath || !fs.existsSync(resolvedSchemaPath)) {
    throw new Error(`Stage 1 schema file not found: ${resolvedSchemaPath || schemaPath}`);
  }

  const schemaSql = fs.readFileSync(resolvedSchemaPath, 'utf8');

  return {
    schemaPath: resolvedSchemaPath,
    requiredTables: extractStage1TableNames(schemaSql),
  };
};

const assertStage1SchemaPresent = (pgTables, options = {}) => {
  const { requiredTables } = loadRequiredStage1Tables(options.stage1SchemaPath);
  const missingTables = findMissingTables(requiredTables, pgTables);

  if (missingTables.length > 0) {
    throw new Error(
      `Stage 1 schema prerequisite is missing in PostgreSQL. Missing required tables: ${missingTables.join(
        ', '
      )}. Apply database/postgresql/001_schema.sql, database/postgresql/002_triggers.sql, database/postgresql/003_indexes.sql, and optionally database/postgresql/004_verify.sql before running Phase 2 bootstrap or verify.`
    );
  }
};

const fetchPgTableNames = async (pgPool) => {
  const result = await pgPool.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `
  );

  return result.rows.map((row) => row.table_name);
};

const fetchPgColumnRows = async (pgPool) => {
  const result = await pgPool.query(
    `
      SELECT table_name, column_name, data_type, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position;
    `
  );

  return result.rows;
};

const fetchPrimaryKeyRows = async (dbType, pool, schemaName) => {
  const queryByDatabase = {
    mysql: `
      SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      WHERE tc.table_schema = ?
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY tc.table_name, kcu.ordinal_position;
    `,
    pg: `
      SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      WHERE tc.table_schema = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY tc.table_name, kcu.ordinal_position;
    `,
  };

  if (dbType === 'mysql') {
    const [rows] = await pool.query(queryByDatabase.mysql, [schemaName]);
    return rows;
  }

  const result = await pool.query(queryByDatabase.pg, [schemaName]);
  return result.rows;
};

const fetchForeignKeyRows = async (pgPool) => {
  const result = await pgPool.query(
    `
      SELECT
        tc.constraint_name,
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS referenced_table_name,
        ccu.column_name AS referenced_column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.constraint_name, kcu.ordinal_position;
    `
  );

  return result.rows;
};

const groupRowsByTable = (rows, valueSelector) => {
  const tableMap = new Map();

  rows.forEach((row) => {
    if (!tableMap.has(row.table_name)) {
      tableMap.set(row.table_name, []);
    }

    tableMap.get(row.table_name).push(valueSelector(row));
  });

  return tableMap;
};

const buildForeignKeyConstraints = (rows) => {
  const groupedConstraints = new Map();

  rows.forEach((row) => {
    if (!groupedConstraints.has(row.constraint_name)) {
      groupedConstraints.set(row.constraint_name, {
        constraintName: row.constraint_name,
        table: row.table_name,
        referencedTable: row.referenced_table_name,
        columns: [],
        referencedColumns: [],
      });
    }

    const constraint = groupedConstraints.get(row.constraint_name);
    constraint.columns.push(row.column_name);
    constraint.referencedColumns.push(row.referenced_column_name);
  });

  return Array.from(groupedConstraints.values()).sort((left, right) => left.constraintName.localeCompare(right.constraintName));
};

const buildTableMetadata = async (mysqlPool, pgPool, mysqlDatabase, options = {}) => {
  const tables = await fetchPgTableNames(pgPool);

  assertStage1SchemaPresent(tables, options);

  const [pgColumnRows, mysqlPrimaryKeyRows, pgPrimaryKeyRows, foreignKeyRows] = await Promise.all([
    fetchPgColumnRows(pgPool),
    fetchPrimaryKeyRows('mysql', mysqlPool, mysqlDatabase),
    fetchPrimaryKeyRows('pg', pgPool, 'public'),
    fetchForeignKeyRows(pgPool),
  ]);

  const columnRowsByTable = groupRowsByTable(pgColumnRows, (row) => row);
  const mysqlPrimaryKeys = groupRowsByTable(mysqlPrimaryKeyRows, (row) => row.column_name);
  const pgPrimaryKeys = groupRowsByTable(pgPrimaryKeyRows, (row) => row.column_name);
  const foreignKeys = buildForeignKeyConstraints(foreignKeyRows);
  const dependencyOrder = topologicallySortTables(
    tables,
    foreignKeys.map((constraint) => ({
      table: constraint.table,
      dependsOn: constraint.referencedTable,
    }))
  );

  const tableMetadataMap = new Map();

  tables.forEach((tableName) => {
    const columns = (columnRowsByTable.get(tableName) || []).map((row) => row.column_name);
    const typeMap = new Map((columnRowsByTable.get(tableName) || []).map((row) => [row.column_name, row.data_type]));
    const identityColumns = (columnRowsByTable.get(tableName) || [])
      .filter((row) => row.is_identity === 'YES')
      .map((row) => row.column_name);

    tableMetadataMap.set(tableName, {
      table: tableName,
      columns,
      typeMap,
      identityColumns,
      primaryKey: pgPrimaryKeys.get(tableName) || mysqlPrimaryKeys.get(tableName) || [],
      foreignKeys: foreignKeys.filter((constraint) => constraint.table === tableName),
    });
  });

  return dependencyOrder.map((tableName) => tableMetadataMap.get(tableName));
};

const buildOrderByClause = (columns, identifierQuoter) => {
  if (!columns || columns.length === 0) {
    return '';
  }

  return ` ORDER BY ${columns.map((column) => identifierQuoter(column)).join(', ')}`;
};

const fetchMySqlRows = async (mysqlPool, tableMeta) => {
  const sql = `SELECT * FROM ${quoteMySqlIdentifier(tableMeta.table)}${buildOrderByClause(tableMeta.primaryKey, quoteMySqlIdentifier)};`;
  const [rows] = await mysqlPool.query(sql);
  return rows;
};

const fetchPgRows = async (pgPool, tableMeta) => {
  const sql = `SELECT * FROM ${quoteIdentifier(tableMeta.table)}${buildOrderByClause(tableMeta.primaryKey, quoteIdentifier)};`;
  const result = await pgPool.query(sql);
  return result.rows;
};

const normalizeMySqlRowsForCompare = (rows, tableMeta) => {
  return rows.map((row) => {
    return normalizeComparableRow(normalizeRowValues(row, tableMeta.typeMap));
  });
};

const normalizePgRowsForCompare = (rows) => {
  return rows.map((row) => normalizeComparableRow(row));
};

const buildPrimaryKeyValue = (row, primaryKeyColumns) => {
  if (!primaryKeyColumns || primaryKeyColumns.length === 0) {
    return JSON.stringify(row);
  }

  return primaryKeyColumns.map((column) => row[column]).join('::');
};

const buildRowDiff = (tableMeta, mysqlRows, pgRows, sampleLimit) => {
  const mysqlComparableRows = normalizeMySqlRowsForCompare(mysqlRows, tableMeta);
  const pgComparableRows = normalizePgRowsForCompare(pgRows);
  const mysqlRowMap = new Map(mysqlComparableRows.map((row) => [buildPrimaryKeyValue(row, tableMeta.primaryKey), row]));
  const pgRowMap = new Map(pgComparableRows.map((row) => [buildPrimaryKeyValue(row, tableMeta.primaryKey), row]));

  const missingPrimaryKeys = [];
  const extraPrimaryKeys = [];
  const differingRows = [];

  Array.from(mysqlRowMap.keys())
    .sort()
    .forEach((key) => {
      if (!pgRowMap.has(key)) {
        if (missingPrimaryKeys.length < sampleLimit) {
          missingPrimaryKeys.push(key);
        }
        return;
      }

      const mysqlRow = mysqlRowMap.get(key);
      const pgRow = pgRowMap.get(key);
      const hasDifference = tableMeta.columns.some((column) => (mysqlRow[column] ?? null) !== (pgRow[column] ?? null));

      if (hasDifference && differingRows.length < sampleLimit) {
        differingRows.push({
          primaryKey: key,
          mysqlRow,
          pgRow,
        });
      }
    });

  Array.from(pgRowMap.keys())
    .sort()
    .forEach((key) => {
      if (!mysqlRowMap.has(key) && extraPrimaryKeys.length < sampleLimit) {
        extraPrimaryKeys.push(key);
      }
    });

  return {
    table: tableMeta.table,
    mysqlRowCount: mysqlComparableRows.length,
    pgRowCount: pgComparableRows.length,
    isMatched: missingPrimaryKeys.length === 0 && extraPrimaryKeys.length === 0 && differingRows.length === 0,
    missingPrimaryKeys,
    extraPrimaryKeys,
    differingRows,
  };
};

const fetchRowCounts = async (dbType, pool, tables) => {
  const counts = [];

  for (const tableName of tables) {
    if (dbType === 'mysql') {
      const [rows] = await pool.query(`SELECT COUNT(*) AS rowCount FROM ${quoteMySqlIdentifier(tableName)};`);
      counts.push({
        table: tableName,
        rowCount: Number(rows[0].rowCount),
      });
      continue;
    }

    const result = await pool.query(`SELECT COUNT(*)::int AS "rowCount" FROM ${quoteIdentifier(tableName)};`);
    counts.push({
      table: tableName,
      rowCount: Number(result.rows[0].rowCount),
    });
  }

  return counts;
};

const truncateAllPgTables = async (pgClient, tables) => {
  const truncateSql = `TRUNCATE TABLE ${tables.map((tableName) => quoteIdentifier(tableName)).join(', ')} RESTART IDENTITY CASCADE;`;
  await pgClient.query(truncateSql);
};

const syncTable = async (mysqlPool, pgClient, tableMeta) => {
  const rows = await fetchMySqlRows(mysqlPool, tableMeta);

  if (rows.length === 0) {
    return {
      table: tableMeta.table,
      importedRowCount: 0,
    };
  }

  const insertSql = buildInsertSql(tableMeta.table, tableMeta.columns, {
    overrideIdentity: tableMeta.identityColumns.length > 0,
  });

  for (const row of rows) {
    const normalizedRow = normalizeRowValues(row, tableMeta.typeMap);
    const values = tableMeta.columns.map((column) => normalizedRow[column]);
    await pgClient.query(insertSql, values);
  }

  return {
    table: tableMeta.table,
    importedRowCount: rows.length,
  };
};

const resetSequences = async (pgClient, tableMetas) => {
  const sequenceTables = [];

  for (const tableMeta of tableMetas) {
    for (const columnName of tableMeta.identityColumns) {
      await pgClient.query(buildSetvalSql(tableMeta.table, columnName));
      sequenceTables.push(`${tableMeta.table}.${columnName}`);
    }
  }

  return sequenceTables;
};

const bootstrapPostgresFromMySql = async (mysqlPool, pgPool, mysqlDatabase, options = {}) => {
  const tableMetas = await buildTableMetadata(mysqlPool, pgPool, mysqlDatabase, options);
  const pgClient = await pgPool.connect();

  try {
    await pgClient.query('BEGIN');
    await truncateAllPgTables(
      pgClient,
      tableMetas.map((meta) => meta.table)
    );

    const importReport = [];
    for (const tableMeta of tableMetas) {
      importReport.push(await syncTable(mysqlPool, pgClient, tableMeta));
    }

    const resetSequenceTargets = await resetSequences(pgClient, tableMetas);
    await pgClient.query('COMMIT');

    return {
      tableMetas,
      importReport,
      resetSequenceTargets,
    };
  } catch (error) {
    await pgClient.query('ROLLBACK');
    throw error;
  } finally {
    pgClient.release();
  }
};

const verifyParity = async (mysqlPool, pgPool, mysqlDatabase, options = {}) => {
  const sampleLimit = options.sampleLimit || DEFAULT_SAMPLE_LIMIT;
  const tableMetas = await buildTableMetadata(mysqlPool, pgPool, mysqlDatabase, options);
  const tables = tableMetas.map((meta) => meta.table);
  const [mysqlCounts, pgCounts] = await Promise.all([fetchRowCounts('mysql', mysqlPool, tables), fetchRowCounts('pg', pgPool, tables)]);

  const rowCountReport = buildRowCountDiffReport(mysqlCounts, pgCounts);
  const rowDiffReport = [];

  for (const tableMeta of tableMetas) {
    const [mysqlRows, pgRows] = await Promise.all([fetchMySqlRows(mysqlPool, tableMeta), fetchPgRows(pgPool, tableMeta)]);
    rowDiffReport.push(buildRowDiff(tableMeta, mysqlRows, pgRows, sampleLimit));
  }

  const orphanChecks = [];
  for (const tableMeta of tableMetas) {
    for (const foreignKey of tableMeta.foreignKeys) {
      const joinClause = foreignKey.columns
        .map((column, index) => `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(foreignKey.referencedColumns[index])}`)
        .join(' AND ');
      const nonNullClause = foreignKey.columns.map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`).join(' AND ');
      const orphanSql = `
        SELECT COUNT(*)::int AS "orphanCount"
        FROM ${quoteIdentifier(foreignKey.table)} child
        LEFT JOIN ${quoteIdentifier(foreignKey.referencedTable)} parent
          ON ${joinClause}
        WHERE ${nonNullClause}
          AND parent.${quoteIdentifier(foreignKey.referencedColumns[0])} IS NULL;
      `;
      const result = await pgPool.query(orphanSql);
      orphanChecks.push({
        constraintName: foreignKey.constraintName,
        table: foreignKey.table,
        referencedTable: foreignKey.referencedTable,
        orphanCount: Number(result.rows[0].orphanCount),
      });
    }
  }

  const hasCountMismatch = rowCountReport.some((item) => !item.isMatched);
  const hasRowMismatch = rowDiffReport.some((item) => !item.isMatched);
  const hasOrphans = orphanChecks.some((item) => item.orphanCount > 0);

  return {
    mysqlDatabase,
    tableCount: tableMetas.length,
    rowCountReport,
    rowDiffReport,
    orphanChecks,
    isSuccess: !hasCountMismatch && !hasRowMismatch && !hasOrphans,
  };
};

const formatCountLine = (row) => {
  return `- ${row.table}: mysql=${row.mysqlRowCount}, pg=${row.pgRowCount}, delta=${row.delta}`;
};

const formatVerificationSummary = (report) => {
  const lines = [];

  lines.push(`Phase 2 verification: ${report.isSuccess ? 'PASS' : 'FAIL'}`);
  lines.push(`Checked tables: ${report.tableCount}`);

  const mismatchedCounts = report.rowCountReport.filter((item) => !item.isMatched);
  if (mismatchedCounts.length === 0) {
    lines.push('Row counts: all matched');
  } else {
    lines.push('Row counts with mismatches:');
    mismatchedCounts.forEach((row) => lines.push(formatCountLine(row)));
  }

  const rowDiffs = report.rowDiffReport.filter((item) => !item.isMatched);
  if (rowDiffs.length === 0) {
    lines.push('Row content: all matched');
  } else {
    lines.push('Row content mismatches:');
    rowDiffs.forEach((rowDiff) => {
      lines.push(`- ${rowDiff.table}: missingInPg=${rowDiff.missingPrimaryKeys.length}, extraInPg=${rowDiff.extraPrimaryKeys.length}, differingRows=${rowDiff.differingRows.length}`);
      if (rowDiff.missingPrimaryKeys.length > 0) {
        lines.push(`  missing sample: ${rowDiff.missingPrimaryKeys.join(', ')}`);
      }
      if (rowDiff.extraPrimaryKeys.length > 0) {
        lines.push(`  extra sample: ${rowDiff.extraPrimaryKeys.join(', ')}`);
      }
      if (rowDiff.differingRows.length > 0) {
        lines.push(`  differing sample: ${rowDiff.differingRows.map((item) => item.primaryKey).join(', ')}`);
      }
    });
  }

  const orphanRows = report.orphanChecks.filter((item) => item.orphanCount > 0);
  if (orphanRows.length === 0) {
    lines.push('Foreign key orphan check: clean');
  } else {
    lines.push('Foreign key orphan mismatches:');
    orphanRows.forEach((row) => {
      lines.push(`- ${row.constraintName}: ${row.table} -> ${row.referencedTable}, orphanCount=${row.orphanCount}`);
    });
  }

  return lines.join('\n');
};

const closePools = async (...pools) => {
  await Promise.all(
    pools
      .filter(Boolean)
      .map((pool) => {
        if (typeof pool.end === 'function') {
          return pool.end();
        }
        return Promise.resolve();
      })
  );
};

module.exports = {
  bootstrapPostgresFromMySql,
  buildRuntimeConfig,
  closePools,
  createMySqlPool,
  createPgPool,
  formatVerificationSummary,
  parseArgs,
  verifyParity,
};
