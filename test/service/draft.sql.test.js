const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/draft.sql.js');
const migrationPath = path.resolve(__dirname, '../../docs/10_flow/sql/2026-08-11-draft-type.sql');

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
  assert.equal(fs.existsSync(migrationPath), true, 'Expected draft type migration to exist');
  return fs.readFileSync(migrationPath, 'utf8');
};

test('buildUpsertDraftSql: new article draft uses PG partial unique upsert on active-only index', () => {
  const { buildUpsertDraftSql } = loadHelper();
  const sql = buildUpsertDraftSql({ hasArticleId: false });
  const updateSetClause = extractSqlFragment(sql, /DO UPDATE SET(?<fragment>[\s\S]+?)WHERE draft\.version = \$6/i, 'DO UPDATE SET clause for new draft upsert');

  assert.match(sql, /INSERT INTO draft\s*\(draft_type,\s*user_id,\s*article_id,\s*title,\s*content,\s*meta,\s*version\)/i);
  assert.match(sql, /VALUES\s*\('article',\s*\$1,\s*\$2,\s*\$3,\s*\$4::jsonb,\s*\$5::jsonb,\s*1\)/i);
  assert.match(sql, /ON CONFLICT\s*\(user_id\)\s*WHERE draft_type = 'article' AND article_id IS NULL AND status = 'active'/i);
  assert.match(sql, /version\s*=\s*draft\.version \+ 1/i);
  assert.match(sql, /WHERE draft\.version = \$6/i);
  assert.match(sql, /RETURNING/i);
  assert.match(sql, /article_id AS "articleId"/i);
  assert.match(sql, /draft_type AS "draftType"/i);
  assert.match(updateSetClause, /status = 'active'/i);
  assert.match(updateSetClause, /consumed_at = NULL/i);
  assert.match(updateSetClause, /discarded_at = NULL/i);
  assert.match(updateSetClause, /consumed_article_id = NULL/i);
});

test('buildUpsertDraftSql: existing article draft conflicts only on active rows and resets lifecycle fields', () => {
  const { buildUpsertDraftSql } = loadHelper();
  const sql = buildUpsertDraftSql({ hasArticleId: true });
  const updateSetClause = extractSqlFragment(sql, /DO UPDATE SET(?<fragment>[\s\S]+?)WHERE draft\.version = \$6/i, 'DO UPDATE SET clause for article draft upsert');

  assert.match(sql, /ON CONFLICT\s*\(user_id,\s*article_id\)\s*WHERE draft_type = 'article' AND article_id IS NOT NULL AND status = 'active'/i);
  assert.match(sql, /WHERE draft\.version = \$6/i);
  assert.match(updateSetClause, /status = 'active'/i);
  assert.match(updateSetClause, /consumed_at = NULL/i);
  assert.match(updateSetClause, /discarded_at = NULL/i);
  assert.match(updateSetClause, /consumed_article_id = NULL/i);
});

test('buildUpsertDraftSql: flow draft uses its own active partial unique index', () => {
  const { DRAFT_TYPE, buildUpsertDraftSql } = loadHelper();
  const sql = buildUpsertDraftSql({ hasArticleId: false, draftType: DRAFT_TYPE.FLOW });

  assert.match(sql, /VALUES\s*\('flow',\s*\$1,\s*\$2,\s*\$3,\s*\$4::jsonb,\s*\$5::jsonb,\s*1\)/i);
  assert.match(sql, /ON CONFLICT\s*\(user_id\)\s*WHERE draft_type = 'flow' AND status = 'active'/i);
  assert.doesNotMatch(sql, /article_id IS NULL AND status = 'active'/i);
});

test('buildUpsertDraftSql: rejects article targets for flow drafts', () => {
  const { DRAFT_TYPE, buildUpsertDraftSql } = loadHelper();

  assert.throws(() => buildUpsertDraftSql({ hasArticleId: true, draftType: DRAFT_TYPE.FLOW }), /Flow draft cannot target an article/);
});

test('buildFindDraftSql: new draft lookup scopes to active status and article_id IS NULL', () => {
  const { buildFindDraftSql } = loadHelper();
  const sql = buildFindDraftSql({ hasArticleId: false });

  assert.match(sql, /WHERE user_id = \$1[\s\S]*article_id IS NULL/i);
  assert.match(sql, /draft_type\s*=\s*'article'/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /LIMIT 1/i);
});

