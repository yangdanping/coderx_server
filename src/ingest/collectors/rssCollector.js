const { Window } = require('happy-dom');
const { parseStringPromise } = require('xml2js');

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'CoderX-AI-Ingest/1.0 (+https://coderx.my)';

function parseDocument(markup, contentType) {
  const window = new Window({ url: 'https://coderx.my/' });
  try {
    return new window.DOMParser().parseFromString(markup, contentType);
  } finally {
    window.close();
  }
}

function htmlToText(value) {
  if (!value) return '';
  const document = parseDocument(`<body>${value}</body>`, 'text/html');
  return (document?.body?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function readScalar(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return readScalar(value[0]);
  if (value && typeof value === 'object') return readScalar(value._);
  return '';
}

function toIsoDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readAtomLink(entry) {
  const links = toArray(entry.link);
  const preferredLink = links.find((link) => {
    const relation = link?.$?.rel;
    return !relation || relation === 'alternate';
  });
  return preferredLink?.$?.href?.trim() || readScalar(preferredLink);
}

function parseRssItem(item) {
  const url = readScalar(item.link);
  const externalId = readScalar(item.guid || item.id) || url;

  return {
    externalId,
    url,
    title: htmlToText(readScalar(item.title)),
    summary: htmlToText(readScalar(item.description || item['content:encoded'] || item.content)),
    publishedAt: toIsoDate(readScalar(item.pubDate || item.published || item.updated)),
    author: htmlToText(readScalar(item['dc:creator'] || item.creator || item.author)),
    raw: {
      id: externalId,
      link: url,
    },
  };
}

function parseAtomEntry(entry) {
  const url = readAtomLink(entry);
  const externalId = readScalar(entry.id || entry.guid) || url;
  const author = toArray(entry.author)[0];

  return {
    externalId,
    url,
    title: htmlToText(readScalar(entry.title)),
    summary: htmlToText(readScalar(entry.summary || entry.content)),
    publishedAt: toIsoDate(readScalar(entry.published || entry.updated)),
    author: htmlToText(readScalar(author?.name || author)),
    raw: {
      id: externalId,
      link: url,
    },
  };
}

async function parseFeed(xml, source) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error(`${source.name} returned an empty feed`);
  }

  let parsed;
  try {
    parsed = await parseStringPromise(xml, {
      explicitArray: false,
      normalizeTags: false,
      trim: true,
    });
  } catch {
    throw new Error(`${source.name} returned invalid XML`);
  }

  const atomEntries = toArray(parsed?.feed?.entry);
  const rssItems = toArray(parsed?.rss?.channel?.item);
  const entries = atomEntries.length > 0 ? atomEntries.map(parseAtomEntry) : rssItems.map(parseRssItem);

  return entries.filter((entry) => entry.title && entry.url);
}

async function collectFeed(source, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const response = await fetchImpl(source.feedUrl, {
    headers: {
      accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      'user-agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${source.name} feed request failed with HTTP ${response.status}`);
  }

  return await parseFeed(await response.text(), source);
}

module.exports = {
  collectFeed,
  parseFeed,
};
