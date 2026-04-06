const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '../../src/service/oauth.sql.js');

const loadHelper = () => {
  assert.equal(fs.existsSync(helperPath), true, 'Expected oauth.sql helper module to exist');
  delete require.cache[helperPath];
  return require(helperPath);
};

test('find-user SQL: pg quotes reserved user table for google/github lookups and email join', () => {
  const { buildFindUserByEmailSql, buildFindUserByGitHubIdSql, buildFindUserByGoogleIdSql } = loadHelper();

  assert.match(buildFindUserByGoogleIdSql('pg'), /SELECT \* FROM "user" WHERE google_id = \?;/i);
  assert.equal(buildFindUserByGoogleIdSql('mysql'), 'SELECT * FROM user WHERE google_id = ?;');

  assert.match(buildFindUserByGitHubIdSql('pg'), /SELECT \* FROM "user" WHERE github_id = \?;/i);
  assert.equal(buildFindUserByGitHubIdSql('mysql'), 'SELECT * FROM user WHERE github_id = ?;');

  const pgEmailSql = buildFindUserByEmailSql('pg');
  assert.match(pgEmailSql, /FROM\s+"user"\s+u/i);
  assert.match(pgEmailSql, /LEFT JOIN profile p ON u\.id = p\.user_id/i);
  assert.match(pgEmailSql, /WHERE p\.email = \?/i);
});

test('buildCreateOAuthUserSql: pg quotes user table and appends RETURNING id for both providers', () => {
  const { buildCreateOAuthUserSql } = loadHelper();

  assert.match(
    buildCreateOAuthUserSql('pg', 'google'),
    /INSERT INTO "user" \(name, password, google_id, oauth_provider\) VALUES \(\?, NULL, \?, \?\) RETURNING id;/i
  );
  assert.match(
    buildCreateOAuthUserSql('pg', 'github'),
    /INSERT INTO "user" \(name, password, github_id, oauth_provider\) VALUES \(\?, NULL, \?, \?\) RETURNING id;/i
  );
  assert.equal(
    buildCreateOAuthUserSql('mysql', 'google'),
    'INSERT INTO user (name, password, google_id, oauth_provider) VALUES (?, NULL, ?, ?);'
  );
});

test('buildLinkOAuthAccountSql: pg quotes user table for provider link updates', () => {
  const { buildLinkOAuthAccountSql } = loadHelper();

  assert.match(
    buildLinkOAuthAccountSql('pg', 'google'),
    /UPDATE "user" SET google_id = \?, oauth_provider = \? WHERE id = \?;/i
  );
  assert.match(
    buildLinkOAuthAccountSql('pg', 'github'),
    /UPDATE "user" SET github_id = \?, oauth_provider = \? WHERE id = \?;/i
  );
  assert.equal(buildLinkOAuthAccountSql('mysql', 'github'), 'UPDATE user SET github_id = ?, oauth_provider = ? WHERE id = ?;');
});
