const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('module-alias/register');

const urlsPath = path.resolve(__dirname, '../../src/constants/urls.js');
const configPath = path.resolve(__dirname, '../../src/app/config.js');

function clearModuleCache() {
  delete require.cache[urlsPath];
  delete require.cache[configPath];
}

function loadUrlsWithConfig(config) {
  clearModuleCache();
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: config,
  };
  return require(urlsPath);
}

test('urls: prefers PUBLIC_API_ORIGIN and FRONTEND_URL for public links', (t) => {
  t.after(clearModuleCache);

  const { baseURL, redirectURL } = loadUrlsWithConfig({
    APP_HOST: 'http://18.166.177.129',
    APP_PORT: '8000',
    ASSETS_PORT: '8000',
    OLLAMA_HOST: 'http://100.119.144.76',
    OLLAMA_PORT: '11434',
    PUBLIC_API_ORIGIN: 'https://api.ydp321.asia',
    FRONTEND_URL: 'https://coderx.my',
  });

  assert.equal(baseURL, 'https://api.ydp321.asia');
  assert.equal(redirectURL, 'https://coderx.my');
});

test('urls: falls back to APP_HOST with ports when public origins are absent', (t) => {
  t.after(clearModuleCache);

  const { baseURL, redirectURL } = loadUrlsWithConfig({
    APP_HOST: 'http://127.0.0.1',
    APP_PORT: '8000',
    ASSETS_PORT: '8080',
    OLLAMA_HOST: 'http://127.0.0.1',
    OLLAMA_PORT: '11434',
  });

  assert.equal(baseURL, 'http://127.0.0.1:8000');
  assert.equal(redirectURL, 'http://127.0.0.1:8080');
});
