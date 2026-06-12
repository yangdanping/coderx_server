const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(__dirname, '../../migrations/002_create_notifications.sql');
const cooldownMigrationPath = path.resolve(__dirname, '../../migrations/003_update_notifications_cooldown_index.sql');
const articleCommentMigrationPath = path.resolve(__dirname, '../../migrations/004_expand_notifications_for_article_comment.sql');
const commentReplyMigrationPath = path.resolve(__dirname, '../../migrations/005_expand_notifications_for_comment_reply.sql');
const commentLikeMigrationPath = path.resolve(__dirname, '../../migrations/006_expand_notifications_for_comment_like.sql');
const helperPath = path.resolve(__dirname, '../../src/service/sql/notification.sql.js');

const compactSql = (sql) => sql.replace(/\s+/g, ' ').trim();

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected notification.sql helper module to exist');
  return require(helperPath);
};

test('notifications migration: defines fact table with pg-native types and constraints', () => {
  assert.equal(fs.existsSync(migrationPath), true, 'Expected notifications migration to exist');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE TABLE\s+IF NOT EXISTS\s+notifications/i);
  assert.match(sql, /id\s+BIGINT\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i);
  assert.match(sql, /recipient_id\s+BIGINT\s+NOT\s+NULL\s+REFERENCES\s+"user"\s*\(\s*id\s*\)/i);
  assert.match(sql, /actor_id\s+BIGINT\s+NOT\s+NULL\s+REFERENCES\s+"user"\s*\(\s*id\s*\)/i);
  assert.match(sql, /type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type\s+IN\s*\(\s*'article_like'\s*\)\s*\)/i);
  assert.match(sql, /target_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*target_type\s+IN\s*\(\s*'article'\s*\)\s*\)/i);
  assert.match(sql, /created_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+clock_timestamp\(\)/i);
  assert.match(sql, /last_occurred_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+clock_timestamp\(\)/i);
  assert.doesNotMatch(sql, /\bserial\b/i);
  assert.doesNotMatch(sql, /\btimestamp\s+without\s+time\s+zone\b/i);
  assert.doesNotMatch(sql, /\bvarchar\s*\(/i);
});

test('notifications migration: has cooldown lookup and access-path indexes', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.doesNotMatch(sql, /notifications_article_like_dedupe_key/i);
  assert.doesNotMatch(sql, /UNIQUE\s*\(\s*recipient_id\s*,\s*actor_id\s*,\s*type\s*,\s*target_type\s*,\s*target_id\s*\)/i);
  assert.match(sql, /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_recipient_id\b[\s\S]*?\(\s*recipient_id\s*\)/i);
  assert.match(sql, /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_actor_id\b[\s\S]*?\(\s*actor_id\s*\)/i);
  assert.match(sql, /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_article_id\b[\s\S]*?\(\s*article_id\s*\)/i);
  assert.match(
    sql,
    /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_article_like_cooldown_lookup\b[\s\S]*?\(\s*recipient_id\s*,\s*actor_id\s*,\s*type\s*,\s*target_type\s*,\s*target_id\s*,\s*created_at\s+DESC\s*\)/i,
  );
  assert.match(
    sql,
    /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_recipient_created_at\b[\s\S]*?\(\s*recipient_id\s*,\s*created_at\s+DESC\s*\)/i,
  );
  assert.match(
    sql,
    /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_unread_by_recipient\b[\s\S]*?\(\s*recipient_id\s*\)\s+WHERE\s+read_at\s+IS\s+NULL/i,
  );
});

test('notifications cooldown migration: repairs databases that already ran the old dedupe migration', () => {
  assert.equal(fs.existsSync(cooldownMigrationPath), true, 'Expected cooldown repair migration to exist');
  const sql = fs.readFileSync(cooldownMigrationPath, 'utf8');

  assert.match(sql, /ALTER TABLE\s+notifications\s+DROP CONSTRAINT\s+IF EXISTS\s+notifications_article_like_dedupe_key/i);
  assert.match(sql, /ALTER COLUMN\s+created_at\s+SET DEFAULT\s+clock_timestamp\(\)/i);
  assert.match(sql, /ALTER COLUMN\s+last_occurred_at\s+SET DEFAULT\s+clock_timestamp\(\)/i);
  assert.match(
    sql,
    /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_article_like_cooldown_lookup\b[\s\S]*?\(\s*recipient_id\s*,\s*actor_id\s*,\s*type\s*,\s*target_type\s*,\s*target_id\s*,\s*created_at\s+DESC\s*\)/i,
  );
});

