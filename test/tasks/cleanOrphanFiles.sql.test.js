const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/tasks/cleanOrphanFiles.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected cleanOrphanFiles.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('buildFindOrphanFilesSql: uses PG time functions for image cleanup query', () => {
  const { buildFindOrphanFilesSql } = loadHelper();

  const imageSql = buildFindOrphanFilesSql('image', 'DAY');
  assert.match(imageSql, /EXTRACT\(EPOCH FROM \(NOW\(\) - f\.create_at\)\)/i);
  assert.match(imageSql, /NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.doesNotMatch(imageSql, /TIMESTAMPDIFF/i);
  assert.doesNotMatch(imageSql, /DATE_SUB/i);
  assert.match(imageSql, /LEFT JOIN video_meta vm ON f\.filename = vm\.poster/i);
  assert.match(imageSql, /vm\.poster IS NULL/i);
  assert.match(imageSql, /f\.draft_id IS NULL/i);
});

test('buildFindOrphanFilesSql: uses PG time functions for video cleanup query', () => {
  const { buildFindOrphanFilesSql } = loadHelper();

  const sql = buildFindOrphanFilesSql('video', 'SECOND');
  assert.match(sql, /FLOOR\(EXTRACT\(EPOCH FROM \(NOW\(\) - f\.create_at\)\)\)::integer as age_in_units/i);
  assert.match(sql, /NOW\(\) - \(\? \* INTERVAL '1 second'\)/i);
  assert.doesNotMatch(sql, /TIMESTAMPDIFF/i);
  assert.doesNotMatch(sql, /DATE_SUB/i);
});

// 锁定 P1 改造：video 孤儿清理从 video_meta.poster 读真实封面文件名，
// 不再依赖 "<name>-poster.jpg" 命名约定推断。未来任何人把 JOIN 或 SELECT 拆掉，
// 这条用例会立即爆红，防止回退。
test('buildFindOrphanFilesSql(video): joins video_meta and selects vm.poster', () => {
  const { buildFindOrphanFilesSql } = loadHelper();

  const sql = buildFindOrphanFilesSql('video', 'DAY');
  assert.match(sql, /LEFT JOIN video_meta vm ON f\.id = vm\.file_id/i);
  assert.match(sql, /vm\.poster/i);
  assert.match(sql, /f\.article_id IS NULL/i);
  assert.match(sql, /f\.draft_id IS NULL/i);
  assert.match(sql, /f\.file_type\s*=\s*\?/i);
});

test('draft lifecycle cleanup SQL: splits consumed discarded and active retention rules', () => {
  const {
    buildDeleteConsumedDraftsSql,
    buildDeleteDiscardedDraftsSql,
    buildDeleteExpiredActiveDraftsSql,
  } = loadHelper();

  const consumedSql = buildDeleteConsumedDraftsSql();
  const discardedSql = buildDeleteDiscardedDraftsSql();
  const activeSql = buildDeleteExpiredActiveDraftsSql();

  assert.match(consumedSql, /DELETE FROM draft/i);
  assert.match(consumedSql, /status\s*=\s*'consumed'/i);
  assert.match(consumedSql, /consumed_at IS NOT NULL/i);
  assert.match(consumedSql, /consumed_at < NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.match(consumedSql, /RETURNING id/i);

  assert.match(discardedSql, /DELETE FROM draft/i);
  assert.match(discardedSql, /status\s*=\s*'discarded'/i);
  assert.match(discardedSql, /discarded_at IS NOT NULL/i);
  assert.match(discardedSql, /discarded_at < NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.match(discardedSql, /RETURNING id/i);

  assert.match(activeSql, /DELETE FROM draft/i);
  assert.match(activeSql, /status\s*=\s*'active'/i);
  assert.match(activeSql, /update_at < NOW\(\) - \(\? \* INTERVAL '1 day'\)/i);
  assert.match(activeSql, /RETURNING id/i);
});

test('buildDeleteExpiredActiveDraftsSql: only targets stale active drafts instead of lifecycle timestamps', () => {
  const { buildDeleteExpiredActiveDraftsSql } = loadHelper();

  const sql = buildDeleteExpiredActiveDraftsSql();

  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /update_at/i);
  assert.doesNotMatch(sql, /consumed_at/i);
  assert.doesNotMatch(sql, /discarded_at/i);
});
