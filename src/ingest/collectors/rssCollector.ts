import type { FeedEntry, FeedSource } from '../ingest.types.js';
import { Window } from 'happy-dom';
import { parseStringPromise } from 'xml2js';

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'CoderX-AI-Ingest/1.0 (+https://coderx.my)';

function parseDocument(markup: string) {
  const window = new Window({ url: 'https://coderx.my/' });
  try {
    return new window.DOMParser().parseFromString(markup, 'text/html');
  } finally {
    window.close();
  }
}

function htmlToText(value: string) {
  if (!value) return '';
  const document = parseDocument(`<body>${value}</body>`);
  return (document?.body?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, name) : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readScalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return readScalar(value[0]);
  if (value && typeof value === 'object') return readScalar(field(value, '_'));
  return '';
}

function toIsoDate(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readAtomLink(entry: Record<string, unknown>) {
  const links = toArray(entry.link);
  const preferredLink = links.find((link) => {
    const relation = field(field(link, '$'), 'rel');
    return !relation || relation === 'alternate';
  });
  const href = field(field(preferredLink, '$'), 'href');
  return (typeof href === 'string' ? href.trim() : '') || readScalar(preferredLink);
}

function parseRssItem(rawItem: unknown): FeedEntry {
  const item = record(rawItem);
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

function parseAtomEntry(rawEntry: unknown): FeedEntry {
  const entry = record(rawEntry);
  const url = readAtomLink(entry);
  const externalId = readScalar(entry.id || entry.guid) || url;
  const author = toArray(entry.author)[0];

  return {
    externalId,
    url,
    title: htmlToText(readScalar(entry.title)),
    summary: htmlToText(readScalar(entry.summary || entry.content)),
    publishedAt: toIsoDate(readScalar(entry.published || entry.updated)),
    author: htmlToText(readScalar(field(author, 'name') || author)),
    raw: {
      id: externalId,
      link: url,
    },
  };
}

async function parseFeed(xml: unknown, source: Pick<FeedSource, 'name'>) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error(`${source.name} returned an empty feed`);
  }

  let parsed: unknown;
  try {
    parsed = await parseStringPromise(xml, {
      explicitArray: false,
      normalizeTags: false,
      trim: true,
    });
  } catch {
    throw new Error(`${source.name} returned invalid XML`);
  }

  const atomEntries = toArray(field(field(parsed, 'feed'), 'entry'));
  const rssItems = toArray(field(field(field(parsed, 'rss'), 'channel'), 'item'));
  const entries = atomEntries.length > 0 ? atomEntries.map(parseAtomEntry) : rssItems.map(parseRssItem);

  return entries.filter((entry) => entry.title && entry.url);
}

async function collectFeed(source: Pick<FeedSource, 'feedUrl' | 'name'>, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
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

export { collectFeed, parseFeed };