test('article comment notification migration: expands notification types and adds comment metadata fields', () => {
  assert.equal(fs.existsSync(articleCommentMigrationPath), true, 'Expected article comment notifications migration to exist');
  const sql = fs.readFileSync(articleCommentMigrationPath, 'utf8');

  assert.match(sql, /article_comment/i);
  assert.match(sql, /comment_id\s+BIGINT\s+REFERENCES\s+comment\s*\(\s*id\s*\)\s+ON\s+DELETE\s+SET\s+NULL/i);
  assert.match(sql, /metadata\s+JSONB\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::jsonb/i);
  assert.match(sql, /CREATE INDEX\s+IF NOT EXISTS\s+idx_notifications_comment_id\b[\s\S]*?\(\s*comment_id\s*\)/i);
});

test('comment reply notification migration: expands notification types without adding new columns', () => {
  assert.equal(fs.existsSync(commentReplyMigrationPath), true, 'Expected comment reply notifications migration to exist');
  const sql = fs.readFileSync(commentReplyMigrationPath, 'utf8');

  assert.match(sql, /comment_reply/i);
  assert.match(sql, /CHECK\s*\(\s*type\s+IN\s*\(\s*'article_like'\s*,\s*'article_comment'\s*,\s*'comment_reply'\s*\)\s*\)/i);
  assert.match(sql, /CHECK\s*\(\s*target_type\s+IN\s*\(\s*'article'\s*\)\s*\)/i);
  assert.doesNotMatch(sql, /ADD\s+COLUMN/i);
});

test('comment like notification migration: adds comment targets while preserving existing notification types', () => {
  assert.equal(fs.existsSync(commentLikeMigrationPath), true, 'Expected comment like notifications migration to exist');
  const sql = fs.readFileSync(commentLikeMigrationPath, 'utf8');

  assert.match(
    sql,
    /CHECK\s*\(\s*type\s+IN\s*\(\s*'article_like'\s*,\s*'article_comment'\s*,\s*'comment_reply'\s*,\s*'follow'\s*,\s*'comment_like'\s*\)\s*\)/i,
  );
  assert.match(
    sql,
    /CHECK\s*\(\s*target_type\s+IN\s*\(\s*'article'\s*,\s*'user'\s*,\s*'comment'\s*\)\s*\)/i,
  );
  assert.match(sql, /type\s*=\s*'comment_like'[\s\S]*target_type\s*=\s*'comment'/i);
  assert.match(sql, /target_id\s*=\s*comment_id/i);
  assert.match(sql, /comment_id\s+IS\s+NULL\s+OR\s+target_id\s*=\s*comment_id/i);
});

test('buildCreateArticleLikeNotificationSql: inserts a new notification without permanent dedupe', () => {
  const { buildCreateArticleLikeNotificationSql } = loadHelper();
  const sql = compactSql(buildCreateArticleLikeNotificationSql());

  assert.match(sql, /^INSERT INTO notifications/i);
  assert.match(
    sql,
    /\(\s*recipient_id,\s*actor_id,\s*type,\s*target_type,\s*target_id,\s*article_id,\s*created_at,\s*last_occurred_at\s*\)\s+VALUES\s+\(\?,\s*\?,\s*'article_like',\s*'article',\s*\?,\s*\?,\s*clock_timestamp\(\),\s*clock_timestamp\(\)\)/i,
  );
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /RETURNING\s+id\s*,\s*recipient_id\s+AS\s+"recipientId"\s*,\s*actor_id\s+AS\s+"actorId"/i);
  assert.doesNotMatch(sql, /ON CONFLICT/i);
  assert.doesNotMatch(sql, /DO UPDATE/i);
  assert.doesNotMatch(sql, /DO NOTHING/i);
});

test('buildCreateArticleLikeNotificationParams: maps article id to target and article columns', () => {
  const { buildCreateArticleLikeNotificationParams } = loadHelper();

  assert.deepEqual(
    buildCreateArticleLikeNotificationParams({
      recipientId: 10,
      actorId: 20,
      articleId: 30,
    }),
    [10, 20, 30, 30],
  );
});

test('buildCreateNotificationSql: inserts generic notification payloads including comment and metadata fields', () => {
  const { buildCreateNotificationSql, buildCreateNotificationParams } = loadHelper();
  const sql = compactSql(buildCreateNotificationSql());

  assert.match(sql, /^INSERT INTO notifications/i);
  assert.match(sql, /type,\s*target_type,\s*target_id,\s*article_id,\s*comment_id,\s*metadata/i);
  assert.match(sql, /RETURNING\s+id\s*,\s*recipient_id\s+AS\s+"recipientId"/i);
  assert.match(sql, /comment_id\s+AS\s+"commentId"/i);
  assert.match(sql, /metadata/i);
  assert.deepEqual(
    buildCreateNotificationParams({
      recipientId: 10,
      actorId: 20,
      type: 'article_comment',
      targetType: 'article',
      targetId: 30,
      articleId: 30,
      commentId: 40,
      metadata: { commentExcerpt: 'hello' },
    }),
    [10, 20, 'article_comment', 'article', 30, 30, 40, JSON.stringify({ commentExcerpt: 'hello' })],
  );
  assert.deepEqual(
    buildCreateNotificationParams({
      recipientId: 10,
      actorId: 20,
      type: 'follow',
      targetType: 'user',
      targetId: 10,
      articleId: null,
    }),
    [10, 20, 'follow', 'user', 10, null, null, '{}'],
  );
});

