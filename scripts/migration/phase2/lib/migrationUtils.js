const quoteIdentifier = (identifier) => {
  return `"${String(identifier).replace(/"/g, '""')}"`;
};

const STAGE1_CREATE_TABLE_PATTERN = /CREATE TABLE(?: IF NOT EXISTS)?\s+public\.(?:"((?:[^"]|"")*)"|([a-z_][a-z0-9_]*))/gi;

const extractStage1TableNames = (schemaSql) => {
  if (typeof schemaSql !== 'string' || schemaSql.trim() === '') {
    throw new Error('Stage 1 schema SQL must be a non-empty string.');
  }

  const tables = [];
  let match;

  while ((match = STAGE1_CREATE_TABLE_PATTERN.exec(schemaSql)) !== null) {
    const [, quotedIdentifier, unquotedIdentifier] = match;
    tables.push(quotedIdentifier ? quotedIdentifier.replace(/""/g, '"') : unquotedIdentifier);
  }

  if (tables.length === 0) {
    throw new Error('No CREATE TABLE statements were found in the Stage 1 schema SQL.');
  }

  return Array.from(new Set(tables));
};

const findMissingTables = (requiredTables, existingTables) => {
  const existingTableSet = new Set(existingTables);
  return requiredTables.filter((tableName) => !existingTableSet.has(tableName));
};

const stableStringify = (value) => {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (typeof value === 'object') {
    const sortedEntries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const serializedEntries = sortedEntries.map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`);
    return `{${serializedEntries.join(',')}}`;
  }

  return JSON.stringify(value);
};

const buildInsertSql = (tableName, columns, options = {}) => {
  const { overrideIdentity = false } = options;
  const quotedColumns = columns.map((column) => quoteIdentifier(column)).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const overrideClause = overrideIdentity ? ' OVERRIDING SYSTEM VALUE' : '';

  return `INSERT INTO ${quoteIdentifier(tableName)} (${quotedColumns})${overrideClause} VALUES (${placeholders})`;
};

const normalizeBooleanValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 't' || normalized === 'yes') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'f' || normalized === 'no') {
      return false;
    }
  }

  return Boolean(value);
};

const normalizeJsonValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return JSON.parse(value);
  }

  return value;
};

const normalizeRowValues = (row, typeMap) => {
  const normalizedEntries = Object.entries(row).map(([column, value]) => {
    const targetType = typeMap.get(column);

    if (!targetType) {
      return [column, value];
    }

    if (targetType === 'boolean') {
      return [column, normalizeBooleanValue(value)];
    }

    if (targetType === 'json' || targetType === 'jsonb') {
      return [column, normalizeJsonValue(value)];
    }

    return [column, value];
  });

  return Object.fromEntries(normalizedEntries);
};

const buildSetvalSql = (tableName, columnName) => {
  const quotedTable = quoteIdentifier(tableName);
  const quotedColumn = quoteIdentifier(columnName);
  return `SELECT setval(pg_get_serial_sequence('${quotedTable}', '${columnName}'), COALESCE(MAX(${quotedColumn}), 1), COALESCE(MAX(${quotedColumn}), 0) > 0) FROM ${quotedTable};`;
};

const topologicallySortTables = (tables, dependencies) => {
  const adjacency = new Map();
  const inDegree = new Map();

  tables.forEach((table) => {
    adjacency.set(table, new Set());
    inDegree.set(table, 0);
  });

  dependencies.forEach(({ table, dependsOn }) => {
    if (!adjacency.has(table) || !adjacency.has(dependsOn) || table === dependsOn) {
      return;
    }

    if (!adjacency.get(dependsOn).has(table)) {
      adjacency.get(dependsOn).add(table);
      inDegree.set(table, inDegree.get(table) + 1);
    }
  });

  const queue = tables.filter((table) => inDegree.get(table) === 0).sort();
  const ordered = [];

  while (queue.length > 0) {
    const table = queue.shift();
    ordered.push(table);

    Array.from(adjacency.get(table)).sort().forEach((dependentTable) => {
      inDegree.set(dependentTable, inDegree.get(dependentTable) - 1);
      if (inDegree.get(dependentTable) === 0) {
        queue.push(dependentTable);
        queue.sort();
      }
    });
  }

  if (ordered.length === tables.length) {
    return ordered;
  }

  const remainingTables = tables.filter((table) => !ordered.includes(table)).sort();
  return ordered.concat(remainingTables);
};

const normalizeComparableValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return stableStringify(value);
  }

  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return String(value);
};

const normalizeComparableRow = (row) => {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => {
      return [column, normalizeComparableValue(value)];
    })
  );
};

const buildRowCountDiffReport = (mysqlCounts, pgCounts) => {
  const pgCountMap = new Map(pgCounts.map((item) => [item.table, item.rowCount]));

  return mysqlCounts.map(({ table, rowCount }) => {
    const pgRowCount = pgCountMap.get(table);
    return {
      table,
      mysqlRowCount: rowCount,
      pgRowCount,
      isMatched: rowCount === pgRowCount,
      delta: Number(pgRowCount ?? 0) - Number(rowCount ?? 0),
    };
  });
};

module.exports = {
  buildInsertSql,
  buildRowCountDiffReport,
  buildSetvalSql,
  extractStage1TableNames,
  findMissingTables,
  normalizeComparableRow,
  normalizeRowValues,
  quoteIdentifier,
  topologicallySortTables,
};
