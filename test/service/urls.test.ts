import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUrls } from '../../src/constants/urls.js';

test('urls: prefers PUBLIC_API_ORIGIN and FRONTEND_URL for public links', () => {
  const { baseURL, redirectURL } = buildUrls({
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

test('urls: falls back to APP_HOST with ports when public origins are absent', () => {
  const { baseURL, redirectURL } = buildUrls({
    APP_HOST: 'http://127.0.0.1',
    APP_PORT: '8000',
    ASSETS_PORT: '8080',
    OLLAMA_HOST: 'http://127.0.0.1',
    OLLAMA_PORT: '11434',
  });

  assert.equal(baseURL, 'http://127.0.0.1:8000');
  assert.equal(redirectURL, 'http://127.0.0.1:8080');
});
