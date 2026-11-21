import MdUtils from './MdUtils.js';

export interface StructuredArticleContent extends Record<string, unknown> {
  type: string;
}

interface MediaRefs {
  imageIds: number[];
  videoIds: number[];
}

export interface ArticleMediaSources {
  imagesById?: Readonly<Partial<Record<number, { url?: string | null }>>>;
  videosById?: Readonly<Partial<Record<number, { url?: string | null; poster?: string | null }>>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveId(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function isStructuredArticleContent(value: unknown): value is StructuredArticleContent {
  return isPlainObject(value) && typeof value.type === 'string';
}

export function normalizeStructuredArticleContent(value: unknown): StructuredArticleContent | null {
  return isStructuredArticleContent(value) ? value : null;
}

export function resolveStructuredArticleContent(contentJson: unknown, draftContent: unknown): StructuredArticleContent | null {
  return normalizeStructuredArticleContent(contentJson) ?? normalizeStructuredArticleContent(draftContent);
}

export function collectMediaRefs(node: unknown, refs: MediaRefs = { imageIds: [], videoIds: [] }): MediaRefs {
  if (!isPlainObject(node)) {
    return refs;
  }

  const attrs = isPlainObject(node.attrs) ? node.attrs : {};
  if (node.type === 'image') {
    const imageId = normalizePositiveId(attrs.imageId ?? attrs.imgId);
    if (imageId && !refs.imageIds.includes(imageId)) {
      refs.imageIds.push(imageId);
    }
  }

  if (node.type === 'video') {
    const videoId = normalizePositiveId(attrs.videoId);
    if (videoId && !refs.videoIds.includes(videoId)) {
      refs.videoIds.push(videoId);
    }
  }

  if (Array.isArray(node.content)) {
    node.content.forEach((child) => collectMediaRefs(child, refs));
  }

  return refs;
}

export function hydrateStructuredContentMediaSources(node: Record<string, unknown>, context?: ArticleMediaSources): Record<string, unknown>;
export function hydrateStructuredContentMediaSources(node: unknown, context?: ArticleMediaSources): unknown;
export function hydrateStructuredContentMediaSources(node: unknown, context: ArticleMediaSources = {}): unknown {
  if (!isPlainObject(node)) {
    return node;
  }

  const nextNode = { ...node };
  const attrs = isPlainObject(node.attrs) ? node.attrs : null;

  if (attrs) {
    const nextAttrs = { ...attrs };

    if (node.type === 'image') {
      const imageId = normalizePositiveId(nextAttrs.imageId ?? nextAttrs.imgId);
      const resolvedImage = imageId ? context.imagesById?.[imageId] : null;
      if (resolvedImage?.url) {
        nextAttrs.imageId = imageId;
        nextAttrs.src = resolvedImage.url;
      }
    }

    if (node.type === 'video') {
      const videoId = normalizePositiveId(nextAttrs.videoId);
      const resolvedVideo = videoId ? context.videosById?.[videoId] : null;
      if (resolvedVideo?.url) {
        nextAttrs.src = resolvedVideo.url;
      }
      if (resolvedVideo?.poster) {
        nextAttrs.poster = resolvedVideo.poster;
      }
    }

    nextNode.attrs = nextAttrs;
  }

  if (Array.isArray(node.content)) {
    nextNode.content = node.content.map((childNode) => hydrateStructuredContentMediaSources(childNode, context));
  }

  return nextNode;
}

function collectTextSegments(node: unknown, segments: string[] = []): string[] {
  if (!isPlainObject(node)) {
    return segments;
  }

  if (node.type === 'text' && typeof node.text === 'string') {
    segments.push(node.text);
    return segments;
  }

  if (node.type === 'hardBreak') {
    segments.push(' ');
    return segments;
  }

  if (Array.isArray(node.content)) {
    node.content.forEach((child) => collectTextSegments(child, segments));
  }

  if (typeof node.type === 'string' && ['paragraph', 'heading', 'blockquote', 'listItem', 'bulletList', 'orderedList', 'codeBlock'].includes(node.type)) {
    segments.push(' ');
  }

  return segments;
}

export function docToExcerpt(doc: unknown, maxLength = 160): string {
  const text = collectTextSegments(doc, [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function buildMarkWrappedHtml(text: string, marks: readonly unknown[] = []): string {
  return marks.reduce<string>((current, mark) => {
    if (!isPlainObject(mark)) return current;
    const attrs = isPlainObject(mark.attrs) ? mark.attrs : {};

    switch (mark.type) {
      case 'bold':
        return `<strong>${current}</strong>`;
      case 'italic':
        return `<em>${current}</em>`;
      case 'strike':
        return `<s>${current}</s>`;
      case 'underline':
        return `<u>${current}</u>`;
      case 'code':
        return `<code>${current}</code>`;
      case 'link': {
        const href = typeof attrs.href === 'string' ? attrs.href.trim() : '';
        if (!href) return current;
        return `<a href="${escapeHtmlAttribute(href)}" target="_blank" rel="noopener noreferrer">${current}</a>`;
      }
      default:
        return current;
    }
  }, text);
}

function renderChildren(content: unknown, context: ArticleMediaSources): string {
  if (!Array.isArray(content) || !content.length) {
    return '';
  }

  return content.map((child) => renderNode(child, context)).join('');
}

function trimMediaAttribute(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function renderImageNode(attrs: Record<string, unknown> = {}, context: ArticleMediaSources = {}): string {
  const imageId = normalizePositiveId(attrs.imageId ?? attrs.imgId);
  const resolvedImage = imageId ? context.imagesById?.[imageId] : null;
  const src = trimMediaAttribute(resolvedImage?.url || attrs.src || '');
  if (!src) return '';

  const attributes = [
    imageId ? `data-image-id="${escapeHtmlAttribute(String(imageId))}"` : '',
    `src="${escapeHtmlAttribute(src)}"`,
    typeof attrs.alt === 'string' ? `alt="${escapeHtmlAttribute(attrs.alt)}"` : '',
    typeof attrs.title === 'string' ? `title="${escapeHtmlAttribute(attrs.title)}"` : '',
  ].filter(Boolean);

  return `<img ${attributes.join(' ')}>`;
}

function renderVideoNode(attrs: Record<string, unknown> = {}, context: ArticleMediaSources = {}): string {
  const videoId = normalizePositiveId(attrs.videoId);
  const resolvedVideo = videoId ? context.videosById?.[videoId] : null;
  const src = trimMediaAttribute(resolvedVideo?.url || attrs.src || '');
  if (!src) return '';

  const poster = trimMediaAttribute(resolvedVideo?.poster || attrs.poster || '');
  const style = typeof attrs.style === 'string' && attrs.style.trim() ? attrs.style.trim() : '';
  const controls = attrs.controls !== false;
  const attributes = [
    videoId ? `data-video-id="${escapeHtmlAttribute(String(videoId))}"` : '',
    `src="${escapeHtmlAttribute(src)}"`,
    poster ? `poster="${escapeHtmlAttribute(poster)}"` : '',
    controls ? 'controls' : '',
    style ? `style="${escapeHtmlAttribute(style)}"` : '',
  ].filter(Boolean);

  return `<video ${attributes.join(' ')}></video>`;
}

function renderCodeBlock(node: Record<string, unknown>): string {
  const attrs = isPlainObject(node.attrs) ? node.attrs : {};
  const language = typeof attrs.language === 'string' && attrs.language.trim() ? attrs.language.trim() : '';
  const code = collectTextSegments(node, []).join('');
  const languageClass = language ? ` class="language-${escapeHtmlAttribute(language)}"` : '';
  return `<pre><code${languageClass}>${escapeHtml(code)}</code></pre>`;
}

function renderNode(node: unknown, context: ArticleMediaSources = {}): string {
  if (!isPlainObject(node)) return '';

  const attrs = isPlainObject(node.attrs) ? node.attrs : {};
  const children = renderChildren(node.content, context);

  switch (node.type) {
    case 'doc':
      return children;
    case 'paragraph':
      return `<p>${children}</p>`;
    case 'heading': {
      const level = typeof attrs.level === 'number' && Number.isInteger(attrs.level) && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 2;
      return `<h${level}>${children}</h${level}>`;
    }
    case 'text':
      return buildMarkWrappedHtml(escapeHtml(node.text || ''), Array.isArray(node.marks) ? node.marks : []);
    case 'hardBreak':
      return '<br>';
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList': {
      const start = typeof attrs.start === 'number' && Number.isInteger(attrs.start) && attrs.start > 1 ? ` start="${attrs.start}"` : '';
      return `<ol${start}>${children}</ol>`;
    }
    case 'listItem':
      return `<li>${children}</li>`;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'codeBlock':
      return renderCodeBlock(node);
    case 'image':
      return renderImageNode(attrs, context);
    case 'video':
      return renderVideoNode(attrs, context);
    case 'horizontalRule':
      return '<hr>';
    default:
      return children;
  }
}

export function docToHtml(doc: unknown, context: ArticleMediaSources = {}): string {
  const normalizedDoc = normalizeStructuredArticleContent(doc);
  if (!normalizedDoc) return '';
  return renderNode(normalizedDoc, context);
}

export function legacyContentToHtml(content: unknown): string {
  return typeof content === 'string' ? MdUtils.renderHtml(content) : '';
}

export function legacyContentToExcerpt(content: unknown, maxLength = 160): string {
  const plainText = legacyContentToHtml(content)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plainText) return '';
  return plainText.length > maxLength ? plainText.slice(0, maxLength).trim() : plainText;
}
