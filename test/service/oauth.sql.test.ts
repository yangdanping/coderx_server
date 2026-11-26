import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateOAuthUserSql,
  buildFindUserByEmailSql,
  buildFindUserByGitHubIdSql,
  buildFindUserByGoogleIdSql,
  buildLinkOAuthAccountSql,
} from '../../src/service/sql/oauth.sql.js';

test('find-user SQL: quotes reserved user table for google/github lookups and email join', () => {
  assert.match(buildFindUserByGoogleIdSql(), /SELECT \* FROM "user" WHERE google_id = \?;/i);

  assert.match(buildFindUserByGitHubIdSql(), /SELECT \* FROM "user" WHERE github_id = \?;/i);

  const sql = buildFindUserByEmailSql();
  assert.match(sql, /FROM\s+"user"\s+u/i);
  assert.match(sql, /LEFT JOIN profile p ON u\.id = p\.user_id/i);
  assert.match(sql, /WHERE p\.email = \?/i);
});

test('buildCreateOAuthUserSql: quotes user table and appends RETURNING id for both providers', () => {
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
  assert.match(
    buildLinkOAuthAccountSql('google'),
    /UPDATE "user" SET google_id = \?, oauth_provider = \? WHERE id = \?;/i
  );
  assert.match(
    buildLinkOAuthAccountSql('github'),
    /UPDATE "user" SET github_id = \?, oauth_provider = \? WHERE id = \?;/i
  );
});