test('buildFindDraftSql: article draft lookup scopes by user, article, and active status', () => {
  const { buildFindDraftSql } = loadHelper();
  const sql = buildFindDraftSql({ hasArticleId: true });

  assert.match(sql, /WHERE user_id = \$1 AND article_id = \$2/i);
  assert.match(sql, /draft_type\s*=\s*'article'/i);
  assert.match(sql, /status\s*=\s*'active'/i);
  assert.match(sql, /LIMIT 1/i);
});

test('buildFindDraftSql: flow lookup is active-only and type-scoped', () => {
  const { DRAFT_TYPE, buildFindDraftSql } = loadHelper();
  const sql = buildFindDraftSql({ hasArticleId: false, draftType: DRAFT_TYPE.FLOW });

  assert.match(sql, /WHERE user_id = \$1 AND draft_type = 'flow' AND article_id IS NULL AND status = 'active'/i);
  assert.match(sql, /draft_type AS "draftType"/i);
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

test('buildValidateDraftFilesSql: reads current bindings then locks an owner-filtered union before fresh validation', () => {
  const { buildFindDraftFileIdsSql, buildLockDraftFilesSql, buildValidateDraftFilesSql } = loadHelper();
  const currentSql = buildFindDraftFileIdsSql();
  assert.match(currentSql, /SELECT id FROM file/i);
  assert.match(currentSql, /user_id = \$1/i);
  assert.match(currentSql, /draft_id = \$2/i);
  assert.doesNotMatch(currentSql, /FOR UPDATE/i);

  const lockSql = buildLockDraftFilesSql();
  assert.match(lockSql, /SELECT id FROM file/i);
  assert.match(lockSql, /user_id = \$1/i);
  assert.match(lockSql, /id = ANY\(\$2::bigint\[\]\)/i);
  assert.match(lockSql, /ORDER BY id[\s\S]*FOR UPDATE/i);
  assert.doesNotMatch(lockSql, /flow_post_media/i);

  const sql = buildValidateDraftFilesSql();

  assert.match(sql, /id = ANY\(\$2::bigint\[\]\)/i);
  assert.match(sql, /user_id = \$1/i);
  assert.match(sql, /\(article_id IS NULL OR article_id = \$3\)/i);
  assert.match(sql, /\(draft_id IS NULL OR draft_id = \$4\)/i);
  assert.match(sql, /NOT EXISTS[\s\S]*FROM flow_post_media fm[\s\S]*fm\.file_id = file\.id/i);
  assert.doesNotMatch(sql, /FOR UPDATE/i);
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
  assert.match(sql, /\(article_id IS NULL OR article_id = \$4\)/i);
  assert.match(sql, /\(draft_id IS NULL OR draft_id = \$2\)/i);
  assert.match(sql, /NOT EXISTS[\s\S]*FROM flow_post_media fm[\s\S]*fm\.file_id = file\.id/i);
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
  assert.match(sql, /draft_type\s*=\s*'article'/i);
  assert.match(sql, /RETURNING/i);
  assert.match(sql, /article_id AS "articleId"/i);
});

test('buildDiscardDraftSql: flow discard cannot affect article drafts', () => {
  const { DRAFT_TYPE, buildDiscardDraftSql } = loadHelper();
  const sql = buildDiscardDraftSql(DRAFT_TYPE.FLOW);

  assert.match(sql, /WHERE id = \$1 AND user_id = \$2 AND draft_type = 'flow' AND status = 'active'/i);
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
  assert.match(sql, /draft_type\s*=\s*'article'/i);
  assert.match(sql, /RETURNING/i);
});

test('draft type migration adds discriminator constraints and three type-aware active indexes', () => {
  const migration = loadMigration();

  assert.match(migration, /ADD COLUMN draft_type text NOT NULL DEFAULT 'article'/i);
  assert.match(migration, /CHECK \(draft_type IN \('article', 'flow'\)\)/i);
  assert.match(migration, /draft_type = 'flow'[\s\S]*article_id IS NULL[\s\S]*consumed_article_id IS NULL/i);
  assert.match(migration, /UNIQUE INDEX draft_user_article_uq[\s\S]*draft_type = 'article'[\s\S]*article_id IS NOT NULL[\s\S]*status = 'active'/i);
  assert.match(migration, /UNIQUE INDEX draft_user_new_article_uq[\s\S]*draft_type = 'article'[\s\S]*article_id IS NULL[\s\S]*status = 'active'/i);
  assert.match(migration, /UNIQUE INDEX draft_user_flow_uq[\s\S]*draft_type = 'flow'[\s\S]*status = 'active'/i);
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
