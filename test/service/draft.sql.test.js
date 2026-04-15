const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/draft.sql.js');
const migrationPath = path.resolve(__dirname, '../../docs/sql/2026-04-13-draft-lifecycle-status.sql');

const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim();

const extractSqlFragment = (sql, pattern, label) => {
  const match = sql.match(pattern);
  assert.ok(match, `Expected to extract ${label}`);
  return normalizeSql(match.groups.fragment);
};

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected draft.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

const loadMigration = () => {
  assert.equal(fs.existsSync(migrationPath), true, 'Expected draft lifecycle migration to exist');
  return fs.readFileSync(migrationPath, 'utf8');
};

test('buildUpsertDraftSql: new article draft uses PG partial unique upsert on active-only index', () => {
  const { buildUpsertDraftSql } = loadHelper();
  const sql = buildUpsertDraftSql({ hasArticleId: false });
  const updateSetClause = extractSqlFragment(
    sql,
    /DO UPDATE SET(?<fragment>[\s\S]+?)WHERE draft\.version = \$6/i,
    'DO UPDATE SET clause for new draft upsert'
  );

  assert.match(sql, /INSERT INTO draft\s*\(user_id,\s*article_id,\s*title,\s*content,\s*meta,\s*version\)/i);
  assert.match(sql, /ON CONFLICT\s*\(user_id\)\s*WHERE article_id IS NULL AND status = 'active'/i);
  assert.match(sql, /version\s*=\s*draft\.version \+ 1/i);
  assert.match(sql, /WHERE draft\.version = \$6/i);
  assert.match(sql, /RETURNING/i);
  assert.match(sql, /article_id AS "articleId"/i);
  assert.match(updateSetClause, /status = 'active'/i);
  assert.match(updateSetClause, /consumed_at = NULL/i);
  assert.match(updateSetClause, /discarded_at = NULL/i);
  assert.match(updateSetClause, /consumed_article_id = NULL/i);
});

test('buildUpsertDraftSql: existing article draft conflicts only on active rows and resets lifecycle fields', () => {
  const { buildUpsertDraftSql } = loadHelper();
  const sql = buildUpsertDraftSql({ hasArticleId: true });
  const updateSetClause = extractSqlFragment(
    sql,
    /DO UPDATE SET(?<fragment>[\s\S]+?)WHERE draft\.version = \$6/i,
    'DO UPDATE SET clause for article draft upsert'
  );

  assert.match(sql, /ON CONFLICT\s*\(user_id,\s*article_id\)\s*WHERE article_id IS NOT NULL AND status = 'active'/i);
  assert.match(sql, /WHERE draft\.version = \$6/i);
  assert.match(updateSetClause, /status = 'active'/i);
  assert.match(updateSetClause, /consumed_at = NULL/i);
  assert.match(updateSetClause, /discarded_at = NULL/i);
  assert.match(updateSetClause, /consumed_article_id = NULL/i);
});

test('buildFindDraftSql: new draft lookup scopes to active status and article_id IS NULL', () => {
  const { buildFindDraftSql } = loadHelper();
  const sql = buildFindDraftSql({ hasArticleId: false });

  assert.match(sql, /WHERE user_id = \$1 AND article_id IS NULL/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /LIMIT 1/i);
});

test('buildFindDraftSql: article draft lookup scopes by user, article, and active status', () => {
  const { buildFindDraftSql } = loadHelper();
  const sql = buildFindDraftSql({ hasArticleId: true });

  assert.match(sql, /WHERE user_id = \$1 AND article_id = \$2/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /LIMIT 1/i);
});

test('buildFindDraftForConsumeSql: standalone draft locks by id, user, null article, active, FOR UPDATE', () => {
  const { buildFindDraftForConsumeSql } = loadHelper();
  const sql = buildFindDraftForConsumeSql({ hasArticleId: false });

  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i);
  assert.match(sql, /article_id IS NULL/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.doesNotMatch(sql, /LIMIT 1/i);
});

test('buildFindDraftForConsumeSql: article draft locks by id, user, article_id, active, FOR UPDATE', () => {
  const { buildFindDraftForConsumeSql } = loadHelper();
  const sql = buildFindDraftForConsumeSql({ hasArticleId: true });

  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i);
  assert.match(sql, /article_id = \$3/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /FOR UPDATE/i);
});

