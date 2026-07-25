const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('module-alias/register');

const { normalizeCanonicalUrl } = require('@/ingest/domain/normalizeUrl');
const { scoreCandidate } = require('@/ingest/domain/scoreCandidate');
const { collectFeed, parseFeed } = require('@/ingest/collectors/rssCollector');
const sources = require('@/ingest/config/sources');

const rss = fs.readFileSync(path.resolve(__dirname, '../fixtures/ingest/rss.xml'), 'utf8');
const atom = fs.readFileSync(path.resolve(__dirname, '../fixtures/ingest/atom.xml'), 'utf8');

const source = {
  sourceKey: 'example',
  name: 'Example',
  feedUrl: 'https://example.com/feed.xml',
  homepageUrl: 'https://example.com',
  feedType: 'rss',
  contentMode: 'summary',
  licenseCode: 'link-only',
  dailyLimit: 2,
  trustScore: 18,
  enabled: true,
};

test('normalizeCanonicalUrl removes tracking, fragments and an empty trailing slash', () => {
  assert.equal(
    normalizeCanonicalUrl('https://Example.com/post/?utm_source=x&id=7#top'),
    'https://example.com/post?id=7',
  );
});

test('normalizeCanonicalUrl sorts meaningful params and rejects non-http protocols', () => {
  assert.equal(
    normalizeCanonicalUrl('https://example.com/post?z=2&fbclid=gone&a=1'),
    'https://example.com/post?a=1&z=2',
  );
  assert.equal(normalizeCanonicalUrl('javascript:alert(1)'), '');
  assert.equal(normalizeCanonicalUrl('not a url'), '');
});

test('parseFeed maps RSS into the stable entry shape', async () => {
  const [entry] = await parseFeed(rss, source);

  assert.deepEqual(entry, {
    externalId: 'post-1',
    url: 'https://example.com/post-1?utm_source=feed',
    title: 'AI release',
    summary: 'Release summary',
    publishedAt: '2026-07-24T01:00:00.000Z',
    author: 'Example',
    raw: {
      id: 'post-1',
      link: 'https://example.com/post-1?utm_source=feed',
    },
  });
});

test('parseFeed maps Atom and alternate links into the stable entry shape', async () => {
  const [entry] = await parseFeed(atom, { ...source, feedType: 'atom' });

  assert.equal(entry.externalId, 'tag:research.example.com,2026:agent-8');
  assert.equal(entry.url, 'https://research.example.com/agent?ref=feed&id=8');
  assert.equal(entry.title, 'New agent research');
  assert.equal(entry.summary, 'Agent research summary');
  assert.equal(entry.publishedAt, '2026-07-23T10:30:00.000Z');
  assert.equal(entry.author, 'Research Team');
});

test('collectFeed sends an explicit user agent and rejects non-success responses', async () => {
  let request;
  const entries = await collectFeed(source, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    },
    timeoutMs: 1000,
  });

  assert.equal(entries.length, 1);
  assert.equal(request.url, source.feedUrl);
  assert.match(request.options.headers['user-agent'], /CoderX/i);
  assert.ok(request.options.signal);

  await assert.rejects(
    () =>
      collectFeed(source, {
        fetchImpl: async () => new Response('unavailable', { status: 503 }),
      }),
    /Example feed request failed with HTTP 503/,
  );
});

test('scoreCandidate rewards recent AI entries and clamps the score', () => {
  const score = scoreCandidate(
    {
      title: 'New LLM agent model improves AI inference',
      summary: 'Machine learning transformer research',
      publishedAt: '2026-07-24T01:00:00.000Z',
    },
    source,
    new Date('2026-07-24T08:00:00.000Z'),
  );

  assert.equal(score, 98);
  assert.equal(
    scoreCandidate(
      {
        title: 'Gardening notes',
        summary: 'Tomatoes and flowers',
        publishedAt: '2026-05-01T01:00:00.000Z',
      },
      { ...source, trustScore: 50 },
      new Date('2026-07-24T08:00:00.000Z'),
    ),
    20,
  );
});

test('source catalog is immutable, public, summary-only and broad enough for daily coverage', () => {
  assert.ok(Object.isFrozen(sources));
  assert.ok(sources.length >= 8);
  assert.equal(new Set(sources.map((item) => item.sourceKey)).size, sources.length);

  for (const item of sources) {
    assert.equal(item.enabled, true);
    assert.equal(item.contentMode, 'summary');
    assert.equal(item.licenseCode, 'link-only');
    assert.match(item.feedUrl, /^https:\/\//);
    assert.ok(item.dailyLimit >= 1 && item.dailyLimit <= 2);
  }
});
