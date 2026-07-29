const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const articleRouter = require('@/router/article.router');

test('article media routes are registered before the dynamic article route', () => {
  const getRoutePaths = articleRouter.stack
    .filter((layer) => layer.methods.includes('GET'))
    .map((layer) => layer.path);

  const articleDetailIndex = getRoutePaths.indexOf('/article/:articleId');

  assert.ok(articleDetailIndex >= 0);
  assert.ok(getRoutePaths.indexOf('/article/images/:filename') < articleDetailIndex);
  assert.ok(getRoutePaths.indexOf('/article/video/:filename') < articleDetailIndex);
});
