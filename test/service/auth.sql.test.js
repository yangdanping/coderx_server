const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 这个文件名以 .test.js 结尾，是为了让 package.json 里的 `node --test`
// 能自动找到它并当作测试文件执行。它不会启动真实服务器，也不会连接数据库；
// 这里只测试“生成 SQL 字符串的函数”是否输出了预期内容。
const helperPath = path.resolve(__dirname, '../../src/service/sql/auth.sql.js');

const loadHelper = () => {
  // 先确认被测试的 SQL helper 文件真的存在。不存在时，assert 会让测试失败，
  // 并显示后面的错误说明，方便定位是路径或文件缺失问题。
  assert.equal(fs.existsSync(helperPath), true, 'Expected auth.sql helper module to exist');

  // Node 的 require 会缓存模块。删除缓存后再 require，可以确保每次测试都重新加载
  // 最新的 auth.sql.js，避免测试过程中拿到旧版本代码。
  delete require.cache[helperPath];
  return require(helperPath);
};

// node:test 提供 test(name, fn)：注册一个测试用例。
// 执行 `pnpm test` / `npm test` 时，Node 会运行这里的 fn；
// fn 里只要有一个 assert 失败，这个测试用例就会被标记为失败。
test('buildCheckStatusSql: uses quoted reserved user table', () => {
  const { buildCheckStatusSql } = loadHelper();

  // assert.equal(actual, expected) 用来比较“实际结果”和“期望结果”。
  // 这里重点检查 user 表名是否写成了 "user"：user 是 SQL 里的保留/敏感词，
  // 在 PostgreSQL 中加双引号可以明确表示它是表名，而不是关键字。
  assert.equal(buildCheckStatusSql(), 'SELECT status FROM "user" WHERE id = ?;');
});
