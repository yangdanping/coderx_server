import { Readability } from '@mozilla/readability';
import { Window } from 'happy-dom';
import type { ArticleSection, ExtractedArticle, ImageCandidate } from '../ingest.types.js';

// Readability uses standard DOM APIs implemented by Happy DOM; its declarations use the browser-only Document type.
type HappyDocument = Window['document'];
const DomReadability = Readability as new (document: Document | HappyDocument, options?: ConstructorParameters<typeof Readability>[1]) => Readability;

const MIN_SOURCE_CHARACTERS = 600;
const MIN_PARAGRAPHS = 4;

function prepareHtmlForReadability(html: unknown) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
}

function normalizedText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveHttpUrl(value: string | null | undefined, baseUrl: string) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstMetaContent(document: HappyDocument, selectors: readonly string[]) {
  for (const selector of selectors) {
    const value = normalizedText(document.querySelector(selector)?.getAttribute('content'));
    if (value) return value;
  }
  return '';
}

function structuredByline(document: HappyDocument) {
  const names = [];
  const seen = new Set();
  for (const node of document.querySelectorAll('[property="author"][typeof="Person"] [property="name"]')) {
    const name = normalizedText(node.textContent);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(', ');
}

function readPublishedAt(document: HappyDocument) {
  const raw =
    firstMetaContent(document, ['meta[property="article:published_time"]', 'meta[name="date"]', 'meta[name="pubdate"]']) ||
    normalizedText(document.querySelector('time[datetime]')?.getAttribute('datetime'));
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractSections(contentHtml: string, baseUrl: string, fallbackHeading: string) {
  const window = new Window({ url: baseUrl });
  window.document.body.innerHTML = contentHtml;
  const sections = [];
  const paragraphs = [];
  const seen = new Set();
  let current: ArticleSection = { heading: fallbackHeading, paragraphs: [] };

  for (const node of window.document.querySelectorAll('h1,h2,h3,p')) {
    const text = normalizedText(node.textContent);
    if (!text) continue;
    if (/^H[123]$/.test(node.tagName)) {
      if (current.paragraphs.length > 0) sections.push(current);
      current = { heading: text, paragraphs: [] };
      continue;
    }
    if (text.length < 30 || seen.has(text)) continue;
    seen.add(text);
    paragraphs.push(text);
    current.paragraphs.push(text);
  }
  if (current.paragraphs.length > 0) sections.push(current);
  window.close();
  return { sections, paragraphs };
}

function extractImages(document: HappyDocument, baseUrl: string) {
  const images: ImageCandidate[] = [];
  const seen = new Set();

  function addImage(rawUrl: string | null | undefined, { alt = '', caption = '', isCover = false }: Omit<ImageCandidate, 'url'> = {}) {
    const url = resolveHttpUrl(rawUrl, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push({
      url,
      alt: normalizedText(alt).slice(0, 180),
      caption: normalizedText(caption).slice(0, 240),
      isCover,
    });
  }

  addImage(firstMetaContent(document, ['meta[property="og:image"]', 'meta[name="twitter:image"]']), {
    alt: firstMetaContent(document, ['meta[property="og:image:alt"]', 'meta[name="twitter:image:alt"]']),
    isCover: true,
  });

  for (const image of document.querySelectorAll('article img, main img')) {
    const figure = image.closest('figure');
    addImage(image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-lazy-src'), {
      alt: image.getAttribute('alt'),
      caption: figure?.querySelector('figcaption')?.textContent,
    });
  }
  return images;
}

function extractArticlePage({ canonicalUrl, html }: { canonicalUrl: string; html: string }): ExtractedArticle {
  const pageUrl = resolveHttpUrl(canonicalUrl, canonicalUrl);
  if (!pageUrl) throw new Error('canonicalUrl must be an HTTP URL');
  const window = new Window({ url: pageUrl });
  window.document.write(prepareHtmlForReadability(html));

  const declaredCanonical = resolveHttpUrl(window.document.querySelector('link[rel="canonical"]')?.getAttribute('href'), pageUrl);
  const finalCanonical = declaredCanonical || pageUrl;
  const images = extractImages(window.document, finalCanonical);
  const metadataByline = firstMetaContent(window.document, ['meta[name="author"]', 'meta[property="article:author"]']);
  const sourceByline = structuredByline(window.document) || metadataByline;
  const publishedAt = readPublishedAt(window.document);
  const parsed = new DomReadability(window.document.cloneNode(true), {
    charThreshold: MIN_SOURCE_CHARACTERS,
  }).parse();

  if (!parsed?.content) {
    window.close();
    throw new Error('Source material is too short for article extraction');
  }

  const title = normalizedText(parsed.title || firstMetaContent(window.document, ['meta[property="og:title"]']) || window.document.title);
  const { sections, paragraphs } = extractSections(parsed.content, finalCanonical, title);
  const textContent = paragraphs.join('\n\n');
  const byline = normalizedText(sourceByline || parsed.byline) || null;
  window.close();

  if (textContent.length < MIN_SOURCE_CHARACTERS || paragraphs.length < MIN_PARAGRAPHS) {
    throw new Error('Source material is too short for article extraction');
  }

  return {
    title,
    canonicalUrl: finalCanonical,
    byline,
    publishedAt,
    textContent,
    sections,
    images,
  };
}

export { extractArticlePage, prepareHtmlForReadability };
