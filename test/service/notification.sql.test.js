const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(__dirname, '../../migrations/002_create_notifications.sql');
const cooldownMigrationPath = path.resolve(__dirname, '../../migrations/003_update_notifications_cooldown_index.sql');
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