test('buildFindLatestArticleLikeNotificationSql: finds the newest matching notification for cooldown checks', () => {
  const { buildFindLatestArticleLikeNotificationSql } = loadHelper();
  const sql = compactSql(buildFindLatestArticleLikeNotificationSql());

  assert.match(sql, /^SELECT\s+id\s*,\s*created_at\s+AS\s+"createdAt"\s*,\s*read_at\s+AS\s+"readAt"\s+FROM\s+notifications/i);
  assert.match(sql, /recipient_id\s*=\s*\?\s+AND\s+actor_id\s*=\s*\?/i);
  assert.match(sql, /type\s*=\s*'article_like'/i);
  assert.match(sql, /target_type\s*=\s*'article'/i);
  assert.match(sql, /target_id\s*=\s*\?/i);
  assert.match(sql, /ORDER\s+BY\s+created_at\s+DESC\s+LIMIT\s+1/i);
});

test('buildFindLatestArticleLikeNotificationParams: uses the cooldown lookup key', () => {
  const { buildFindLatestArticleLikeNotificationParams } = loadHelper();

  assert.deepEqual(
    buildFindLatestArticleLikeNotificationParams({
      recipientId: 10,
      actorId: 20,
      articleId: 30,
    }),
    [10, 20, 30],
  );
});

test('buildGetNotificationByIdSql: hydrates actor and article display fields', () => {
  const { buildGetNotificationByIdSql } = loadHelper();
  const sql = compactSql(buildGetNotificationByIdSql());

  assert.match(sql, /LEFT JOIN\s+"user"\s+actor\s+ON\s+actor\.id\s*=\s*n\.actor_id/i);
  assert.match(sql, /LEFT JOIN\s+profile\s+actor_profile\s+ON\s+actor_profile\.user_id\s*=\s*actor\.id/i);
  assert.match(sql, /LEFT JOIN\s+article\s+a\s+ON\s+a\.id\s*=\s*n\.article_id/i);
  assert.match(sql, /jsonb_build_object\(\s*'id',\s*actor\.id,\s*'name',\s*actor\.name,\s*'avatarUrl',\s*actor_profile\.avatar_url\s*\)\s+AS\s+"actor"/i);
  assert.match(sql, /jsonb_build_object\(\s*'id',\s*a\.id,\s*'title',\s*a\.title\s*\)\s+AS\s+"article"/i);
  assert.match(sql, /n\.comment_id\s+AS\s+"commentId"/i);
  assert.match(sql, /n\.metadata/i);
  assert.match(sql, /jsonb_build_object\(\s*'id',\s*c\.id,\s*'content',\s*c\.content\s*\)\s+AS\s+"comment"/i);
  assert.match(sql, /WHERE\s+n\.id\s*=\s*\?/i);
});

test('buildGetNotificationListSql: hydrates actor and article display fields for recipient list', () => {
  const { buildGetNotificationListSql } = loadHelper();
  const sql = compactSql(buildGetNotificationListSql());

  assert.match(sql, /LEFT JOIN\s+"user"\s+actor\s+ON\s+actor\.id\s*=\s*n\.actor_id/i);
  assert.match(sql, /LEFT JOIN\s+profile\s+actor_profile\s+ON\s+actor_profile\.user_id\s*=\s*actor\.id/i);
  assert.match(sql, /LEFT JOIN\s+article\s+a\s+ON\s+a\.id\s*=\s*n\.article_id/i);
  assert.match(sql, /jsonb_build_object\(\s*'id',\s*actor\.id,\s*'name',\s*actor\.name,\s*'avatarUrl',\s*actor_profile\.avatar_url\s*\)\s+AS\s+"actor"/i);
  assert.match(sql, /jsonb_build_object\(\s*'id',\s*a\.id,\s*'title',\s*a\.title\s*\)\s+AS\s+"article"/i);
  assert.match(sql, /LEFT JOIN\s+comment\s+c\s+ON\s+c\.id\s*=\s*n\.comment_id/i);
  assert.match(sql, /n\.comment_id\s+AS\s+"commentId"/i);
  assert.match(sql, /WHERE\s+n\.recipient_id\s*=\s*\?/i);
});
