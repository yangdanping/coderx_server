const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('module-alias/register');

const servicePath = path.resolve(__dirname, '../../src/service/oauth.service.js');
const databasePath = path.resolve(__dirname, '../../src/app/database.js');

function loadServiceWithConnection(connectionMock) {
  delete require.cache[servicePath];
  delete require.cache[databasePath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: connectionMock,
  };

  return require(servicePath);
}

test('findUserByGoogleId: pg executes against quoted user table', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 3, name: 'alice', google_id: 'gid-1' }], []];
    },
  });

  const user = await service.findUserByGoogleId('gid-1');

  assert.deepEqual(user, { id: 3, name: 'alice', google_id: 'gid-1' });
  assert.match(calls[0].statement, /SELECT \* FROM "user" WHERE google_id = \?;/i);
  assert.deepEqual(calls[0].params, ['gid-1']);
});

test('findUserByEmail: pg joins against quoted user table alias', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{ id: 4, name: 'alice', profileEmail: 'alice@example.com' }], []];
    },
  });

  const user = await service.findUserByEmail('alice@example.com');

  assert.deepEqual(user, { id: 4, name: 'alice', profileEmail: 'alice@example.com' });
  assert.match(calls[0].statement, /FROM\s+"user"\s+u/i);
  assert.deepEqual(calls[0].params, ['alice@example.com']);
});

test('createOAuthUser: pg transaction requests insertId via RETURNING id and uses it for profile row', async () => {
  const calls = [];
  const originalDateNow = Date.now;
  Date.now = () => 36;

  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (calls.filter((call) => call.type === 'execute').length === 1) {
            return [{ insertId: /RETURNING\s+id/i.test(statement) ? 41 : 0, affectedRows: 1 }, []];
          }
          return [{ affectedRows: 1 }, []];
        },
        async commit() {
          calls.push({ type: 'commit' });
        },
        async rollback() {
          calls.push({ type: 'rollback' });
        },
        release() {
          calls.push({ type: 'release' });
        },
      };
    },
  });

  try {
    const result = await service.createOAuthUser({
      name: 'Alice',
      googleId: 'gid-1',
      email: 'alice@example.com',
      avatarUrl: 'https://example.com/a.png',
    });

    assert.deepEqual(result, {
      id: 41,
      name: 'Alice_10',
      googleId: 'gid-1',
      oauthProvider: 'google',
    });

    const firstExecute = calls.find((call) => call.type === 'execute');
    assert.match(
      firstExecute.statement,
      /INSERT INTO "user" \(name, password, google_id, oauth_provider\) VALUES \(\?, NULL, \?, \?\) RETURNING id;/i
    );
    assert.deepEqual(firstExecute.params, ['Alice_10', 'gid-1', 'google']);

    const secondExecute = calls.filter((call) => call.type === 'execute')[1];
    assert.equal(secondExecute.statement, 'INSERT INTO profile (user_id, email, avatar_url) VALUES (?, ?, ?);');
    assert.deepEqual(secondExecute.params, [41, 'alice@example.com', 'https://example.com/a.png']);
  } finally {
    Date.now = originalDateNow;
  }
});

test('createGitHubOAuthUser: pg transaction requests insertId via RETURNING id and uses it for profile row', async () => {
  const calls = [];
  const originalDateNow = Date.now;
  Date.now = () => 36;

  const service = loadServiceWithConnection({
    dialect: 'pg',
    async getConnection() {
      return {
        async beginTransaction() {
          calls.push({ type: 'beginTransaction' });
        },
        async execute(statement, params) {
          calls.push({ type: 'execute', statement, params });
          if (calls.filter((call) => call.type === 'execute').length === 1) {
            return [{ insertId: /RETURNING\s+id/i.test(statement) ? 52 : 0, affectedRows: 1 }, []];
          }
          return [{ affectedRows: 1 }, []];
        },
        async commit() {
          calls.push({ type: 'commit' });
        },
        async rollback() {
          calls.push({ type: 'rollback' });
        },
        release() {
          calls.push({ type: 'release' });
        },
      };
    },
  });

  try {
    const result = await service.createGitHubOAuthUser({
      name: 'Octocat',
      login: 'octocat',
      githubId: 'hub-1',
      email: 'octo@example.com',
      avatarUrl: 'https://example.com/octo.png',
    });

    assert.deepEqual(result, {
      id: 52,
      name: 'Octocat_10',
      githubId: 'hub-1',
      oauthProvider: 'github',
    });

    const firstExecute = calls.find((call) => call.type === 'execute');
    assert.match(
      firstExecute.statement,
      /INSERT INTO "user" \(name, password, github_id, oauth_provider\) VALUES \(\?, NULL, \?, \?\) RETURNING id;/i
    );
    assert.deepEqual(firstExecute.params, ['Octocat_10', 'hub-1', 'github']);

    const secondExecute = calls.filter((call) => call.type === 'execute')[1];
    assert.equal(secondExecute.statement, 'INSERT INTO profile (user_id, email, avatar_url) VALUES (?, ?, ?);');
    assert.deepEqual(secondExecute.params, [52, 'octo@example.com', 'https://example.com/octo.png']);
  } finally {
    Date.now = originalDateNow;
  }
});