test('buildCheckOwnedArticleSql: article ownership check scopes by article and user', () => {
  const { buildCheckOwnedArticleSql } = loadHelper();
  const sql = buildCheckOwnedArticleSql();

  assert.match(sql, /SELECT\s+id\s+FROM article/i);
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i);
  assert.match(sql, /LIMIT 1/i);
});

test('buildValidateDraftFilesSql: validates same-user files and allows current article files during edit drafts', () => {
  const { buildValidateDraftFilesSql } = loadHelper();
  const sql = buildValidateDraftFilesSql();

  assert.match(sql, /id = ANY\(\$2::bigint\[\]\)/i);
  assert.match(sql, /user_id = \$1/i);
  assert.match(sql, /\(article_id IS NULL OR article_id = \$3\)/i);
  assert.match(sql, /\(draft_id IS NULL OR draft_id = \$4\)/i);
});

test('buildClearRemovedDraftFilesSql: clears previous refs not in the latest file set', () => {
  const { buildClearRemovedDraftFilesSql } = loadHelper();
  const sql = buildClearRemovedDraftFilesSql();

  assert.match(sql, /UPDATE file SET draft_id = NULL/i);
  assert.match(sql, /WHERE user_id = \$1/i);
  assert.match(sql, /draft_id = \$2/i);
  assert.match(sql, /NOT \(id = ANY\(\$3::bigint\[\]\)\)/i);
});

test('buildBindDraftFilesSql: binds current draft refs using PG array params', () => {
  const { buildBindDraftFilesSql } = loadHelper();
  const sql = buildBindDraftFilesSql();

  assert.match(sql, /UPDATE file SET draft_id = \$2/i);
  assert.match(sql, /WHERE user_id = \$1/i);
  assert.match(sql, /id = ANY\(\$3::bigint\[\]\)/i);
});

test('buildDiscardDraftSql: soft-discards active draft by id and user and returns row', () => {
  const { buildDiscardDraftSql } = loadHelper();
  const sql = buildDiscardDraftSql();
  const updateSetClause = extractSqlFragment(sql, /SET(?<fragment>[\s\S]+?)WHERE id = \$1 AND user_id = \$2/i, 'discard draft SET clause');

  assert.match(sql, /UPDATE draft/i);
  assert.match(updateSetClause, /status = 'discarded'/i);
  assert.match(updateSetClause, /discarded_at = NOW\(\)/i);
  assert.match(updateSetClause, /consumed_at = NULL/i);
  assert.match(updateSetClause, /consumed_article_id = NULL/i);
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /RETURNING/i);
  assert.match(sql, /article_id AS "articleId"/i);
});

test('buildConsumeDraftSql: marks active draft consumed with article id and timestamps', () => {
  const { buildConsumeDraftSql } = loadHelper();
  const sql = buildConsumeDraftSql();
  const updateSetClause = extractSqlFragment(sql, /SET(?<fragment>[\s\S]+?)WHERE id = \$1 AND user_id = \$2/i, 'consume draft SET clause');

  assert.match(sql, /UPDATE draft/i);
  assert.match(updateSetClause, /status = 'consumed'/i);
  assert.match(updateSetClause, /consumed_at = NOW\(\)/i);
  assert.match(updateSetClause, /consumed_article_id = \$3/i);
  assert.match(updateSetClause, /discarded_at = NULL/i);
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /RETURNING/i);
});

test('buildDeleteExpiredDraftsSql: cleanup applies distinct retention rules per lifecycle status', () => {
  const { buildDeleteExpiredDraftsSql } = loadHelper();
  const sql = buildDeleteExpiredDraftsSql();

  assert.match(sql, /DELETE FROM draft/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /status\s*=\s*'consumed'/i);
  assert.match(sql, /status\s*=\s*'discarded'/i);
  assert.match(sql, /update_at/i);
  assert.match(sql, /consumed_at/i);
  assert.match(sql, /discarded_at/i);
  assert.match(sql, /RETURNING id/i);
});
