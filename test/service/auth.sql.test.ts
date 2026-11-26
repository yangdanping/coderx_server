import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckStatusSql } from '../../src/service/sql/auth.sql.js';

test('buildCheckStatusSql: uses quoted reserved user table', () => {
  // assert.equal(actual, expected) 用来比较“实际结果”和“期望结果”。
  // 这里重点检查 user 表名是否写成了 "user"：user 是 SQL 里的保留/敏感词，
  // 在 PostgreSQL 中加双引号可以明确表示它是表名，而不是关键字。
  assert.equal(buildCheckStatusSql(), 'SELECT status FROM "user" WHERE id = ?;');
});
