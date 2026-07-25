const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

require('module-alias/register');

const { assertPublicHttpUrl, safeRemoteFetch } = require('@/ingest/extraction/safeRemoteFetch');
const { extractArticlePage } = require('@/ingest/extraction/extractArticlePage');

const fixtureHtml = fs.readFileSync(path.resolve(__dirname, '../fixtures/ingest/article-page.html'), 'utf8');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('assertPublicHttpUrl rejects private and loopback destinations', async () => {
  await assert.rejects(
    () =>
      assertPublicHttpUrl('http://internal.example/article', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    /public internet address/i,
  );
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd', { lookup: publicLookup }), /HTTP URL/i);
});

test('safeRemoteFetch validates redirects and enforces a response size limit', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('/start')) {
      return new Response('', {
        status: 302,
        headers: { location: '/final' },
      });
    }
    return new Response('<html><body>ok</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const response = await safeRemoteFetch('https://news.example/start', {
    fetchImpl,
    lookup: publicLookup,
    maxBytes: 100,
  });

  assert.deepEqual(requested, ['https://news.example/start', 'https://news.example/final']);
  assert.equal(response.url, 'https://news.example/final');
  assert.match(response.contentType, /^text\/html/);
  assert.match(response.buffer.toString('utf8'), /body>ok/);

  await assert.rejects(
    () =>
      safeRemoteFetch('https://news.example/final', {
        fetchImpl: async () =>
          new Response('<html><body>too large</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        lookup: publicLookup,
        maxBytes: 8,
      }),
    /maximum size/i,
  );
});

test('extractArticlePage returns readable sections and absolute image candidates', () => {
  const page = extractArticlePage({
    canonicalUrl: 'https://news.example/posts/ai-systems',
    html: fixtureHtml,
  });

  assert.equal(page.title, 'Practical AI Systems in Production');
  assert.equal(page.canonicalUrl, 'https://news.example/posts/ai-systems');
  assert.equal(page.byline, 'Example Research Team');
  assert.equal(page.publishedAt, '2026-07-20T09:30:00.000Z');
  assert.ok(page.textContent.length >= 600);
  assert.ok(page.sections.length >= 4);
  assert.equal(page.images[0].url, 'https://news.example/media/cover.jpg');
  assert.equal(page.images[0].isCover, true);
  assert.ok(page.images.some((image) => image.url === 'https://cdn.example.net/architecture.png'));
  assert.doesNotMatch(page.textContent, /Home Products Pricing Contact/);
});

test('extractArticlePage rejects pages without enough source material', () => {
  assert.throws(
    () =>
      extractArticlePage({
        canonicalUrl: 'https://news.example/short',
        html: '<html><body><article><p>Too short.</p></article></body></html>',
      }),
    /source material is too short/i,
  );
});
