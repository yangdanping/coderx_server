function textNode(text, marks) {
  const node = { type: 'text', text: String(text || '').trim() };
  if (marks) node.marks = marks;
  return node;
}

function paragraph(text) {
  return {
    type: 'paragraph',
    content: [textNode(text)],
  };
}

function heading(text) {
  return {
    type: 'heading',
    attrs: { level: 2 },
    content: [textNode(text)],
  };
}

function imageNode(image) {
  return {
    type: 'image',
    attrs: {
      imageId: image.id,
      src: image.src,
      alt: String(image.alt || '').trim(),
      title: String(image.caption || '').trim() || null,
    },
  };
}

function sourceDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function requireHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source canonicalUrl must be an HTTP URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('source canonicalUrl must be an HTTP URL');
  return url.toString();
}

function buildRichArticleContent({ article, source, images }) {
  if (!article?.lead || !article?.conclusion || !Array.isArray(article.sections) || article.sections.length < 3) {
    throw new Error('structured rich article is required');
  }
  if (!Array.isArray(images) || images.length === 0) throw new Error('at least one localized image is required');
  const canonicalUrl = requireHttpUrl(source?.canonicalUrl);
  const sourceName = String(source?.name || '').trim();
  if (!sourceName) throw new Error('source name is required');

  const cover = images.find((image) => image.isCover) || images[0];
  const bodyImages = images.filter((image) => image !== cover).slice(0, 2);
  const content = [paragraph(article.lead), imageNode(cover)];

  article.sections.forEach((section, index) => {
    content.push(heading(section.heading));
    for (const sectionParagraph of section.paragraphs) {
      content.push(paragraph(sectionParagraph));
    }
    if (index < bodyImages.length) content.push(imageNode(bodyImages[index]));
  });
  content.push(paragraph(article.conclusion));

  const publishedAt = sourceDate(source.publishedAt);
  const disclosure = `本文由 CoderX 基于公开来源整理，材料来自 ${sourceName}${publishedAt ? ` 于 ${publishedAt} 发布` : ' 发布'}的内容，不代表原作者全文。`;
  content.push(paragraph(disclosure));
  content.push({
    type: 'paragraph',
    content: [
      textNode('阅读原文 ↗', [
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

module.exports = {
  buildRichArticleContent,
};
