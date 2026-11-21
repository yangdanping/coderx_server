import type { ArticleImage, ArticleMark, ArticleSource, ArticleTextNode, ExtractedArticle } from '../ingest.types.js';

function normalizedText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textNode(text: string, marks?: ArticleMark[]): ArticleTextNode {
  const node: ArticleTextNode = { type: 'text', text: normalizedText(text) };
  if (marks) node.marks = marks;
  return node;
}

function paragraph(text: string) {
  return {
    type: 'paragraph',
    content: [textNode(text)],
  };
}

function heading(text: string) {
  return {
    type: 'heading',
    attrs: { level: 2 },
    content: [textNode(text)],
  };
}

function imageNode(image: ArticleImage) {
  return {
    type: 'image',
    attrs: {
      imageId: image.id,
      src: image.src,
      alt: normalizedText(image.alt),
      title: normalizedText(image.caption) || null,
    },
  };
}

function sourceDate(value: ArticleSource['publishedAt']) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function requireHttpUrl(value: string) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source canonicalUrl must be an HTTP URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('source canonicalUrl must be an HTTP URL');
  return url.toString();
}

function normalizedSections(page: Pick<ExtractedArticle, 'sections'>) {
  if (!Array.isArray(page?.sections)) return [];
  return page.sections
    .map((section) => ({
      heading: normalizedText(section?.heading),
      paragraphs: Array.isArray(section?.paragraphs) ? section.paragraphs.map(normalizedText).filter(Boolean) : [],
    }))
    .filter((section) => section.paragraphs.length > 0);
}

function rawArticleExcerpt(page: Pick<ExtractedArticle, 'sections'>, maxLength = 240) {
  const firstParagraph = normalizedSections(page).flatMap((section) => section.paragraphs)[0] || '';
  return Array.from(firstParagraph).slice(0, maxLength).join('');
}

function buildRawArticleContent({ page, source, images }: { page: ExtractedArticle; source: ArticleSource; images: readonly ArticleImage[] }) {
  const sections = normalizedSections(page);
  if (sections.length === 0) throw new Error('source sections are required');
  if (!Array.isArray(images) || images.length === 0) throw new Error('at least one localized image is required');
  const canonicalUrl = requireHttpUrl(source?.canonicalUrl || page?.canonicalUrl);
  const sourceName = normalizedText(source?.name);
  if (!sourceName) throw new Error('source name is required');

  const cover = images.find((image) => image.isCover) || images[0];
  const bodyImages = images.filter((image) => image !== cover).slice(0, 2);
  const pageTitle = normalizedText(page?.title);
  const content = [];
  let coverInserted = false;
  let bodyImageIndex = 0;

  sections.forEach((section, sectionIndex) => {
    if (section.heading && section.heading !== pageTitle) content.push(heading(section.heading));
    for (const sourceParagraph of section.paragraphs) {
      content.push(paragraph(sourceParagraph));
      if (!coverInserted) {
        content.push(imageNode(cover));
        coverInserted = true;
      }
    }
    if (sectionIndex > 0 && bodyImageIndex < bodyImages.length) {
      content.push(imageNode(bodyImages[bodyImageIndex]));
      bodyImageIndex += 1;
    }
  });
  while (bodyImageIndex < bodyImages.length) {
    content.push(imageNode(bodyImages[bodyImageIndex]));
    bodyImageIndex += 1;
  }

  const byline = normalizedText(page?.byline);
  const publishedAt = sourceDate(source?.publishedAt || page?.publishedAt);
  content.push(heading('Source'));
  content.push(paragraph([sourceName, byline, publishedAt].filter(Boolean).join(' · ')));
  content.push({
    type: 'paragraph',
    content: [
      textNode('Read the original article ↗', [
        {
          type: 'link',
          attrs: {
            href: canonicalUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        },
      ]),
    ],
  });

  return {
    type: 'doc',
    content,
  };
}

export { buildRawArticleContent, rawArticleExcerpt };
