const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/sql/oauth.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected oauth.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('find-user SQL: quotes reserved user table for google/github lookups and email join', () => {
  const { buildFindUserByEmailSql, buildFindUserByGitHubIdSql, buildFindUserByGoogleIdSql } = loadHelper();

  assert.match(buildFindUserByGoogleIdSql(), /SELECT \* FROM "user" WHERE google_id = \?;/i);

  assert.match(buildFindUserByGitHubIdSql(), /SELECT \* FROM "user" WHERE github_id = \?;/i);

  const sql = buildFindUserByEmailSql();
  assert.match(sql, /FROM\s+"user"\s+u/i);
  assert.match(sql, /LEFT JOIN profile p ON u\.id = p\.user_id/i);
  assert.match(sql, /WHERE p\.email = \?/i);
});

test('buildCreateOAuthUserSql: quotes user table and appends RETURNING id for both providers', () => {
  const { buildCreateOAuthUserSql } = loadHelper();

  assert.match(
    buildCreateOAuthUserSql('google'),
    /INSERT INTO "user" \(name, password, google_id, oauth_provider\) VALUES \(\?, NULL, \?, \?\) RETURNING id;/i
  );
  assert.match(
    buildCreateOAuthUserSql('github'),
    /INSERT INTO "user" \(name, password, github_id, oauth_provider\) VALUES \(\?, NULL, \?, \?\) RETURNING id;/i
  );
});

test('buildLinkOAuthAccountSql: quotes user table for provider link updates', () => {
  const { buildLinkOAuthAccountSql } = loadHelper();

  assert.match(
    buildLinkOAuthAccountSql('google'),
    /UPDATE "user" SET google_id = \?, oauth_provider = \? WHERE id = \?;/i
  );
  assert.match(
    buildLinkOAuthAccountSql('github'),
    /UPDATE "user" SET github_id = \?, oauth_provider = \? WHERE id = \?;/i
  );
});
