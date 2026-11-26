import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryService } from '../../src/service/history/history.service.js';

function loadServiceWithConnection(connectionMock) {
  return createHistoryService(connectionMock, 'https://api.example', 'https://app.example');
}

test('addHistory: pg executes ON CONFLICT upsert SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [{ affectedRows: 1 }, []];
    },
  });

  const result = await service.addHistory(9, 12);

  assert.deepEqual(result, { affectedRows: 1 });
  assert.match(calls[0].statement, /ON CONFLICT\s*\(\s*user_id\s*,\s*article_id\s*\)\s*DO UPDATE/i);
  assert.doesNotMatch(calls[0].statement, /ON DUPLICATE KEY UPDATE/i);
  assert.deepEqual(calls[0].params, [9, 12]);
});

test('getUserHistory: pg uses limit-first params and pg-safe author SQL', async () => {
  const calls = [];
  const service = loadServiceWithConnection({
    dialect: 'pg',
    async execute(statement, params) {
      calls.push({ statement, params });
      return [[{
        id: 1,
        articleId: 12,
        title: 'hello',
        excerpt: 'preview',
        author: {
          id: 9,
          avatarUrl: 'http://localhost:8000/user/9/avatar',
        },
      }], []];
    },
  });

  const result = await service.getUserHistory(9, '20', '10');

  assert.deepEqual(result, [{
    id: 1,
    articleId: 12,
    title: 'hello',
    excerpt: 'preview',
    author: {
      id: 9,
      avatarUrl: 'https://api.example/user/9/avatar',
    },
  }]);
  assert.match(calls[0].statement, /jsonb_build_object\s*\(\s*'id',\s*u\.id/i);
  assert.match(calls[0].statement, /a\.excerpt\s+AS\s+"excerpt"/i);
  assert.match(calls[0].statement, /LEFT JOIN\s+"user"\s+u\s+ON\s+a\.user_id\s*=\s*u\.id/i);
  assert.match(calls[0].statement, /LIMIT\s+\?\s+OFFSET\s+\?/i);
  assert.deepEqual(calls[0].params, [9, '10', '20']);
});
