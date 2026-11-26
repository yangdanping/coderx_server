const REQUIRED_HEADINGS = new Set(['摘要', '为什么值得阅读', '来源']);

function nodes(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function property(node: unknown, key: string): unknown {
  return typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined;
}

function nodeText(node: unknown) {
  return nodes(property(node, 'content'))
    .map((child) => String(property(child, 'text') || ''))
    .join('')
    .trim();
}

export function isPlaceholderArticle(content: unknown) {
  if (property(content, 'type') !== 'doc') return false;
  const children = nodes(property(content, 'content'));
  const headings = new Set(
    children
      .filter((node) => property(node, 'type') === 'heading')
      .map(nodeText)
      .filter((text) => REQUIRED_HEADINGS.has(text)),
  );
  const hasLinkedOriginal = children.some(
    (node) =>
      property(node, 'type') === 'paragraph' &&
      nodes(property(node, 'content')).some(
        (child) => String(property(child, 'text') || '').trim() === '阅读原文 ↗' && nodes(property(child, 'marks')).some((mark) => property(mark, 'type') === 'link'),
      ),
  );
  return headings.size === REQUIRED_HEADINGS.size && hasLinkedOriginal;
}
