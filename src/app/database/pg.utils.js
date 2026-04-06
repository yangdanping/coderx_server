const QUESTION_MARK = '?';
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKSLASH = '\\';

const convertQuestionPlaceholders = (sql) => {
  let parameterIndex = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let result = '';

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const previousChar = sql[index - 1];
    const nextChar = sql[index + 1];

    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && nextChar === '-') {
      inLineComment = true;
      result += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      result += char;
      continue;
    }

    if (inLineComment) {
      result += char;
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      result += char;
      if (previousChar === '*' && char === '/') {
        inBlockComment = false;
      }
      continue;
    }

    if (char === SINGLE_QUOTE && previousChar !== BACKSLASH && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += char;
      continue;
    }

    if (char === DOUBLE_QUOTE && previousChar !== BACKSLASH && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
      continue;
    }

    if (char === QUESTION_MARK && !inSingleQuote && !inDoubleQuote) {
      parameterIndex += 1;
      result += `$${parameterIndex}`;
      continue;
    }

    result += char;
  }

  return result;
};

const buildMysqlLikeResult = (result) => {
  const firstRow = result.rows[0] || {};
  const insertId = firstRow.id ?? firstRow.insertId ?? 0;

  return {
    affectedRows: result.rowCount ?? 0,
    changedRows: result.rowCount ?? 0,
    insertId,
    rowCount: result.rowCount ?? 0,
    command: result.command,
  };
};

const adaptPgResult = (result) => {
  if (result.command === 'SELECT') {
    return [result.rows, result.fields];
  }

  if (result.command === 'INSERT' || result.command === 'UPDATE' || result.command === 'DELETE') {
    return [buildMysqlLikeResult(result), result.fields];
  }

  return [result.rows, result.fields];
};

const createPgConnectionAdapter = (client) => {
  const begin = async () => {
    await client.query('BEGIN');
  };

  return {
    async execute(sql, params = []) {
      const result = await client.query(convertQuestionPlaceholders(sql), params);
      return adaptPgResult(result);
    },
    begin,
    beginTransaction: begin,
    async commit() {
      await client.query('COMMIT');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
    release() {
      client.release();
    },
  };
};

module.exports = {
  adaptPgResult,
  convertQuestionPlaceholders,
  createPgConnectionAdapter,
};
